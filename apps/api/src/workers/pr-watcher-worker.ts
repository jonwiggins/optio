import { Queue, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, taskEvents, sessionPrs, interactiveSessions, reviewDrafts } from "../db/schema.js";
import type { GitPlatform, RepoIdentifier } from "@optio/shared";
import { TaskState, parsePrUrl } from "@optio/shared";
import { getGitPlatformForRepo, getGitToken } from "../services/git-token-service.js";
import type { GitTokenContext } from "../services/git-token-service.js";
import { createGitPlatform } from "../services/git-platform/index.js";
import * as taskService from "../services/task-service.js";
import { updateSessionPr } from "../services/interactive-session-service.js";
import { taskQueue } from "./task-worker.js";
import { logger } from "../logger.js";
import { recordAuthEvent } from "../services/auth-failure-detector.js";
import { recordPrWatchCycleDuration } from "../telemetry/metrics.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";

import { getBullMQConnectionOptions } from "../services/redis-config.js";

const connectionOpts = getBullMQConnectionOptions();

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
  cautiousMode: boolean;
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

  // Auto-merge: CI passing (or no checks) + subtasks done + autoMerge enabled
  const checksOk = opts.checksStatus === "passing" || opts.checksStatus === "none";
  if (checksOk && opts.prState === "open" && opts.autoMerge && !opts.cautiousMode) {
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
    instrumentWorkerProcessor("pr-watcher", async () => {
      const cycleStart = Date.now();
      // Per-cycle cache to avoid redundant token lookups / secret decryption
      const platformCache = new Map<string, { platform: GitPlatform; ri: RepoIdentifier }>();
      async function getCachedPlatform(
        repoUrl: string,
        context: GitTokenContext,
      ): Promise<{ platform: GitPlatform; ri: RepoIdentifier } | null> {
        const key = `${repoUrl}::${context.userId ?? "server"}`;
        const cached = platformCache.get(key);
        if (cached) return cached;
        try {
          const result = await getGitPlatformForRepo(repoUrl, context);
          platformCache.set(key, result);
          return result;
        } catch {
          return null;
        }
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

      if (openPrTasks.length > 0) {
        for (const task of openPrTasks) {
          if (!task.prUrl) continue;

          try {
            // Parse owner/repo/number from PR URL (works for both GitHub and GitLab)
            const parsed = parsePrUrl(task.prUrl);
            if (!parsed) continue;
            const { prNumber } = parsed;
            const prLabel = parsed.platform === "gitlab" ? "MR" : "PR";

            // Get platform instance for this repo (cached per poll cycle)
            const platformResult = await getCachedPlatform(task.repoUrl, {
              userId: task.createdBy ?? undefined,
            });
            if (!platformResult) continue;
            const { platform, ri } = platformResult;

            // Fetch PR data
            const prData = await platform.getPullRequest(ri, prNumber).catch(() => null);
            if (!prData) continue;

            // Fetch check runs
            const checkRuns = await platform.getCIChecks(ri, prData.headSha).catch(() => []);

            // Fetch reviews
            const reviewsData = await platform.getReviews(ri, prNumber).catch(() => []);

            // Determine check status
            const checksStatus = determineCheckStatus(checkRuns);

            // Determine review status
            const reviewResult = determineReviewStatus(reviewsData);
            const reviewStatus = reviewResult.status;
            let reviewComments = reviewResult.comments;

            // If changes requested, also fetch inline comments for context
            if (reviewStatus === "changes_requested") {
              try {
                const inlineComments = await platform.getInlineComments(ri, prNumber);
                const recent = inlineComments.slice(-5);
                if (recent.length > 0) {
                  reviewComments +=
                    "\n\nInline comments:\n" +
                    recent.map((c) => `${c.path}:${c.line ?? ""} — ${c.body}`).join("\n");
                }
              } catch {}
            }

            // Update task status fields (except prChecksStatus — deferred until
            // after the action executes so the transition guard can retry on failure)
            const effectiveChecksStatus =
              task.prChecksStatus === "conflicts" && prData.mergeable === false
                ? "conflicts"
                : checksStatus;
            const updates: Record<string, unknown> = {
              prNumber,
              prState: prData.merged ? "merged" : prData.state,
              prReviewStatus: reviewStatus,
              updatedAt: new Date(),
            };
            if (reviewComments) {
              updates.prReviewComments = reviewComments;
            }
            await db.update(tasks).set(updates).where(eq(tasks.id, task.id));

            // --- Decide what action to take ---
            const { getRepoByUrl } = await import("../services/repo-service.js");
            const repoConfig = await getRepoByUrl(task.repoUrl, task.workspaceId ?? null);
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
              cautiousMode: repoConfig?.cautiousMode ?? false,
              autoResume: repoConfig?.autoResume ?? false,
              reviewEnabled: repoConfig?.reviewEnabled ?? false,
              reviewTrigger: repoConfig?.reviewTrigger ?? "manual",
              hasReviewSubtask: existingReview.length > 0,
              blockingSubtasksComplete: subtaskStatus.allComplete,
              taskState: task.state,
            });

            // --- Execute the action ---
            const failedChecks = checkRuns
              .filter((r) => r.conclusion === "failure")
              .map((r) => r.name)
              .join(", ");

            const resumeAgent = async (
              trigger: string,
              prompt: string,
              jobSuffix: string,
              opts?: { freshSession?: boolean },
            ) => {
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
                  // Fresh session: don't pass resumeSessionId so the agent starts a new
                  // conversation with the resume prompt instead of continuing a finished session
                  resumeSessionId: opts?.freshSession ? undefined : task.sessionId,
                  resumePrompt: prompt,
                  restartFromBranch: !!task.prUrl,
                },
                { jobId: `${task.id}-${jobSuffix}-${Date.now()}` },
              );
            };

            // Loop prevention: cap auto-resumes to avoid infinite cycles
            // Priority: per-repo maxAutoResumes → OPTIO_MAX_AUTO_RESUMES env var → default 10
            const DEFAULT_MAX_AUTO_RESUMES = 10;
            const envMaxAutoResumes = process.env.OPTIO_MAX_AUTO_RESUMES
              ? parseInt(process.env.OPTIO_MAX_AUTO_RESUMES, 10)
              : DEFAULT_MAX_AUTO_RESUMES;
            const maxAutoResumes = repoConfig?.maxAutoResumes ?? envMaxAutoResumes;
            if (
              ["resume_conflicts", "resume_ci_failure", "resume_review"].includes(action.action)
            ) {
              // Count auto-resumes since the last manual action (force_restart,
              // user_resume, etc.) so that a manual restart resets the counter.
              const [{ count: resumeCount }] = await db
                .select({ count: sql<number>`count(*)` })
                .from(taskEvents)
                .where(
                  sql`${taskEvents.taskId} = ${task.id}
                    AND ${taskEvents.trigger} LIKE 'auto_resume_%'
                    AND ${taskEvents.createdAt} > COALESCE(
                      (SELECT MAX(te2.created_at) FROM task_events te2
                       WHERE te2.task_id = ${task.id}
                       AND te2.trigger IN ('force_restart', 'user_resume', 'force_redo', 'user_retry', 'issue_assigned')),
                      '1970-01-01'::timestamptz
                    )`,
                );
              if (Number(resumeCount) >= maxAutoResumes) {
                logger.info(
                  { taskId: task.id, resumeCount, maxAutoResumes, action: action.action },
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
                  await db
                    .update(tasks)
                    .set({ prChecksStatus: effectiveChecksStatus, prState: "merged" })
                    .where(eq(tasks.id, task.id));
                  await taskService.transitionTask(
                    task.id,
                    TaskState.COMPLETED,
                    "pr_merged",
                    task.prUrl,
                  );
                  logger.info({ taskId: task.id }, "Task completed via PR merge");
                  continue;

                case "fail":
                  await db
                    .update(tasks)
                    .set({ prChecksStatus: effectiveChecksStatus, prState: "closed" })
                    .where(eq(tasks.id, task.id));
                  await taskService.transitionTask(
                    task.id,
                    TaskState.FAILED,
                    "pr_closed",
                    `${prLabel} was closed without merging`,
                  );
                  continue;

                case "auto_merge": {
                  try {
                    await platform.mergePullRequest(ri, prNumber, "squash");
                    await db
                      .update(tasks)
                      .set({ prChecksStatus: effectiveChecksStatus, prState: "merged" })
                      .where(eq(tasks.id, task.id));
                    await taskService.transitionTask(
                      task.id,
                      TaskState.COMPLETED,
                      "auto_merged",
                      `${prLabel} ${parsed.platform === "gitlab" ? "!" : "#"}${prNumber} auto-merged`,
                    );
                    logger.info({ taskId: task.id, prNumber }, "PR auto-merged");
                    continue;
                  } catch (mergeErr) {
                    logger.warn({ taskId: task.id, err: mergeErr }, "Auto-merge failed");
                    break;
                  }
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
                    `Your ${prLabel} has merge conflicts with the base branch. Please:\n1. Run \`git fetch origin && git rebase origin/main\`\n2. Resolve any conflicts\n3. Run the tests to make sure everything still works\n4. Force-push: \`git push --force-with-lease\``,
                    "conflicts",
                    { freshSession: true },
                  );
                  logger.info({ taskId: task.id }, "Auto-resuming agent to fix merge conflicts");
                  break;

                case "resume_ci_failure":
                  await resumeAgent(
                    "ci_failing",
                    `CI checks are failing on your ${prLabel}. The following checks failed: ${failedChecks}\n\nPlease investigate the failures, fix the issues, and push the fixes.`,
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
                    `A reviewer requested changes on the ${prLabel}. Please address the following feedback:\n\n${reviewComments}`,
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
              // Action succeeded — now commit prChecksStatus so the transition
              // guard won't re-fire on the next poll.  If the action threw above,
              // we skip this update so the next poll sees the old status and retries.
              await db
                .update(tasks)
                .set({ prChecksStatus: effectiveChecksStatus })
                .where(eq(tasks.id, task.id));
            } catch (err) {
              logger.warn(
                { err, taskId: task.id, action: action.action },
                "Failed to execute PR action — prChecksStatus left unchanged for retry",
              );
            }
          } catch (err: any) {
            logger.warn({ err, taskId: task.id }, "Failed to check PR status");
            if (err?.status === 401 || err?.message?.includes("Bad credentials")) {
              recordAuthEvent("github", err.message ?? "GitHub 401").catch(() => {});
            }
          }
        }
      } // end if (openPrTasks.length > 0)

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

          for (const spr of openSessionPrs) {
            try {
              const sprParsed = parsePrUrl(spr.prUrl);
              if (!sprParsed) continue;

              // Infer repo URL from PR URL for platform resolution
              const sprRepoUrl = `https://${sprParsed.host}/${sprParsed.owner}/${sprParsed.repo}`;
              const sprResult = await getCachedPlatform(sprRepoUrl, { server: true });
              if (!sprResult) continue;
              const { platform: sprPlatform, ri: sprRi } = sprResult;

              const sprData = await sprPlatform
                .getPullRequest(sprRi, sprParsed.prNumber)
                .catch(() => null);
              if (!sprData) continue;

              const sprCheckRuns = await sprPlatform
                .getCIChecks(sprRi, sprData.headSha)
                .catch(() => []);
              const sprChecksStatus = determineCheckStatus(sprCheckRuns);

              const sprReviewsData = await sprPlatform
                .getReviews(sprRi, sprParsed.prNumber)
                .catch(() => []);
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
      } catch (err) {
        logger.warn({ err }, "Failed to run session PR watcher");
      }

      // --- Review draft staleness detection ---
      // Check if any ready review drafts have become stale (new commits pushed to PR)
      try {
        const readyDrafts = await db
          .select()
          .from(reviewDrafts)
          .where(eq(reviewDrafts.state, "ready"));

        for (const draft of readyDrafts) {
          try {
            // Construct repo URL from draft fields for platform resolution
            const draftPrUrl = draft.prUrl;
            const draftParsed = draftPrUrl ? parsePrUrl(draftPrUrl) : null;
            if (!draftParsed) continue;

            const draftRepoUrl = `https://${draftParsed.host}/${draftParsed.owner}/${draftParsed.repo}`;
            const draftResult = await getCachedPlatform(draftRepoUrl, { server: true });
            if (!draftResult) continue;
            const { platform: draftPlatform, ri: draftRi } = draftResult;

            const prData = await draftPlatform
              .getPullRequest(draftRi, draft.prNumber)
              .catch(() => null);
            if (!prData) continue;

            if (prData.headSha && prData.headSha !== draft.headSha) {
              const { markDraftStale } = await import("../services/pr-review-service.js");
              await markDraftStale(draft.id);
              logger.info(
                {
                  draftId: draft.id,
                  taskId: draft.taskId,
                  oldSha: draft.headSha,
                  newSha: prData.headSha,
                },
                "Review draft marked stale — PR has new commits",
              );
            }
          } catch (err) {
            logger.warn({ err, draftId: draft.id }, "Failed to check draft staleness");
          }
        }
      } catch (err) {
        logger.warn({ err }, "Failed to run review draft staleness check");
      }

      // Record cycle duration metric
      recordPrWatchCycleDuration((Date.now() - cycleStart) / 1000);
    }),
    { connection: connectionOpts, concurrency: 1 },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "PR watcher failed");
  });

  return worker;
}
