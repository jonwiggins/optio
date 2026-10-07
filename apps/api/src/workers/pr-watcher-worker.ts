import { Queue, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, sessionPrs, interactiveSessions, prReviews } from "../db/schema.js";
import type { GitPlatform, RepoIdentifier } from "@optio/shared";
import { parsePrUrl, parseIntEnv } from "@optio/shared";
import { getGitPlatformForRepo } from "../services/git-token-service.js";
import type { GitTokenContext } from "../services/git-token-service.js";
import { updateSessionPr } from "../services/interactive-session-service.js";
import { enqueueReconcile } from "../services/reconcile-queue.js";
import { logger } from "../logger.js";
import { recordAuthEvent } from "../services/auth-failure-detector.js";
import { recordPrWatchCycleDuration } from "../telemetry/metrics.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";

import { getBullMQOptions } from "../services/redis-config.js";

const bullmqOpts = getBullMQOptions();

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

export const prWatcherQueue = new Queue("pr-watcher", { ...bullmqOpts });

export function startPrWatcherWorker() {
  prWatcherQueue.add(
    "check-prs",
    {},
    {
      repeat: {
        every: parseIntEnv("OPTIO_PR_WATCH_INTERVAL", 30000),
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
      // Find all tasks with open PRs. Watch pr_opened tasks + failed tasks
      // that have a PR (CI may recover, auto-merge may become possible).
      // Only watch coding tasks, NOT review subtasks (avoid recursive reviews).
      //
      // The watcher's only job is to refresh the PR fields on the row and
      // wake the reconciler — every transition / side-effect (auto-merge,
      // review launch, resume, completion) is decided in reconcile-repo.ts
      // and applied by reconcile-executor.ts.
      const openPrTasks = await db
        .select()
        .from(tasks)
        .where(
          sql`${tasks.state} IN ('pr_opened', 'failed') AND ${tasks.prUrl} IS NOT NULL AND (${tasks.taskType} = 'coding' OR ${tasks.taskType} IS NULL)`,
        );

      for (const task of openPrTasks) {
        if (!task.prUrl) continue;

        try {
          const parsed = parsePrUrl(task.prUrl);
          if (!parsed) continue;
          const { prNumber } = parsed;

          const platformResult = await getCachedPlatform(task.repoUrl, {
            userId: task.createdBy ?? undefined,
          });
          if (!platformResult) continue;
          const { platform, ri } = platformResult;

          const prData = await platform.getPullRequest(ri, prNumber).catch(() => null);
          if (!prData) continue;

          const checkRuns = await platform.getCIChecks(ri, prData.headSha).catch(() => []);
          const reviewsData = await platform.getReviews(ri, prNumber).catch(() => []);
          const checksStatus = determineCheckStatus(checkRuns);
          const reviewResult = determineReviewStatus(reviewsData);
          const reviewStatus = reviewResult.status;
          let reviewComments = reviewResult.comments;

          // If changes requested, also fetch inline comments for context.
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

          // Conflicts override the raw checks status — once we've recorded
          // conflicts, keep that label until mergeable flips back.
          const effectiveChecksStatus =
            task.prChecksStatus === "conflicts" && prData.mergeable === false
              ? "conflicts"
              : checksStatus;

          // Write all PR fields in one update. The reconciler reads these
          // from the snapshot to decide the next action.
          const updates: Record<string, unknown> = {
            prNumber,
            prState: prData.merged ? "merged" : prData.state,
            prChecksStatus: effectiveChecksStatus,
            prReviewStatus: reviewStatus,
            updatedAt: new Date(),
          };
          if (reviewComments) {
            updates.prReviewComments = reviewComments;
          }
          await db.update(tasks).set(updates).where(eq(tasks.id, task.id));

          await enqueueReconcile(
            { kind: "repo", id: task.id },
            { reason: `pr_watch:${prData.merged ? "merged" : prData.state}` },
          );
        } catch (err: any) {
          logger.warn({ err, taskId: task.id }, "Failed to check PR status");
          if (err?.status === 401 || err?.message?.includes("Bad credentials")) {
            recordAuthEvent("github", err.message ?? "GitHub 401", "pr-watcher").catch(() => {});
          }
        }
      }

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

      // --- PR Review staleness detection ---
      // When a ready review's PR gets new commits, mark stale so the UI
      // can prompt a rereview. The reconciler handles auto-rereview for
      // origin='auto' reviews; this watcher just surfaces the signal.
      try {
        const readyReviews = await db.select().from(prReviews).where(eq(prReviews.state, "ready"));

        for (const review of readyReviews) {
          try {
            const draftParsed = parsePrUrl(review.prUrl);
            if (!draftParsed) continue;

            const draftRepoUrl = `https://${draftParsed.host}/${draftParsed.owner}/${draftParsed.repo}`;
            const draftResult = await getCachedPlatform(draftRepoUrl, { server: true });
            if (!draftResult) continue;
            const { platform: draftPlatform, ri: draftRi } = draftResult;

            const prData = await draftPlatform
              .getPullRequest(draftRi, review.prNumber)
              .catch(() => null);
            if (!prData) continue;

            if (prData.headSha && prData.headSha !== review.headSha) {
              const { markStale } = await import("../services/pr-review-service.js");
              await markStale(review.id);
              logger.info(
                {
                  prReviewId: review.id,
                  oldSha: review.headSha,
                  newSha: prData.headSha,
                },
                "PR review marked stale — PR has new commits",
              );
            }
          } catch (err) {
            logger.warn({ err, prReviewId: review.id }, "Failed to check review staleness");
          }
        }
      } catch (err) {
        logger.warn({ err }, "Failed to run PR review staleness check");
      }

      recordPrWatchCycleDuration((Date.now() - cycleStart) / 1000);
    }),
    { ...bullmqOpts, concurrency: 1 },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "PR watcher failed");
  });

  return worker;
}
