import { Queue, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, taskEvents, sessionPrs, interactiveSessions } from "../db/schema.js";
import { TaskState } from "@optio/shared";
import { retrieveSecret } from "../services/secret-service.js";
import * as taskService from "../services/task-service.js";
import { updateSessionPr } from "../services/interactive-session-service.js";
import { taskQueue } from "./task-worker.js";
import { logger } from "../logger.js";

const connectionOpts = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
  maxRetriesPerRequest: null,
};

/** Determine overall CI check status from GitHub check runs. */
export function determineCheckStatus(
  checkRuns: { status: string; conclusion: string | null }[],
): "none" | "pending" | "passing" | "failing" {
  if (checkRuns.length === 0) return "none";
  const allComplete = checkRuns.every((r) => r.status === "completed");
  const allSuccess = checkRuns.every(
    (r) => r.conclusion === "success" || r.conclusion === "skipped",
  );
  if (!allComplete) return "pending";
  if (allSuccess) return "passing";
  return "failing";
}

/** Determine review status from GitHub PR reviews. */
export function determineReviewStatus(reviews: { state: string; body?: string }[]): {
  status: string;
  comments: string;
} {
  if (reviews.length === 0) return { status: "none", comments: "" };
  const substantive = reviews.filter((r) => r.state !== "COMMENTED" && r.state !== "DISMISSED");
  const latest = substantive[substantive.length - 1];
  if (latest) {
    if (latest.state === "APPROVED") return { status: "approved", comments: "" };
    if (latest.state === "CHANGES_REQUESTED")
      return { status: "changes_requested", comments: latest.body || "" };
  }
  if (reviews.some((r) => r.state === "COMMENTED")) return { status: "pending", comments: "" };
  return { status: "none", comments: "" };
}

/** Determine what action the PR watcher should take for a task. */
export function determinePrAction(opts: {
  prState: string;
  prMerged: boolean;
  mergeable: boolean | null;
  checksStatus: string;
  prevChecksStatus: string | null;
  reviewStatus: string;
  prevReviewStatus: string | null;
  autoMerge: boolean;
  autoResume: boolean;
  reviewEnabled: boolean;
  reviewTrigger: string;
  hasReviewSubtask: boolean;
  blockingSubtasksComplete: boolean;
  taskState: string;
}): { action: string; detail?: string } {
  // PR merged
  if (opts.prMerged) return { action: "complete", detail: "pr_merged" };

  // PR closed without merge — skip if task is already failed
  // (failed→failed is not a valid state transition)
  if (opts.prState === "closed") {
    if (opts.taskState === "failed") return { action: "none" };
    return { action: "fail", detail: "pr_closed" };
  }

  // Failed tasks can be completed/failed via PR events above, but cannot be resumed
  const canResume = opts.taskState !== "failed";

  // Merge conflicts
  if (
    opts.mergeable === false &&
    opts.prState === "open" &&
    opts.prevChecksStatus !== "conflicts"
  ) {
    if (opts.autoResume && canResume) return { action: "resume_conflicts" };
    return { action: "needs_attention", detail: "merge_conflicts" };
  }

  // CI just started failing
  if (
    opts.checksStatus === "failing" &&
    opts.prevChecksStatus !== "failing" &&
    opts.prState === "open"
  ) {
    if (opts.autoResume && canResume) return { action: "resume_ci_failure" };
    return { action: "needs_attention", detail: "ci_failing" };
  }

  // CI just passed — trigger review if configured
  if (
    opts.checksStatus === "passing" &&
    opts.prevChecksStatus !== "passing" &&
    opts.prState === "open" &&
    opts.reviewEnabled &&
    opts.reviewTrigger === "on_ci_pass" &&
    !opts.hasReviewSubtask
  ) {
    return { action: "launch_review" };
  }

  // First PR detection — trigger review on PR open if configured
  if (
    opts.prevChecksStatus === null &&
    opts.prState === "open" &&
    opts.reviewEnabled &&
    opts.reviewTrigger === "on_pr" &&
    !opts.hasReviewSubtask
  ) {
    return { action: "launch_review" };
  }

  // Auto-merge: CI passing + subtasks done + autoMerge enabled
  if (opts.checksStatus === "passing" && opts.prState === "open" && opts.autoMerge) {
    if (opts.blockingSubtasksComplete) return { action: "auto_merge" };
  }

  // Review changes requested (only on new review, not stale status)
  if (opts.reviewStatus === "changes_requested" && opts.prevReviewStatus !== "changes_requested") {
    if (opts.autoResume && canResume) return { action: "resume_review" };
    return { action: "needs_attention", detail: "review_changes_requested" };
  }

  return { action: "none" };
}

export const prWatcherQueue = new Queue("pr-watcher", { connection: connectionOpts });

export function startPrWatcherWorker() {
  prWatcherQueue.add(
    "check-prs",
    {},
    {
      repeat: {
        every: parseInt(process.env.OPTIO_PR_WATCH_INTERVAL ?? "30000", 10),
      },
    },
  );

  const worker = new Worker(
    "pr-watcher",
    async () => {
      // Fetch GitHub token once for both task and session PR watching
      let githubToken: string | null = null;
      try {
        githubToken = await retrieveSecret("GITHUB_TOKEN");
      } catch {
        // No token, can't check PRs
      }

      // --- Task PR watching ---
      // Find all tasks with open PRs
      // Watch pr_opened tasks + failed tasks that have a PR (may need auto-merge after CI fix)
      // Only watch coding tasks, NOT review subtasks (avoid recursive reviews)
      const openPrTasks = await db
        .select()
        .from(tasks)
        .where(
          sql`${tasks.state} IN ('pr_opened', 'failed') AND ${tasks.prUrl} IS NOT NULL AND (${tasks.taskType} = 'coding' OR ${tasks.taskType} IS NULL)`,
        );

      if (openPrTasks.length > 0 && githubToken) {
        const headers = {
          Authorization: `Bearer ${githubToken}`,
          "User-Agent": "Optio",
          Accept: "application/vnd.github.v3+json",
        };

        for (const task of openPrTasks) {
          if (!task.prUrl) continue;

          try {
            // Parse owner/repo/number from PR URL
            const match = task.prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
            if (!match) continue;
            const [, owner, repo, prNumStr] = match;
            const prNumber = parseInt(prNumStr, 10);

            // Fetch PR data
            const prRes = await fetch(
              `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
              { headers },
            );
            if (!prRes.ok) continue;
            const prData = (await prRes.json()) as any;

            // Fetch check runs
            const checksRes = await fetch(
              `https://api.github.com/repos/${owner}/${repo}/commits/${prData.head.sha}/check-runs`,
              { headers },
            );
            const checksData = checksRes.ok
              ? ((await checksRes.json()) as any)
              : { check_runs: [] };

            // Fetch reviews
            const reviewsRes = await fetch(
              `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
              { headers },
            );
            const reviewsData = reviewsRes.ok ? ((await reviewsRes.json()) as any[]) : [];

            // Determine check status
            let checksStatus = "none";
            if (checksData.check_runs?.length > 0) {
              const runs = checksData.check_runs;
              const allComplete = runs.every((r: any) => r.status === "completed");
              const allSuccess = runs.every(
                (r: any) => r.conclusion === "success" || r.conclusion === "skipped",
              );
              if (!allComplete) checksStatus = "pending";
              else if (allSuccess) checksStatus = "passing";
              else checksStatus = "failing";
            }

            // Determine review status
            let reviewStatus = "none";
            let reviewComments = "";
            if (reviewsData.length > 0) {
              // Get the latest non-comment review
              const substantiveReviews = reviewsData.filter(
                (r: any) => r.state !== "COMMENTED" && r.state !== "DISMISSED",
              );
              const latest = substantiveReviews[substantiveReviews.length - 1];
              if (latest) {
                if (latest.state === "APPROVED") reviewStatus = "approved";
                else if (latest.state === "CHANGES_REQUESTED") {
                  reviewStatus = "changes_requested";
                  reviewComments = latest.body || "";
                  // Also fetch review comments (inline)
                  const commentsRes = await fetch(
                    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
                    { headers },
                  );
                  if (commentsRes.ok) {
                    const comments = (await commentsRes.json()) as any[];
                    const recent = comments.slice(-5);
                    if (recent.length > 0) {
                      reviewComments +=
                        "\n\nInline comments:\n" +
                        recent.map((c: any) => `${c.path}:${c.line ?? ""} — ${c.body}`).join("\n");
                    }
                  }
                }
              } else if (reviewsData.some((r: any) => r.state === "COMMENTED")) {
                reviewStatus = "pending";
              }
            }

            // Update task
            const updates: Record<string, unknown> = {
              prNumber,
              prState: prData.merged ? "merged" : prData.state,
              prChecksStatus: checksStatus,
              prReviewStatus: reviewStatus,
              updatedAt: new Date(),
            };
            if (reviewComments) {
              updates.prReviewComments = reviewComments;
            }
            await db.update(tasks).set(updates).where(eq(tasks.id, task.id));

            // --- Decide what action to take ---
            const { getRepoByUrl } = await import("../services/repo-service.js");
            const repoConfig = await getRepoByUrl(task.repoUrl);
            const existingReview = await db
              .select({ id: tasks.id })
              .from(tasks)
              .where(sql`${tasks.parentTaskId} = ${task.id} AND ${tasks.taskType} = 'review'`);
            const { checkBlockingSubtasks } = await import("../services/subtask-service.js");
            const subtaskStatus = await checkBlockingSubtasks(task.id);

            let action = determinePrAction({
              prState: prData.state,
              prMerged: !!prData.merged,
              mergeable: prData.mergeable ?? null,
              checksStatus,
              prevChecksStatus: task.prChecksStatus,
              reviewStatus,
              prevReviewStatus: task.prReviewStatus,
              autoMerge: repoConfig?.autoMerge ?? false,
              autoResume: repoConfig?.autoResume ?? false,
              reviewEnabled: repoConfig?.reviewEnabled ?? false,
              reviewTrigger: repoConfig?.reviewTrigger ?? "manual",
              hasReviewSubtask: existingReview.length > 0,
              blockingSubtasksComplete: subtaskStatus.allComplete,
              taskState: task.state,
            });

            // --- Execute the action ---
            const failedChecks = (checksData.check_runs ?? [])
              .filter((r: any) => r.conclusion === "failure")
              .map((r: any) => r.name)
              .join(", ");

            const resumeAgent = async (trigger: string, prompt: string, jobSuffix: string) => {
              await taskService.transitionTask(
                task.id,
                TaskState.NEEDS_ATTENTION,
                trigger,
                prompt.slice(0, 200),
              );
              await taskService.transitionTask(
                task.id,
                TaskState.QUEUED,
                `auto_resume_${jobSuffix}`,
              );
              await taskQueue.add(
                "process-task",
                {
                  taskId: task.id,
                  resumeSessionId: task.sessionId,
                  resumePrompt: prompt,
                  restartFromBranch: !!task.prUrl,
                },
                { jobId: `${task.id}-${jobSuffix}-${Date.now()}` },
              );
            };

            // Loop prevention: cap auto-resumes to avoid infinite cycles
            const MAX_AUTO_RESUMES = 3;
            if (
              ["resume_conflicts", "resume_ci_failure", "resume_review"].includes(action.action)
            ) {
              const [{ count: resumeCount }] = await db
                .select({ count: sql<number>`count(*)` })
                .from(taskEvents)
                .where(
                  sql`${taskEvents.taskId} = ${task.id} AND ${taskEvents.trigger} LIKE 'auto_resume_%'`,
                );
              if (Number(resumeCount) >= MAX_AUTO_RESUMES) {
                logger.info(
                  { taskId: task.id, resumeCount, action: action.action },
                  "Auto-resume limit reached — escalating to needs_attention",
                );
                action = {
                  action: "needs_attention",
                  detail: `auto_resume_limit (${action.action})`,
                };
              }
            }

            try {
              switch (action.action) {
                case "complete":
                  await taskService.transitionTask(
                    task.id,
                    TaskState.COMPLETED,
                    "pr_merged",
                    task.prUrl,
                  );
                  logger.info({ taskId: task.id }, "Task completed via PR merge");
                  continue;

                case "fail":
                  await taskService.transitionTask(
                    task.id,
                    TaskState.FAILED,
                    "pr_closed",
                    "PR was closed without merging",
                  );
                  continue;

                case "auto_merge": {
                  const mergeRes = await fetch(
                    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
                    {
                      method: "PUT",
                      headers: { ...headers, "Content-Type": "application/json" },
                      body: JSON.stringify({ merge_method: "squash" }),
                    },
                  );
                  if (mergeRes.ok) {
                    await taskService.transitionTask(
                      task.id,
                      TaskState.COMPLETED,
                      "auto_merged",
                      `PR #${prNumber} auto-merged`,
                    );
                    logger.info({ taskId: task.id, prNumber }, "PR auto-merged");
                    continue;
                  }
                  const body = (await mergeRes.json().catch(() => ({}))) as any;
                  logger.warn(
                    { taskId: task.id, status: mergeRes.status, msg: body.message },
                    "Auto-merge failed",
                  );
                  break;
                }

                case "launch_review": {
                  const { launchReview } = await import("../services/review-service.js");
                  await launchReview(task.id);
                  logger.info({ taskId: task.id }, "Auto-launched review agent");
                  break;
                }

                case "resume_conflicts":
                  await db
                    .update(tasks)
                    .set({ prChecksStatus: "conflicts", updatedAt: new Date() })
                    .where(eq(tasks.id, task.id));
                  await resumeAgent(
                    "merge_conflicts",
                    `Your PR has merge conflicts with the base branch. Please:\n1. Run \`git fetch origin && git rebase origin/main\`\n2. Resolve any conflicts\n3. Run the tests to make sure everything still works\n4. Force-push: \`git push --force-with-lease\``,
                    "conflicts",
                  );
                  logger.info({ taskId: task.id }, "Auto-resuming agent to fix merge conflicts");
                  break;

                case "resume_ci_failure":
                  await resumeAgent(
                    "ci_failing",
                    `CI checks are failing on your PR. The following checks failed: ${failedChecks}\n\nPlease investigate the failures, fix the issues, and push the fixes.`,
                    "ci-fix",
                  );
                  logger.info(
                    { taskId: task.id, failedChecks },
                    "Auto-resuming agent to fix CI failures",
                  );
                  break;

                case "resume_review":
                  await resumeAgent(
                    "review_changes_requested",
                    `A reviewer requested changes on the PR. Please address the following feedback:\n\n${reviewComments}`,
                    "review",
                  );
                  logger.info({ taskId: task.id }, "Auto-resuming agent with review feedback");
                  break;

                case "needs_attention":
                  await taskService.transitionTask(
                    task.id,
                    TaskState.NEEDS_ATTENTION,
                    action.detail ?? "unknown",
                    reviewComments || undefined,
                  );
                  break;

                case "none":
                  break;
              }
            } catch (err) {
              logger.warn(
                { err, taskId: task.id, action: action.action },
                "Failed to execute PR action",
              );
            }
          } catch (err) {
            logger.warn({ err, taskId: task.id }, "Failed to check PR status");
          }
        }
      } // end if (openPrTasks.length > 0 && githubToken)

      // --- Session PR watching ---
      // Poll PRs tracked in active sessions to keep CI/review/merge status up to date
      try {
        const activeSessions = await db
          .select({ id: interactiveSessions.id })
          .from(interactiveSessions)
          .where(eq(interactiveSessions.state, "active"));

        if (activeSessions.length > 0) {
          const sessionIds = activeSessions.map((s) => s.id);
          const openSessionPrs = await db
            .select()
            .from(sessionPrs)
            .where(
              sql`${sessionPrs.sessionId} IN ${sessionIds} AND (${sessionPrs.prState} IS NULL OR ${sessionPrs.prState} = 'open')`,
            );

          if (openSessionPrs.length > 0 && githubToken) {
            const sessionHeaders = {
              Authorization: `Bearer ${githubToken}`,
              "User-Agent": "Optio",
              Accept: "application/vnd.github.v3+json",
            };

            for (const spr of openSessionPrs) {
              try {
                const match = spr.prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
                if (!match) continue;
                const [, sprOwner, sprRepo, sprNumStr] = match;
                const sprNumber = parseInt(sprNumStr, 10);

                const sprRes = await fetch(
                  `https://api.github.com/repos/${sprOwner}/${sprRepo}/pulls/${sprNumber}`,
                  { headers: sessionHeaders },
                );
                if (!sprRes.ok) continue;
                const sprData = (await sprRes.json()) as any;

                // Check runs
                const sprChecksRes = await fetch(
                  `https://api.github.com/repos/${sprOwner}/${sprRepo}/commits/${sprData.head.sha}/check-runs`,
                  { headers: sessionHeaders },
                );
                const sprChecksData = sprChecksRes.ok
                  ? ((await sprChecksRes.json()) as any)
                  : { check_runs: [] };

                const sprChecksStatus = determineCheckStatus(sprChecksData.check_runs ?? []);

                // Reviews
                const sprReviewsRes = await fetch(
                  `https://api.github.com/repos/${sprOwner}/${sprRepo}/pulls/${sprNumber}/reviews`,
                  { headers: sessionHeaders },
                );
                const sprReviewsData = sprReviewsRes.ok
                  ? ((await sprReviewsRes.json()) as any[])
                  : [];
                const sprReviewResult = determineReviewStatus(sprReviewsData);

                await updateSessionPr(spr.id, {
                  prState: sprData.merged ? "merged" : sprData.state,
                  prChecksStatus: sprChecksStatus,
                  prReviewStatus: sprReviewResult.status,
                });
              } catch (err) {
                logger.warn({ err, sessionPrId: spr.id }, "Failed to check session PR status");
              }
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, "Failed to run session PR watcher");
      }
    },
    { connection: connectionOpts, concurrency: 1 },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "PR watcher failed");
  });

  return worker;
}
