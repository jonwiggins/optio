import { readPrConversation } from "./pr-conversation.js";
/**
 * PR Review service — operates on the `pr_reviews` primitive.
 *
 * Each `pr_reviews` row is the canonical record of a review attached to a
 * single PR. Agent executions live in `pr_review_runs` (initial / rereview
 * / chat). State transitions are recorded in `pr_review_events`.
 *
 * The agent itself runs on the repo-pod infrastructure via the dedicated
 * `pr-review-worker`. This service owns DB manipulations and the HTTP
 * surface; the worker owns pod + exec + log streaming + output parsing.
 */
import {
  PrReviewState,
  PrReviewRunState,
  builtinPromptTemplates,
  resolveRepoPlatform,
  REVIEW_TASK_FILE_PATH,
  PR_REVIEW_OUTPUT_PATH,
  renderPromptTemplate,
  shellSafeTitle,
  normalizeRepoUrl,
  parsePrUrl,
  parseRepoUrl,
  type PrReviewRunKind,
  type PrReviewVerdict,
  type PrReviewOrigin,
  type PrReviewFileComment,
} from "@optio/shared";
import { db } from "../db/client.js";
import {
  repos,
  tasks,
  prReviews,
  prReviewRuns,
  prReviewEvents,
  prReviewChatMessages,
} from "../db/schema.js";
import { eq, and, sql, asc, desc, inArray } from "drizzle-orm";
import { getGitPlatformForRepo } from "./git-token-service.js";
import { enqueueReconcile } from "./reconcile-queue.js";
import * as runLogService from "./run-log-service.js";
import { publishEvent } from "./event-bus.js";
import { isUniqueViolation } from "../utils/db-errors.js";
import { updatedAtMatches } from "../utils/pg-timestamp.js";
import { logger } from "../logger.js";
import { getSettings } from "./optio-settings-service.js";
import { planReviewRun, withReviewDepth } from "./review-defaults.js";

export type PrReview = typeof prReviews.$inferSelect;
export type PrReviewRun = typeof prReviewRuns.$inferSelect;

// ── Transition helper ───────────────────────────────────────────────────────

export async function transitionPrReview(
  id: string,
  to: PrReviewState,
  trigger: string,
  opts?: { message?: string; userId?: string; runId?: string },
): Promise<PrReview | null> {
  const [current] = await db.select().from(prReviews).where(eq(prReviews.id, id));
  if (!current) return null;
  const fromState = current.state as PrReviewState;
  if (fromState === to) return current;

  const [updated] = await db
    .update(prReviews)
    .set({ state: to, updatedAt: new Date() })
    .where(eq(prReviews.id, id))
    .returning();
  if (!updated) return null;

  await db.insert(prReviewEvents).values({
    prReviewId: id,
    runId: opts?.runId ?? null,
    fromState,
    toState: to,
    trigger,
    message: opts?.message ?? null,
    userId: opts?.userId ?? null,
  });

  await publishEvent({
    type: "pr_review:state_changed" as never,
    prReviewId: id,
    fromState,
    toState: to,
    trigger,
    timestamp: new Date().toISOString(),
  } as never).catch(() => {});

  // A cancelled review's agent must actually stop — from whichever API
  // instance took the cancel, not only the one streaming the run
  // (docs/plans/scale-out.md §1). The attached instance then sees it exit.
  // Its runs not started yet (queued, or still being set up) are cancelled
  // with it: the worker setting one up sees that and starts nothing more.
  if (to === PrReviewState.CANCELLED) {
    const cancelledRuns = await db
      .update(prReviewRuns)
      .set({
        state: PrReviewRunState.CANCELLED,
        errorMessage: "Parent review is cancelled",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(prReviewRuns.prReviewId, id),
          inArray(prReviewRuns.state, [PrReviewRunState.QUEUED, PrReviewRunState.PROVISIONING]),
        ),
      )
      .returning({ id: prReviewRuns.id });
    for (const run of cancelledRuns) {
      await publishEvent({
        type: "pr_review_run:state_changed",
        prReviewId: id,
        runId: run.id,
        fromState: null,
        toState: PrReviewRunState.CANCELLED,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }
    const active = await db
      .select({ id: prReviewRuns.id, podId: prReviewRuns.podId })
      .from(prReviewRuns)
      .where(and(eq(prReviewRuns.prReviewId, id), eq(prReviewRuns.execState, "started")));
    if (active.length > 0) {
      const { signalRun } = await import("./run-attachment.js");
      for (const run of active) await signalRun(run.podId, run.id, "TERM");
    }
  }

  // Poke the reconciler so downstream decisions fire promptly.
  await enqueueReconcile({ kind: "pr-review", id }, { reason: `transition:${to}` }).catch(() => {});

  return updated;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fetch PR context: description, existing reviews, comments. Used to build
 * the review prompt's context file.
 */
async function fetchPrContext(
  repoUrl: string,
  prNumber: number,
  userId?: string,
): Promise<{
  prTitle: string;
  prBody: string;
  headSha: string;
  existingReviews: string;
  prComments: string;
  inlineComments: string;
}> {
  const { platform, ri } = await getGitPlatformForRepo(repoUrl, {
    userId,
    server: !userId,
  });

  const out = {
    prTitle: "",
    prBody: "",
    headSha: "",
    existingReviews: "",
    prComments: "",
    inlineComments: "",
  };

  const prData = await platform.getPullRequest(ri, prNumber);
  out.prTitle = prData.title;
  out.prBody = prData.body;
  out.headSha = prData.headSha;

  Object.assign(out, await readPrConversation(platform, ri, prNumber));

  return out;
}

function reviewContextFileContent(ctx: {
  prNumber: number;
  prUrl: string;
  prTitle: string;
  prBody: string;
  existingReviews: string;
  prComments: string;
  inlineComments: string;
  baseBranch: string;
}) {
  const parts = [
    `# Review Context`,
    ``,
    `## PR #${ctx.prNumber}: ${ctx.prTitle}`,
    `- URL: ${ctx.prUrl}`,
    `- Base: ${ctx.baseBranch}`,
  ];
  if (ctx.prBody) parts.push(``, `## PR Description`, ``, ctx.prBody);
  if (ctx.existingReviews) parts.push(``, `## Existing Reviews`, ``, ctx.existingReviews);
  if (ctx.prComments) parts.push(``, `## PR Discussion`, ``, ctx.prComments);
  if (ctx.inlineComments) parts.push(``, `## Inline Code Comments`, ``, ctx.inlineComments);
  return parts.join("\n");
}

// ── List open PRs ───────────────────────────────────────────────────────────

/**
 * Return open PRs across configured repos with their (optional) attached
 * pr_reviews record. Used by the /reviews list page.
 */
export interface PullRequestSummary {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  url: string;
  headSha: string;
  baseBranch: string;
  author: string | null;
  assignees: string[];
  labels: string[];
  repo: { id: string; fullName: string; repoUrl: string };
  createdAt: string;
  updatedAt: string;
  review: {
    id: string;
    state: string;
    verdict: string | null;
    origin: string;
    updatedAt: Date;
  } | null;
}

export async function listOpenPrs(
  workspaceId: string | undefined,
  repoId?: string,
): Promise<PullRequestSummary[]> {
  let repoList: (typeof repos.$inferSelect)[];
  if (repoId) {
    const [repo] = await db.select().from(repos).where(eq(repos.id, repoId));
    if (repo && workspaceId && repo.workspaceId !== workspaceId) {
      repoList = [];
    } else {
      repoList = repo ? [repo] : [];
    }
  } else if (workspaceId) {
    repoList = await db.select().from(repos).where(eq(repos.workspaceId, workspaceId));
  } else {
    repoList = await db.select().from(repos);
  }

  if (repoList.length === 0) return [];

  const existing = await db.select().from(prReviews);
  const reviewByUrl = new Map(existing.map((r) => [r.prUrl, r]));

  const allPrs: PullRequestSummary[] = [];

  for (const repo of repoList) {
    try {
      const ri = parseRepoUrl(repo.repoUrl);
      if (!ri) continue;

      const { platform } = await getGitPlatformForRepo(repo.repoUrl, { server: true }).catch(
        () => ({
          platform: null as unknown as Awaited<
            ReturnType<typeof getGitPlatformForRepo>
          >["platform"],
        }),
      );
      if (!platform) continue;

      const prs = await platform.listOpenPullRequests(ri, { perPage: 50 });

      for (const pr of prs) {
        const review = reviewByUrl.get(pr.url);
        allPrs.push({
          id: pr.number,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          draft: pr.draft,
          url: pr.url,
          headSha: pr.headSha,
          baseBranch: pr.baseBranch,
          author: pr.author || null,
          assignees: pr.assignees,
          labels: pr.labels,
          repo: { id: repo.id, fullName: repo.fullName, repoUrl: repo.repoUrl },
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          review: review
            ? {
                id: review.id,
                state: review.state,
                verdict: review.verdict,
                origin: review.origin,
                updatedAt: review.updatedAt,
              }
            : null,
        });
      }
    } catch (err) {
      logger.warn({ err, repo: repo.fullName }, "Error fetching PRs");
    }
  }

  // Sort: un-reviewed first, then most-recently-updated.
  allPrs.sort((a, b) => {
    if (a.review && !b.review) return 1;
    if (!a.review && b.review) return -1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return allPrs;
}

// ── Create / launch ─────────────────────────────────────────────────────────

export class ReviewScopeError extends Error {}

interface LaunchPrReviewInput {
  /** MCP pins the exact tenant, including the null local tenant, across lookups/races. */
  expectedWorkspaceId?: string | null;
  prUrl: string;
  workspaceId?: string;
  createdBy?: string;
  origin?: PrReviewOrigin;
  /** Start in waiting_ci if the repo wants CI to clear first. */
  startInWaitingCi?: boolean;
  /**
   * The review the caller decided on: its `updatedAt`, or null when it saw
   * none. The launch lands only while that is still so, so two sweeps
   * (two API instances) that decide on the same view launch once; the
   * loser gets `raced: true` and the review as it is. Omitted (a person's
   * launch), the current review is relaunched whatever it was.
   */
  seenVersion?: Date | null;
}

/** Of two reviews of one PR, the one `findReviewByUrl` returns: active first, then newest. */
export function preferredReview<T extends Pick<PrReview, "state" | "updatedAt">>(
  a: T | undefined,
  b: T,
): T {
  if (!a) return b;
  const activeA = ACTIVE_PR_REVIEW_STATES.includes(a.state as PrReviewState);
  const activeB = ACTIVE_PR_REVIEW_STATES.includes(b.state as PrReviewState);
  if (activeA !== activeB) return activeA ? a : b;
  return b.updatedAt.getTime() > a.updatedAt.getTime() ? b : a;
}

/**
 * Create a fresh pr_reviews record and enqueue the initial run. If a
 * pr_reviews row already exists for the PR URL, promote it to reviewing
 * and spawn a rereview run rather than duplicating.
 */
/** The states a review is "in flight" in: at most one of these per PR URL (`pr_reviews_active_pr_url_key`). */
export const ACTIVE_PR_REVIEW_STATES: readonly PrReviewState[] = [
  PrReviewState.QUEUED,
  PrReviewState.WAITING_CI,
  PrReviewState.REVIEWING,
  PrReviewState.READY,
];

/**
 * The review row a launch builds on for a PR URL: the active one when there
 * is one, else the most recently updated. A historical cancelled duplicate
 * (overlapping sweeps before the unique index) is never picked over a live
 * review.
 */
export async function findReviewByUrl(prUrl: string): Promise<PrReview | undefined> {
  const [row] = await db
    .select()
    .from(prReviews)
    .where(eq(prReviews.prUrl, prUrl))
    .orderBy(
      desc(
        sql`${prReviews.state} IN (${sql.join(
          ACTIVE_PR_REVIEW_STATES.map((s) => sql`${s}`),
          sql`, `,
        )})`,
      ),
      desc(prReviews.updatedAt),
    )
    .limit(1);
  return row;
}

export async function launchPrReview(input: LaunchPrReviewInput) {
  const parsed = parsePrUrl(input.prUrl);
  if (!parsed) throw new Error("Invalid PR URL");

  const { owner, repo: repoName, prNumber } = parsed;
  const repoUrl = normalizeRepoUrl(`https://${parsed.host}/${owner}/${repoName}`);

  const { getRepoByUrl } = await import("./repo-service.js");
  const repoConfig = await getRepoByUrl(repoUrl, input.workspaceId);
  if (!repoConfig) {
    throw new Error(`Repository ${owner}/${repoName} is not configured in Optio. Add it first.`);
  }

  const checkScope = (row: { workspaceId: string | null } | undefined) => {
    if (
      row &&
      input.expectedWorkspaceId !== undefined &&
      row.workspaceId !== input.expectedWorkspaceId
    )
      throw new ReviewScopeError("Review or repository is outside this workspace");
  };
  checkScope(repoConfig);

  // Fetch PR context up-front to pin head_sha and build prompt.
  const prContext = await fetchPrContext(repoUrl, prNumber, input.createdBy);
  if (!prContext.headSha) throw new Error("Could not determine PR head SHA");

  const origin = input.origin ?? "manual";

  // Upsert pr_reviews row.
  const existing = await findReviewByUrl(input.prUrl);
  checkScope(existing);
  if (existing && input.seenVersion === null) {
    // The caller saw no review; someone launched one since.
    logger.info({ prUrl: input.prUrl, reviewId: existing.id }, "PR review launched elsewhere");
    return { review: existing, raced: true as const };
  }
  let review: PrReview;
  if (existing) {
    // Reset to queued/reviewing with fresh head_sha. Keep origin sticky —
    // a manual launch on top of an auto review flips to manual so the
    // auto-rereview flow no longer applies. A sweep's launch is a
    // compare-and-swap on the version it saw: two sweeps (two API
    // instances) relaunching the same review start one run, not two. A
    // person's launch (no `seenVersion`) relaunches the review as it is now.
    const [reset] = await db
      .update(prReviews)
      .set({
        headSha: prContext.headSha,
        state: input.startInWaitingCi ? PrReviewState.WAITING_CI : PrReviewState.QUEUED,
        origin,
        verdict: null,
        summary: null,
        fileComments: null,
        submittedAt: null,
        autoSubmitted: false,
        errorMessage: null,
        controlIntent: null,
        reconcileBackoffUntil: null,
        reconcileAttempts: 0,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(prReviews.id, existing.id),
          input.seenVersion ? updatedAtMatches(prReviews.updatedAt, input.seenVersion) : undefined,
        ),
      )
      .returning();
    if (!reset) {
      const theirs = (await findReviewByUrl(input.prUrl)) ?? existing;
      checkScope(theirs);
      logger.info({ prUrl: input.prUrl, reviewId: theirs.id }, "PR review relaunched elsewhere");
      return { review: theirs, raced: true as const };
    }
    review = reset;
    await db.insert(prReviewEvents).values({
      prReviewId: review.id,
      fromState: existing.state as PrReviewState,
      toState: review.state as PrReviewState,
      trigger: origin === "auto" ? "auto_relaunch" : "user_relaunch",
    });
  } else {
    try {
      [review] = await db
        .insert(prReviews)
        .values({
          workspaceId: input.workspaceId ?? null,
          prUrl: input.prUrl,
          prNumber,
          repoOwner: owner,
          repoName,
          repoUrl,
          headSha: prContext.headSha,
          state: input.startInWaitingCi ? PrReviewState.WAITING_CI : PrReviewState.QUEUED,
          origin,
          createdBy: input.createdBy ?? null,
        })
        .returning();
    } catch (err) {
      // Another sweep (on another API instance) launched this PR's review
      // between the lookup and the insert: `pr_reviews_active_pr_url_key`
      // admits one active review per PR. Theirs is the review.
      if (!isUniqueViolation(err)) throw err;
      const theirs = await findReviewByUrl(input.prUrl);
      if (!theirs) throw err;
      checkScope(theirs);
      logger.info({ prUrl: input.prUrl, reviewId: theirs.id }, "PR review launched elsewhere");
      return { review: theirs, raced: true as const };
    }
    await db.insert(prReviewEvents).values({
      prReviewId: review.id,
      toState: review.state as PrReviewState,
      trigger: origin === "auto" ? "auto_created" : "user_created",
    });
  }

  // If we're starting in waiting_ci the reconciler will launch the run
  // once CI resolves; nothing more to do here.
  if (review.state === PrReviewState.WAITING_CI) {
    await enqueueReconcile(
      { kind: "pr-review", id: review.id },
      { reason: "waiting_ci_initial" },
    ).catch(() => {});
    return { review };
  }

  // Otherwise enqueue the initial run immediately.
  const run = await enqueueReviewRun(review.id, "initial", {
    prompt: undefined,
    prContext,
    repoConfig,
    createdBy: input.createdBy,
  });

  return { review, run };
}

/**
 * Create a fresh pr_review_runs row and push a job onto the worker queue.
 * Transitions the parent pr_reviews row to `reviewing`.
 *
 * This is the single funnel for kicking off any kind of review run
 * (initial / rereview / chat).
 */
// Just the fields enqueueReviewRun reads from the repo config. Accepts
// both RepoRecord (from getRepoByUrl) and raw DB row shapes.
interface RepoConfigLike {
  gitPlatform?: string | null;
  defaultBranch: string;
  reviewPromptTemplate?: string | null;
  reviewModel?: string | null;
  testCommand?: string | null;
  reviewEnabled?: boolean | null;
  reviewDepth?: string | null;
  maxTurnsReview?: number | null;
}

export async function enqueueReviewRun(
  prReviewId: string,
  kind: PrReviewRunKind,
  opts: {
    prompt?: string;
    resumeSessionId?: string;
    id?: string;
    prContext?: Awaited<ReturnType<typeof fetchPrContext>>;
    repoConfig?: RepoConfigLike;
    createdBy?: string;
  },
): Promise<PrReviewRun> {
  if (opts.id) {
    const [existing] = await db.select().from(prReviewRuns).where(eq(prReviewRuns.id, opts.id));
    if (existing) {
      if (existing.state === PrReviewRunState.QUEUED) {
        const parent = await getPrReview(prReviewId);
        if (parent && parent.state !== PrReviewState.REVIEWING)
          await transitionPrReview(prReviewId, PrReviewState.REVIEWING, `launch_${kind}`, {
            runId: existing.id,
          });
        const { prReviewRunQueue } = await import("../workers/pr-review-worker.js");
        await prReviewRunQueue.add(
          "process-pr-review-run",
          { runId: existing.id },
          { jobId: existing.id },
        );
      }
      return existing;
    }
  }
  const [review] = await db.select().from(prReviews).where(eq(prReviews.id, prReviewId));
  if (!review) throw new Error(`PR review ${prReviewId} not found`);

  const repoConfig =
    opts.repoConfig ??
    (await (async () => {
      const { getRepoByUrl } = await import("./repo-service.js");
      return getRepoByUrl(review.repoUrl, review.workspaceId ?? undefined);
    })());
  if (!repoConfig) throw new Error(`Repo ${review.repoUrl} is not configured in Optio`);

  // How deep the review goes (the repo's depth, else the workspace's), its
  // test command and turn budget (review-defaults.ts).
  const workspaceSettings = await getSettings(review.workspaceId ?? null).catch(() => null);
  const plan = planReviewRun({ repo: repoConfig, workspace: workspaceSettings });

  // For initial/rereview we need fresh PR context to render the prompt.
  // Chat turns reuse the prior session and just forward the user's text.
  let renderedPrompt: string;
  let taskFileContent: string;
  let headSha = review.headSha;
  if (kind === "chat") {
    renderedPrompt = opts.prompt ?? "";
    taskFileContent = "";
  } else {
    const prContext =
      opts.prContext ?? (await fetchPrContext(review.repoUrl, review.prNumber, opts.createdBy));
    headSha = prContext.headSha || headSha;

    const template =
      repoConfig.reviewPromptTemplate ??
      builtinPromptTemplates(resolveRepoPlatform(review.repoUrl, repoConfig.gitPlatform)).prReview;
    const fullRepoName = `${review.repoOwner}/${review.repoName}`;
    const parsedRepoUrl = parseRepoUrl(
      review.repoUrl,
      resolveRepoPlatform(review.repoUrl, repoConfig.gitPlatform) ?? undefined,
    );
    const isGitLab = parsedRepoUrl?.platform === "gitlab";
    const isCodeCommit = parsedRepoUrl?.platform === "codecommit";

    const rendered = renderPromptTemplate(template, {
      PR_NUMBER: String(review.prNumber),
      TASK_FILE: REVIEW_TASK_FILE_PATH,
      REPO_NAME: fullRepoName,
      TASK_TITLE: shellSafeTitle(prContext.prTitle),
      TEST_COMMAND: plan.testCommand,
      ...plan.vars,
      OUTPUT_PATH: PR_REVIEW_OUTPUT_PATH,
      GIT_PLATFORM_GITLAB: isGitLab ? "true" : "",
      GIT_PLATFORM_CODECOMMIT: isCodeCommit ? "true" : "",
      CODECOMMIT_REPO: isCodeCommit ? (parsedRepoUrl?.repo ?? "") : "",
      BASE_BRANCH: repoConfig.defaultBranch ?? "main",
    });
    renderedPrompt = withReviewDepth(rendered, plan);
    taskFileContent = reviewContextFileContent({
      prNumber: review.prNumber,
      prUrl: review.prUrl,
      prTitle: prContext.prTitle,
      prBody: prContext.prBody,
      existingReviews: prContext.existingReviews,
      prComments: prContext.prComments,
      inlineComments: prContext.inlineComments,
      baseBranch: repoConfig.defaultBranch,
    });
  }

  const [run] = await db
    .insert(prReviewRuns)
    .values({
      ...(opts.id ? { id: opts.id } : {}),
      prReviewId,
      kind,
      state: PrReviewRunState.QUEUED,
      prompt: renderedPrompt,
      resumeSessionId: opts.resumeSessionId ?? null,
      metadata: {
        taskFileContent,
        taskFilePath: REVIEW_TASK_FILE_PATH,
        claudeModel: repoConfig.reviewModel ?? "sonnet",
        // A light review has half the turns (review-defaults.ts).
        ...(plan.maxTurnsReview !== undefined ? { maxTurnsReview: plan.maxTurnsReview } : {}),
      },
    })
    .returning();

  // Ensure parent state reflects that a run is in flight.
  if (review.state !== PrReviewState.REVIEWING) {
    await transitionPrReview(prReviewId, PrReviewState.REVIEWING, `launch_${kind}`, {
      runId: run.id,
    });
  }
  // Pin the fresh head_sha if it drifted.
  if (headSha !== review.headSha) {
    await db
      .update(prReviews)
      .set({ headSha, updatedAt: new Date() })
      .where(eq(prReviews.id, prReviewId));
  }

  const { prReviewRunQueue } = await import("../workers/pr-review-worker.js");
  await prReviewRunQueue.add(
    "process-pr-review-run",
    { runId: run.id },
    { jobId: run.id, priority: 10 },
  );

  logger.info(
    { prReviewId, runId: run.id, kind, prNumber: review.prNumber },
    "PR review run enqueued",
  );

  return run;
}

// ── Get / update ────────────────────────────────────────────────────────────

export async function getPrReview(id: string): Promise<PrReview | null> {
  const [row] = await db.select().from(prReviews).where(eq(prReviews.id, id));
  return row ?? null;
}

export async function getPrReviewByPrUrl(prUrl: string): Promise<PrReview | null> {
  const [row] = await db.select().from(prReviews).where(eq(prReviews.prUrl, prUrl));
  return row ?? null;
}

export async function listPrReviewRuns(prReviewId: string): Promise<PrReviewRun[]> {
  return db
    .select()
    .from(prReviewRuns)
    .where(eq(prReviewRuns.prReviewId, prReviewId))
    .orderBy(desc(prReviewRuns.createdAt));
}

export async function getLatestRun(prReviewId: string): Promise<PrReviewRun | null> {
  const [run] = await db
    .select()
    .from(prReviewRuns)
    .where(eq(prReviewRuns.prReviewId, prReviewId))
    .orderBy(desc(prReviewRuns.createdAt))
    .limit(1);
  return run ?? null;
}

export async function updatePrReviewDraft(
  id: string,
  updates: {
    summary?: string | null;
    verdict?: PrReviewVerdict | null;
    fileComments?: PrReviewFileComment[] | null;
  },
): Promise<PrReview> {
  const [current] = await db.select().from(prReviews).where(eq(prReviews.id, id));
  if (!current) throw new Error("PR review not found");
  const editableStates: PrReviewState[] = [PrReviewState.READY, PrReviewState.STALE];
  if (!editableStates.includes(current.state as PrReviewState)) {
    throw new Error(`Cannot edit review in ${current.state} state`);
  }
  const patch: Record<string, unknown> = { updatedAt: new Date(), userEngaged: true };
  if (updates.summary !== undefined) patch.summary = updates.summary;
  if (updates.verdict !== undefined) patch.verdict = updates.verdict;
  if (updates.fileComments !== undefined) patch.fileComments = updates.fileComments;
  const [updated] = await db.update(prReviews).set(patch).where(eq(prReviews.id, id)).returning();
  return updated;
}

// ── Parse agent output ──────────────────────────────────────────────────────

/**
 * Parse the agent's JSON verdict block from a run's logs and apply it to
 * the parent pr_reviews row. Called by the pr-review-worker after the
 * initial/rereview agent exits cleanly.
 */
export async function parseReviewOutput(runId: string): Promise<void> {
  const [run] = await db.select().from(prReviewRuns).where(eq(prReviewRuns.id, runId));
  if (!run) return;
  const [review] = await db.select().from(prReviews).where(eq(prReviews.id, run.prReviewId));
  if (!review) return;

  const logs = await runLogService.listLogs({ prReviewRunId: runId });

  const parsed = extractVerdictJson(logs.map((l) => l.content).join("\n"));

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed?.verdict && ["approve", "request_changes", "comment"].includes(parsed.verdict)) {
    updates.verdict = parsed.verdict;
  }
  if (parsed?.summary) updates.summary = parsed.summary;
  if (Array.isArray(parsed?.fileComments)) updates.fileComments = parsed.fileComments;

  // Fall back to the run's result summary if we couldn't parse JSON.
  if (!updates.summary && run.resultSummary) {
    if (!/^Agent (completed successfully|exited with code \d+)$/.test(run.resultSummary)) {
      updates.summary = run.resultSummary;
    }
  }

  await db.update(prReviews).set(updates).where(eq(prReviews.id, review.id));
  await transitionPrReview(review.id, PrReviewState.READY, "agent_drafted", { runId });

  logger.info(
    { runId, prReviewId: review.id, hasStructuredOutput: !!parsed },
    "PR review output parsed",
  );

  // Auto-submit if configured + still auto-origin + user hasn't engaged.
  const { getRepoByUrl } = await import("./repo-service.js");
  const repoConfig = await getRepoByUrl(review.repoUrl, review.workspaceId ?? undefined);
  if (
    review.origin === "auto" &&
    !review.userEngaged &&
    repoConfig?.externalReviewMode === "on_pr_post"
  ) {
    try {
      await submitReview(review.id);
      await db
        .update(prReviews)
        .set({ autoSubmitted: true, updatedAt: new Date() })
        .where(eq(prReviews.id, review.id));
      logger.info({ prReviewId: review.id }, "Review auto-submitted (on_pr_post)");
    } catch (err) {
      logger.warn({ err, prReviewId: review.id }, "Auto-submit failed — left in ready state");
    }
  }
}

function extractVerdictJson(
  content: string,
): { verdict?: string; summary?: string; fileComments?: unknown } | null {
  const patterns = [
    /```(?:json)?\s*\n?(\{[\s\S]*?"verdict"[\s\S]*?\})\s*\n?```/,
    /(\{[\s\S]*?"verdict"\s*:\s*"[^"]*"[\s\S]*\})\s*$/m,
    /(\{[^{}]*"verdict"\s*:\s*"[^"]*"[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/,
  ];
  for (const pat of patterns) {
    const m = content.match(pat);
    if (!m) continue;
    try {
      return JSON.parse(m[1]);
    } catch {
      try {
        return JSON.parse(m[1].replace(/,\s*([}\]])/g, "$1"));
      } catch {}
    }
  }
  return null;
}

// ── Submit review ──────────────────────────────────────────────────────────

export async function submitReview(
  id: string,
  userId?: string,
): Promise<{ review: PrReview; reviewUrl?: string }> {
  const [review] = await db.select().from(prReviews).where(eq(prReviews.id, id));
  if (!review) throw new Error("PR review not found");
  const submittable: PrReviewState[] = [PrReviewState.READY, PrReviewState.STALE];
  if (!submittable.includes(review.state as PrReviewState)) {
    throw new Error(`Cannot submit review in ${review.state} state`);
  }

  const repoUrl = review.repoUrl;
  const { platform, ri } = await getGitPlatformForRepo(repoUrl, {
    userId,
    server: !userId,
  });

  const eventMap: Record<string, "APPROVE" | "REQUEST_CHANGES" | "COMMENT"> = {
    approve: "APPROVE",
    request_changes: "REQUEST_CHANGES",
    comment: "COMMENT",
  };
  const event = eventMap[review.verdict ?? "comment"] ?? "COMMENT";

  const comments = (review.fileComments ?? [])
    .filter((c) => c.path && c.body)
    .map((c) => ({
      path: c.path,
      body: c.body,
      ...(c.line ? { line: c.line } : {}),
      ...(c.side ? { side: c.side } : {}),
    }));

  const result = await platform.submitReview(ri, review.prNumber, {
    event,
    body: review.summary ?? "Review by Optio",
    commitId: review.headSha,
    comments: comments.length > 0 ? comments : undefined,
  });

  await db
    .update(prReviews)
    .set({ submittedAt: new Date(), updatedAt: new Date() })
    .where(eq(prReviews.id, id));
  const updated = await transitionPrReview(id, PrReviewState.SUBMITTED, "user_submit", {
    userId,
  });

  return { review: updated ?? review, reviewUrl: result.url };
}

// ── Re-review ──────────────────────────────────────────────────────────────

export async function reReview(
  id: string,
  userId?: string,
  runId?: string,
): Promise<{ review: PrReview; run: PrReviewRun }> {
  const [review] = await db.select().from(prReviews).where(eq(prReviews.id, id));
  if (!review) throw new Error("PR review not found");

  // Mark as manual origin on user-initiated re-review so auto-submit
  // doesn't kick in.
  await db
    .update(prReviews)
    .set({ origin: "manual", userEngaged: true, updatedAt: new Date() })
    .where(eq(prReviews.id, id));

  const run = await enqueueReviewRun(id, "rereview", {
    createdBy: userId,
    ...(runId ? { id: runId } : {}),
  });
  const [fresh] = await db.select().from(prReviews).where(eq(prReviews.id, id));
  return { review: fresh, run };
}

// ── Merge PR ───────────────────────────────────────────────────────────────

/**
 * A PR URL a caller passes in names any repo on any host, and the platform
 * call runs with the deployment's token. When the caller has a workspace
 * (`workspaceId` given, null = auth-disabled default), the PR's repo must be
 * one registered there — the server token must not read or merge another
 * workspace's (or anybody's) PRs for them.
 */
async function assertPrRepoInWorkspace(repoUrl: string, workspaceId: string | null | undefined) {
  if (workspaceId === undefined) return;
  const { getRepoByUrl } = await import("./repo-service.js");
  if (!(await getRepoByUrl(repoUrl, workspaceId))) {
    throw new Error("This pull request's repository is not configured in this workspace");
  }
}

export async function mergePr(input: {
  prUrl: string;
  mergeMethod: "merge" | "squash" | "rebase";
  userId?: string;
  /** The caller's workspace: the PR's repo must be registered there. */
  workspaceId?: string | null;
}) {
  const parsed = parsePrUrl(input.prUrl);
  if (!parsed) throw new Error("Invalid PR URL");

  const repoUrl = `https://${parsed.host}/${parsed.owner}/${parsed.repo}`;
  await assertPrRepoInWorkspace(repoUrl, input.workspaceId);
  const { platform, ri } = await getGitPlatformForRepo(repoUrl, {
    userId: input.userId,
    server: !input.userId,
  });

  await platform.mergePullRequest(ri, parsed.prNumber, input.mergeMethod);

  logger.info({ prNumber: parsed.prNumber, method: input.mergeMethod }, "PR merged via Optio");
  return { merged: true };
}

// ── Get PR status (used by /reviews detail + poller) ────────────────────────

export async function getPrStatus(prUrl: string, opts: { workspaceId?: string | null } = {}) {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) throw new Error("Invalid PR URL");

  const repoUrl = `https://${parsed.host}/${parsed.owner}/${parsed.repo}`;
  await assertPrRepoInWorkspace(repoUrl, opts.workspaceId);
  const { platform, ri } = await getGitPlatformForRepo(repoUrl, { server: true });

  const prData = await platform.getPullRequest(ri, parsed.prNumber);

  const checkRuns = await platform.getCIChecks(ri, prData.headSha).catch(() => []);
  let checksStatus = "none";
  if (checkRuns.length > 0) {
    const allComplete = checkRuns.every((r) => r.status === "completed");
    const allSuccess = checkRuns.every(
      (r) => r.conclusion === "success" || r.conclusion === "skipped",
    );
    checksStatus = !allComplete ? "pending" : allSuccess ? "passing" : "failing";
  }

  const reviews = await platform.getReviews(ri, parsed.prNumber).catch(() => []);
  let reviewStatus = "none";
  if (reviews.length > 0) {
    const substantive = reviews.filter((r) => r.state !== "COMMENTED" && r.state !== "DISMISSED");
    const latest = substantive[substantive.length - 1];
    if (latest) {
      reviewStatus =
        latest.state === "APPROVED"
          ? "approved"
          : latest.state === "CHANGES_REQUESTED"
            ? "changes_requested"
            : "pending";
    } else {
      reviewStatus = "pending";
    }
  }

  return {
    checksStatus,
    reviewStatus,
    mergeable: prData.mergeable,
    prState: prData.merged ? "merged" : prData.state,
    headSha: prData.headSha,
  };
}

// ── Mark stale (called by pr-watcher when head_sha drifts) ──────────────────

export async function markStale(prReviewId: string): Promise<PrReview | null> {
  const [row] = await db
    .update(prReviews)
    .set({ state: PrReviewState.STALE, updatedAt: new Date() })
    .where(and(eq(prReviews.id, prReviewId), eq(prReviews.state, PrReviewState.READY)))
    .returning();
  if (!row) return null;
  await db.insert(prReviewEvents).values({
    prReviewId,
    fromState: PrReviewState.READY,
    toState: PrReviewState.STALE,
    trigger: "new_commits",
  });
  await publishEvent({
    type: "pr_review:stale" as never,
    prReviewId,
    timestamp: new Date().toISOString(),
  } as never).catch(() => {});
  return row;
}

// ── Chat ────────────────────────────────────────────────────────────────────

export async function listReviewChat(prReviewId: string) {
  return db
    .select()
    .from(prReviewChatMessages)
    .where(eq(prReviewChatMessages.prReviewId, prReviewId))
    .orderBy(asc(prReviewChatMessages.createdAt));
}

/**
 * Post a user chat turn. Records the user message, flips `userEngaged`,
 * and spawns a chat run that resumes the initial review's agent session.
 */
export async function postReviewChat(input: {
  prReviewId: string;
  message: string;
  userId?: string;
}) {
  const [review] = await db.select().from(prReviews).where(eq(prReviews.id, input.prReviewId));
  if (!review) throw new Error("PR review not found");

  if (
    review.state === PrReviewState.REVIEWING ||
    review.state === PrReviewState.WAITING_CI ||
    review.state === PrReviewState.QUEUED
  ) {
    throw new Error("Cannot chat while a review is still being generated");
  }

  // Find the most recent non-chat run to resume from.
  const [rootRun] = await db
    .select()
    .from(prReviewRuns)
    .where(
      and(
        eq(prReviewRuns.prReviewId, review.id),
        sql`${prReviewRuns.kind} IN ('initial','rereview')`,
      ),
    )
    .orderBy(desc(prReviewRuns.createdAt))
    .limit(1);
  if (!rootRun) throw new Error("No prior review run to resume from");
  if (!rootRun.sessionId) {
    throw new Error("Prior review run has no captured session — chat not available yet");
  }

  // Enqueue first so we fail before committing a user-visible chat message
  // if the run can't be created (e.g. repo not configured, queue down).
  // Otherwise the UI shows an orphaned "unanswered" user turn indefinitely.
  const run = await enqueueReviewRun(review.id, "chat", {
    prompt: input.message,
    resumeSessionId: rootRun.sessionId,
    createdBy: input.userId,
  });

  await db.insert(prReviewChatMessages).values({
    prReviewId: review.id,
    runId: run.id,
    role: "user",
    content: input.message,
  });

  await db
    .update(prReviews)
    .set({ userEngaged: true, updatedAt: new Date() })
    .where(eq(prReviews.id, review.id));

  return { runId: run.id, prReviewId: review.id };
}

/**
 * Called by pr-review-worker after a chat run completes. Appends the
 * assistant's reply to chat messages; if the reply carries a fresh JSON
 * verdict block, patches the draft in place.
 */
export async function appendChatReplyFromRun(runId: string): Promise<void> {
  const [run] = await db.select().from(prReviewRuns).where(eq(prReviewRuns.id, runId));
  if (!run) return;
  const [review] = await db.select().from(prReviews).where(eq(prReviews.id, run.prReviewId));
  if (!review) return;

  const logs = await runLogService.listLogs({ prReviewRunId: runId });
  const allContent = logs.map((l) => l.content).join("\n");

  const parsed = extractVerdictJson(allContent);
  let jsonMatch: string | null = null;
  const patterns = [
    /```(?:json)?\s*\n?(\{[\s\S]*?"verdict"[\s\S]*?\})\s*\n?```/,
    /(\{[\s\S]*?"verdict"\s*:\s*"[^"]*"[\s\S]*\})\s*$/m,
    /(\{[^{}]*"verdict"\s*:\s*"[^"]*"[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/,
  ];
  for (const pat of patterns) {
    const m = allContent.match(pat);
    if (m) {
      jsonMatch = m[1];
      break;
    }
  }

  let reply = run.resultSummary?.trim() || "";
  if (!reply || /^Agent (completed successfully|exited with code \d+)$/.test(reply)) {
    reply = allContent.slice(-4000).trim();
  }
  if (jsonMatch) reply = reply.replace(jsonMatch, "").trim();
  if (!reply) reply = (parsed?.summary as string) ?? "(no reply)";

  await db.insert(prReviewChatMessages).values({
    prReviewId: review.id,
    runId,
    role: "assistant",
    content: reply,
  });

  if (parsed) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (
      typeof parsed.verdict === "string" &&
      ["approve", "request_changes", "comment"].includes(parsed.verdict)
    ) {
      updates.verdict = parsed.verdict;
    }
    if (typeof parsed.summary === "string") updates.summary = parsed.summary;
    if (Array.isArray(parsed.fileComments)) updates.fileComments = parsed.fileComments;
    if (Object.keys(updates).length > 1) {
      await db.update(prReviews).set(updates).where(eq(prReviews.id, review.id));
    }
  }

  logger.info(
    { runId, prReviewId: review.id, hasStructuredOutput: !!parsed },
    "Chat reply appended",
  );
}

// ── Cancel / intent ────────────────────────────────────────────────────────

export async function setControlIntent(id: string, intent: "cancel" | "rereview"): Promise<void> {
  await db
    .update(prReviews)
    .set({ controlIntent: intent, updatedAt: new Date() })
    .where(eq(prReviews.id, id));
  await enqueueReconcile({ kind: "pr-review", id }, { reason: `intent:${intent}` }).catch(() => {});
}

// ── Helpers used by poller / pr-watcher / tasks filter ─────────────────────

/**
 * Check whether a PR is the product of an optio coding task. Used by the
 * poller to skip auto-reviewing Optio-authored PRs (to avoid infinite
 * loops).
 */
export async function isOptioAuthoredPr(prUrl: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.prUrl, prUrl))
    .limit(1);
  return !!row;
}

export async function listReviewsByPrUrls(prUrls: string[]): Promise<PrReview[]> {
  if (prUrls.length === 0) return [];
  return db.select().from(prReviews).where(inArray(prReviews.prUrl, prUrls));
}
