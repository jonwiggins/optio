import { Queue, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, repos } from "../db/schema.js";
import { TaskState } from "@optio/shared";
import { retrieveSecret } from "../services/secret-service.js";
import * as taskService from "../services/task-service.js";
import { taskQueue } from "./task-worker.js";
import { logger } from "../logger.js";

const connectionOpts = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
  maxRetriesPerRequest: null,
};

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
      // Find all tasks with open PRs
      const openPrTasks = await db.select().from(tasks).where(eq(tasks.state, "pr_opened"));

      if (openPrTasks.length === 0) return;

      let githubToken: string;
      try {
        githubToken = await retrieveSecret("GITHUB_TOKEN");
      } catch {
        return; // No token, can't check PRs
      }

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
          const checksData = checksRes.ok ? ((await checksRes.json()) as any) : { check_runs: [] };

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

          // Trigger review if enabled and CI just passed
          if (
            checksStatus === "passing" &&
            task.prChecksStatus !== "passing" && // State changed to passing
            prData.state === "open"
          ) {
            const [repoConf] = await db.select().from(repos).where(eq(repos.repoUrl, task.repoUrl));

            if (repoConf?.reviewEnabled && repoConf.reviewTrigger === "on_ci_pass") {
              // Check if a review task already exists for this task
              const existingReview = await db
                .select({ id: tasks.id })
                .from(tasks)
                .where(sql`${tasks.parentTaskId} = ${task.id} AND ${tasks.taskType} = 'review'`);

              if (existingReview.length === 0) {
                try {
                  const { launchReview } = await import("../services/review-service.js");
                  await launchReview(task.id);
                  logger.info({ taskId: task.id }, "Auto-launched review agent on CI pass");
                } catch (err) {
                  logger.warn({ err, taskId: task.id }, "Failed to auto-launch review");
                }
              }
            }
          }

          // Also trigger review on PR open if configured
          if (
            task.prChecksStatus === null && // First time seeing this PR
            prData.state === "open"
          ) {
            const [repoConf] = await db.select().from(repos).where(eq(repos.repoUrl, task.repoUrl));

            if (repoConf?.reviewEnabled && repoConf.reviewTrigger === "on_pr") {
              const existingReview = await db
                .select({ id: tasks.id })
                .from(tasks)
                .where(sql`${tasks.parentTaskId} = ${task.id} AND ${tasks.taskType} = 'review'`);

              if (existingReview.length === 0) {
                try {
                  const { launchReview } = await import("../services/review-service.js");
                  await launchReview(task.id);
                  logger.info({ taskId: task.id }, "Auto-launched review agent on PR open");
                } catch (err) {
                  logger.warn({ err, taskId: task.id }, "Failed to auto-launch review");
                }
              }
            }
          }

          // Handle state transitions
          if (prData.merged) {
            // PR merged → complete the task
            try {
              await taskService.transitionTask(
                task.id,
                TaskState.COMPLETED,
                "pr_merged",
                task.prUrl,
              );
              logger.info({ taskId: task.id }, "Task completed via PR merge");
            } catch {
              // May already be completed
            }
          } else if (prData.state === "closed") {
            // PR closed without merge → fail
            try {
              await taskService.transitionTask(
                task.id,
                TaskState.FAILED,
                "pr_closed",
                "PR was closed without merging",
              );
            } catch {}
          } else if (reviewStatus === "changes_requested") {
            // Check if auto-resume is enabled for this repo
            const [repoConfig] = await db
              .select()
              .from(repos)
              .where(eq(repos.repoUrl, task.repoUrl));

            if (repoConfig?.autoResumeOnReview) {
              // Auto-resume with review feedback
              try {
                await taskService.transitionTask(
                  task.id,
                  TaskState.NEEDS_ATTENTION,
                  "review_changes_requested",
                  reviewComments,
                );
                // Re-queue with resume
                await taskService.transitionTask(task.id, TaskState.QUEUED, "auto_resume_review");
                await taskQueue.add(
                  "process-task",
                  {
                    taskId: task.id,
                    resumeSessionId: task.sessionId,
                    resumePrompt: `A reviewer requested changes on the PR. Please address the following feedback:\n\n${reviewComments}`,
                  },
                  { jobId: `${task.id}-review-${Date.now()}` },
                );
                logger.info({ taskId: task.id }, "Auto-resuming agent with review feedback");
              } catch {}
            } else {
              // Just mark as needs attention
              try {
                await taskService.transitionTask(
                  task.id,
                  TaskState.NEEDS_ATTENTION,
                  "review_changes_requested",
                  reviewComments,
                );
              } catch {}
            }
          }
        } catch (err) {
          logger.warn({ err, taskId: task.id }, "Failed to check PR status");
        }
      }
    },
    { connection: connectionOpts, concurrency: 1 },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "PR watcher failed");
  });

  return worker;
}
