/**
 * External PR auto-review poller.
 *
 * Walks all repos with externalReviewMode in {on_pr_hold, on_pr_post},
 * lists open PRs, and ensures each one has an appropriate `pr_reviews`
 * record:
 *
 *   - if no review exists: create one (origin='auto'), optionally parked
 *     in waiting_ci if the repo is configured to wait for CI
 *   - if existing review is stale vs current head_sha: spawn a re-review
 *     (auto) or mark stale (manual/user-engaged)
 *   - if existing review is waiting_ci: promote to reviewing once CI
 *     clears
 *
 * State transitions are driven through the service's launchPrReview so
 * the reconciler and worker pipelines fire uniformly.
 */
import { Queue, Worker } from "bullmq";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { repos, prReviews } from "../db/schema.js";
import { parseIntEnv, PrReviewState, type GitPlatformType } from "@optio/shared";
import { getGitPlatformForRepo } from "../services/git-token-service.js";
import {
  launchPrReview,
  isOptioAuthoredPr,
  preferredReview,
} from "../services/pr-review-service.js";
import { logger } from "../logger.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { scheduleRepeat } from "../services/repeat-jobs.js";
import { underPollerLease } from "../services/poller-lease.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";
import { determineCheckStatus } from "./pr-watcher-worker.js";

const bullmqOpts = getBullMQOptions();

export const externalPrReviewQueue = new Queue("external-pr-review", {
  ...bullmqOpts,
});

type Filters = NonNullable<(typeof repos.$inferSelect)["externalReviewFilters"]>;

function passesFilters(
  pr: { draft: boolean; author: string | null; labels: string[] },
  filters: Filters | null,
): boolean {
  if (!filters) return true;
  if (filters.skipDrafts && pr.draft) return false;

  const author = pr.author ?? "";
  if (filters.includeAuthors && filters.includeAuthors.length > 0) {
    if (!author || !filters.includeAuthors.includes(author)) return false;
  }
  if (filters.excludeAuthors && filters.excludeAuthors.includes(author)) return false;

  const labels = pr.labels ?? [];
  if (filters.includeLabels && filters.includeLabels.length > 0) {
    if (!labels.some((l) => filters.includeLabels!.includes(l))) return false;
  }
  if (filters.excludeLabels && labels.some((l) => filters.excludeLabels!.includes(l))) return false;

  return true;
}

/**
 * One sweep at a time across instances (a poller lease); a sweep that does
 * overlap another can't launch a second review of a PR anyway: each launch
 * names the review the sweep saw (`seenVersion`, none for a new PR) and
 * lands only while that is still the review, and
 * `pr_reviews_active_pr_url_key` admits one active review per PR URL —
 * `launchPrReview` treats either race as "someone else launched it".
 */
export function startExternalPrReviewWorker() {
  void scheduleRepeat(
    externalPrReviewQueue,
    "external-pr-review.poll-external-prs",
    parseIntEnv("OPTIO_EXTERNAL_PR_POLL_INTERVAL_MS", 120_000),
  ).catch(() => {});

  const worker = new Worker(
    "external-pr-review",
    instrumentWorkerProcessor("external-pr-review", async () => {
      await underPollerLease("external-pr-review", () => sweepExternalPrs());
    }),
    { ...bullmqOpts, concurrency: 1 },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "external-pr-review worker failed");
  });

  return worker;
}

/** One sweep over every repo that reviews external PRs. */
export async function sweepExternalPrs(): Promise<void> {
  const activeRepos = await db
    .select()
    .from(repos)
    .where(
      sql`${repos.externalReviewMode} IN ('on_pr_hold', 'on_pr_post') AND ${repos.reviewEnabled} = true`,
    );

  for (const repo of activeRepos) {
    try {
      // The repo's platform (a self-hosted GitLab added as GitLab) and, for
      // GitLab, its workspace's GITLAB_TOKEN.
      const resolved = await getGitPlatformForRepo(repo.repoUrl, {
        server: true,
        gitlabScope: { workspaceId: repo.workspaceId },
        platformHint: (repo.gitPlatform as GitPlatformType | null) ?? undefined,
      }).catch(() => null);
      if (!resolved) continue;
      const { platform, ri } = resolved;

      const prs = await platform.listOpenPullRequests(ri, { perPage: 50 }).catch(() => []);
      if (prs.length === 0) continue;

      const prUrls = prs.map((p) => p.url);
      const reviews = prUrls.length
        ? await db.select().from(prReviews).where(inArray(prReviews.prUrl, prUrls))
        : [];
      const byUrl = new Map<string, (typeof reviews)[number]>();
      for (const r of reviews) byUrl.set(r.prUrl, preferredReview(byUrl.get(r.prUrl), r));

      const filters = repo.externalReviewFilters ?? null;

      for (const pr of prs) {
        try {
          const existing = byUrl.get(pr.url);

          if (existing) {
            // Skip in-flight drafting states — reconciler owns those.
            if (
              existing.state === PrReviewState.QUEUED ||
              existing.state === PrReviewState.REVIEWING
            ) {
              continue;
            }

            // User has engaged — don't auto-mutate their review.
            if (existing.userEngaged) {
              // But still advance waiting_ci if CI has cleared.
              if (existing.state === PrReviewState.WAITING_CI) {
                const checks = await platform.getCIChecks(ri, pr.headSha).catch(() => []);
                const status = determineCheckStatus(checks);
                if (status !== "pending") {
                  await launchPrReview({
                    prUrl: pr.url,
                    workspaceId: repo.workspaceId ?? undefined,
                    origin: existing.origin as "auto" | "manual",
                    seenVersion: existing.updatedAt,
                  });
                }
              }
              continue;
            }

            // New commits — spawn a rereview.
            if (pr.headSha && pr.headSha !== existing.headSha) {
              await launchPrReview({
                prUrl: pr.url,
                workspaceId: repo.workspaceId ?? undefined,
                origin: "auto",
                seenVersion: existing.updatedAt,
              });
              continue;
            }

            // Waiting on CI — promote when CI clears.
            if (existing.state === PrReviewState.WAITING_CI) {
              const checks = await platform.getCIChecks(ri, pr.headSha).catch(() => []);
              const status = determineCheckStatus(checks);
              if (status !== "pending") {
                await launchPrReview({
                  prUrl: pr.url,
                  workspaceId: repo.workspaceId ?? undefined,
                  origin: "auto",
                  seenVersion: existing.updatedAt,
                });
              }
              continue;
            }

            continue;
          }

          // No existing review — apply filters, then decide whether to
          // park in waiting_ci or launch immediately.
          if (!passesFilters(pr, filters)) continue;
          if (filters?.skipOptioAuthored && (await isOptioAuthoredPr(pr.url))) continue;

          let startInWaitingCi = false;
          if (repo.externalReviewWaitForCi) {
            const checks = await platform.getCIChecks(ri, pr.headSha).catch(() => []);
            const status = determineCheckStatus(checks);
            if (status === "pending") startInWaitingCi = true;
          }

          await launchPrReview({
            prUrl: pr.url,
            workspaceId: repo.workspaceId ?? undefined,
            origin: "auto",
            startInWaitingCi,
            seenVersion: null,
          });
        } catch (err) {
          logger.warn(
            { err, prUrl: pr.url, repoId: repo.id },
            "external PR review: failed to process PR",
          );
        }
      }
    } catch (err) {
      logger.warn({ err, repoId: repo.id }, "external PR review: failed to process repo");
    }
  }
}

// Keep `and`, `eq` available for future filters so lint doesn't strip them.
void and;
void eq;
