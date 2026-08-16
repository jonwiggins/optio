import { and, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, workflowRuns, prReviews, persistentAgents } from "../db/schema.js";
import type {
  Action,
  PersistentAgentAction,
  PrReviewAction,
  RepoAction,
  StandaloneAction,
  WorldSnapshot,
} from "@optio/shared";
import {
  TaskState,
  WorkflowRunState,
  PrReviewState,
  PersistentAgentState,
  parsePrUrl,
  parseIntEnv,
} from "@optio/shared";
import * as taskService from "./task-service.js";
import { enqueueReconcile } from "./reconcile-queue.js";
import { classifyGitHubFailure, type GitHubFailure } from "./git-platform/github.js";
import { logger } from "../logger.js";

/**
 * Outcome of executing a reconcile action.
 *
 * `applied` — the action ran to completion, state was mutated (if any).
 * `stale`   — the CAS guard found a newer updated_at; caller should re-enqueue.
 * `skipped` — action was a noop / clearControlIntent that produced no mutation.
 * `error`   — something threw; caller should record + re-enqueue with backoff.
 */
export type ExecuteOutcome =
  | { status: "applied"; reason: string }
  | { status: "stale"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string; error: unknown };

/**
 * Apply a reconcile action. All DB mutations are CAS-gated on
 * updated_at == snapshot.run.status.updatedAt so a decision made from
 * a stale snapshot cannot overwrite a concurrent transition.
 *
 * State transitions delegate to taskService.transitionTask so all downstream
 * fan-out (events, webhooks, Slack, issue closure, dependency cascade) runs
 * in one place. Side-effect actions (queue enqueue, PR merge, review launch)
 * are implemented inline below.
 */
export async function executeAction(
  action: Action,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  const log = logger.child({
    reconcile: true,
    kind: snapshot.run.kind,
    runId: snapshot.run.ref.id,
    actionKind: action.kind,
  });

  try {
    switch (action.kind) {
      case "noop":
        return { status: "skipped", reason: action.reason };

      case "requeueSoon":
        // Caller (worker) handles re-enqueue with the returned delay.
        log.info({ delayMs: action.delayMs, reason: action.reason }, "reconcile.requeueSoon");
        return { status: "skipped", reason: action.reason };

      case "deferWithBackoff":
        return await applyDeferWithBackoff(action.untilMs, snapshot);

      case "clearControlIntent":
        return await applyClearControlIntent(snapshot);

      case "transition":
        return await applyTransition(action, snapshot);

      case "patchStatus":
        if (snapshot.run.kind === "pr-review") {
          return await applyPrReviewPatchStatus(
            action as Extract<PrReviewAction, { kind: "patchStatus" }>,
            snapshot,
          );
        }
        if (snapshot.run.kind === "persistent-agent") {
          return await applyPersistentAgentPatchStatus(
            action as Extract<PersistentAgentAction, { kind: "patchStatus" }>,
            snapshot,
          );
        }
        return await applyPatchStatus(
          action as Extract<RepoAction, { kind: "patchStatus" }>,
          snapshot,
        );

      case "requeueForAgent":
        return await applyRequeueForAgent(action, snapshot);

      case "enqueueAgent":
        return await applyEnqueueAgent(action, snapshot);

      case "enqueueTurn":
        return await applyEnqueueTurn(action, snapshot);

      case "resumeAgent":
        return await applyResumeAgent(action, snapshot);

      case "launchReview":
        return await applyLaunchReview(snapshot);

      case "autoMergePr":
        return await applyAutoMergePr(snapshot);

      case "launchReviewRun":
        return await applyLaunchReviewRun(action, snapshot);

      case "submitReview":
        return await applySubmitReview(snapshot);

      case "markStale":
        return await applyMarkStale(snapshot);

      default: {
        const _exhaustive: never = action;
        return {
          status: "error",
          reason: `unknown_action:${JSON.stringify(_exhaustive)}`,
          error: new Error("unknown action"),
        };
      }
    }
  } catch (err) {
    log.error({ err, reason: action.reason }, "reconcile.executeAction failed");
    return { status: "error", reason: action.reason, error: err };
  }
}

// ── Applicators ─────────────────────────────────────────────────────────────

async function applyTransition(
  action: RepoAction | StandaloneAction | PrReviewAction | PersistentAgentAction,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  if (action.kind !== "transition") {
    return { status: "error", reason: "bad_action", error: new Error("not a transition") };
  }
  if (snapshot.run.kind === "repo") {
    return applyRepoTransition(action as Extract<RepoAction, { kind: "transition" }>, snapshot);
  }
  if (snapshot.run.kind === "pr-review") {
    return applyPrReviewTransition(
      action as Extract<PrReviewAction, { kind: "transition" }>,
      snapshot,
    );
  }
  if (snapshot.run.kind === "persistent-agent") {
    return applyPersistentAgentTransition(
      action as Extract<PersistentAgentAction, { kind: "transition" }>,
      snapshot,
    );
  }
  return applyStandaloneTransition(
    action as Extract<StandaloneAction, { kind: "transition" }>,
    snapshot,
  );
}

async function applyRepoTransition(
  action: Extract<RepoAction, { kind: "transition" }>,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  const id = snapshot.run.ref.id;
  const version = snapshot.run.status.updatedAt;

  // Apply any supporting status fields first, CAS-gated on version. If the
  // CAS fails, we bail before issuing the transition so we don't emit events
  // based on stale decisions. Default to clearing backoff + intent on a
  // transition; the decision function can override by setting
  // reconcileBackoffUntil in its statusPatch.
  const patch: Record<string, unknown> = {
    reconcileBackoffUntil: null,
    reconcileAttempts: 0,
    ...(action.statusPatch ?? {}),
  };
  if (action.clearControlIntent) {
    patch.controlIntent = null;
  }
  const casResult = await casUpdate("tasks", id, version, patch);
  if (casResult === "stale") {
    return { status: "stale", reason: "cas_failed_pre_transition" };
  }

  // Delegate the state transition to the existing service so all downstream
  // fan-out (events, webhooks, Slack, issue close, dependency cascade) runs.
  try {
    await taskService.transitionTask(id, action.to, action.trigger, action.reason);
    await scheduleBackoffReconcile(snapshot.run.ref, patch.reconcileBackoffUntil);
    return { status: "applied", reason: `transition:${action.to}` };
  } catch (err) {
    // StateRaceError means another worker won; treat as stale.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("StateRace") || msg.includes("Invalid state transition")) {
      return { status: "stale", reason: msg };
    }
    return { status: "error", reason: msg, error: err };
  }
}

async function applyStandaloneTransition(
  action: Extract<StandaloneAction, { kind: "transition" }>,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "standalone") {
    return { status: "error", reason: "wrong_kind", error: new Error("not standalone") };
  }
  const id = snapshot.run.ref.id;
  const version = snapshot.run.status.updatedAt;
  const fromState = snapshot.run.status.state;
  const workflowId = snapshot.run.spec.workflowId;

  const patch: Record<string, unknown> = {
    state: action.to,
    updatedAt: new Date(),
    reconcileBackoffUntil: null,
    reconcileAttempts: 0,
    ...(action.statusPatch ?? {}),
  };
  if (action.clearControlIntent) {
    patch.controlIntent = null;
  }
  const rows = await db
    .update(workflowRuns)
    .set(patch)
    .where(
      and(
        eq(workflowRuns.id, id),
        // Ms-truncating comparison, NOT a plain eq — see updatedAtMatches. A
        // raw eq() silently never matches rows whose updated_at carries
        // microseconds (e.g. stamped by PG's now()/defaultNow()), which made
        // every standalone transition from such rows permanently stale.
        updatedAtMatches(workflowRuns.updatedAt, version),
        eq(workflowRuns.state, fromState),
      ),
    )
    .returning();

  if (rows.length === 0) {
    return { status: "stale", reason: "cas_failed_standalone_transition" };
  }

  // Publish state-change event + outbound webhook so subscribers see the
  // transition. Mirrors workflow-worker's transitionRun helper.
  await publishStandaloneStateChange(id, workflowId, fromState, action.to).catch((err) =>
    logger.warn({ err, runId: id }, "standalone state-change publish failed"),
  );

  await scheduleBackoffReconcile(snapshot.run.ref, patch.reconcileBackoffUntil);

  return { status: "applied", reason: `standalone_transition:${action.to}` };
}

/**
 * If a transition's patch sets reconcileBackoffUntil to a future time, schedule
 * a delayed reconcile job to fire when the backoff expires. This is what makes
 * the FAILED→QUEUED auto-retry actually wait the backoff duration before
 * decideQueued runs (instead of waiting for the 5-min resync sweep).
 */
async function scheduleBackoffReconcile(
  ref: WorldSnapshot["run"]["ref"],
  backoffUntil: unknown,
): Promise<void> {
  if (!(backoffUntil instanceof Date)) return;
  const delayMs = backoffUntil.getTime() - Date.now();
  if (delayMs <= 0) return;
  await enqueueReconcile(ref, { reason: "backoff_expired", delayMs });
}

async function applyPatchStatus(
  action: Extract<RepoAction, { kind: "patchStatus" }>,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "repo") {
    return { status: "error", reason: "patchStatus_on_non_repo", error: new Error("not repo") };
  }
  const id = snapshot.run.ref.id;
  const version = snapshot.run.status.updatedAt;
  const casResult = await casUpdate(
    "tasks",
    id,
    version,
    action.statusPatch as Record<string, unknown>,
  );
  if (casResult === "stale") return { status: "stale", reason: "cas_failed_patch" };
  return { status: "applied", reason: action.reason };
}

function tableForKind(
  kind: "repo" | "standalone" | "pr-review" | "persistent-agent",
): "tasks" | "workflow_runs" | "pr_reviews" | "persistent_agents" {
  switch (kind) {
    case "repo":
      return "tasks";
    case "pr-review":
      return "pr_reviews";
    case "persistent-agent":
      return "persistent_agents";
    case "standalone":
    default:
      return "workflow_runs";
  }
}

async function applyClearControlIntent(snapshot: WorldSnapshot): Promise<ExecuteOutcome> {
  const id = snapshot.run.ref.id;
  const version = snapshot.run.status.updatedAt;
  const casResult = await casUpdate(tableForKind(snapshot.run.kind), id, version, {
    controlIntent: null,
  });
  if (casResult === "stale") return { status: "stale", reason: "cas_failed_clear_intent" };
  return { status: "applied", reason: "cleared_control_intent" };
}

async function applyDeferWithBackoff(
  untilMs: number,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  const id = snapshot.run.ref.id;
  const version = snapshot.run.status.updatedAt;
  const casResult = await casUpdate(tableForKind(snapshot.run.kind), id, version, {
    reconcileBackoffUntil: new Date(untilMs),
    reconcileAttempts: snapshot.run.status.reconcileAttempts + 1,
  });
  if (casResult === "stale") {
    return { status: "stale", reason: "cas_failed_defer_backoff" };
  }
  return { status: "applied", reason: "backoff_written" };
}

async function applyRequeueForAgent(
  action: Extract<RepoAction, { kind: "requeueForAgent" }>,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "repo") {
    return { status: "error", reason: "wrong_kind", error: new Error("not repo") };
  }
  const id = snapshot.run.ref.id;
  const version = snapshot.run.status.updatedAt;

  // Optional status patch first, CAS-gated.
  if (action.statusPatch && Object.keys(action.statusPatch).length > 0) {
    const casResult = await casUpdate(
      "tasks",
      id,
      version,
      action.statusPatch as Record<string, unknown>,
    );
    if (casResult === "stale") return { status: "stale", reason: "cas_failed_requeue_patch" };
  }

  // Unique jobId per enqueue. A stable jobId would be silently no-op'd by
  // BullMQ when a previous job for this task is in the completed/failed set,
  // permanently blocking re-execution after the first run. The worker's own
  // "skip if state != queued" defensive check (task-worker.ts:106) protects
  // against duplicate concurrent claims.
  const { taskQueue } = await import("../workers/task-worker.js");
  await taskQueue.add(
    "process-task",
    { taskId: id },
    {
      jobId: `${id}-reconcile-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      priority: snapshot.run.spec.priority ?? 100,
    },
  );
  return { status: "applied", reason: `requeued:${action.trigger}` };
}

async function applyEnqueueAgent(
  action: Extract<StandaloneAction, { kind: "enqueueAgent" }>,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "standalone") {
    return { status: "error", reason: "wrong_kind", error: new Error("not standalone") };
  }
  const id = snapshot.run.ref.id;
  // Unique jobId per enqueue — same reasoning as applyRequeueForAgent. The
  // workflow-worker's "skip if state != queued" check (workflow-worker.ts:276)
  // is the race guard.
  const { workflowRunQueue } = await import("../workers/workflow-worker.js");
  await workflowRunQueue.add(
    "process-workflow-run",
    { workflowRunId: id },
    { jobId: `${id}-reconcile-${Date.now()}-${Math.floor(Math.random() * 1000)}` },
  );
  return { status: "applied", reason: `enqueued:${action.trigger}` };
}

async function applyResumeAgent(
  action: Extract<RepoAction, { kind: "resumeAgent" }>,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "repo") {
    return { status: "error", reason: "wrong_kind", error: new Error("not repo") };
  }
  const taskId = snapshot.run.ref.id;
  const status = snapshot.run.status;
  const prLabel = inferPrLabel(status.prUrl);
  const { prompt, trigger, jobSuffix, freshSession } = buildResumeContext(action.resumeReason, {
    prLabel,
    reviewComments: status.prReviewComments ?? "",
  });

  // Two-step transition matches the existing pr-watcher behavior so the UI
  // briefly sees NEEDS_ATTENTION (signaling the auto-resume) before QUEUED.
  try {
    if (status.state !== TaskState.NEEDS_ATTENTION) {
      await taskService.transitionTask(
        taskId,
        TaskState.NEEDS_ATTENTION,
        trigger,
        prompt.slice(0, 200),
      );
    }
    await taskService.transitionTask(taskId, TaskState.QUEUED, `auto_resume_${jobSuffix}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Invalid state transition") || msg.includes("StateRace")) {
      return { status: "stale", reason: msg };
    }
    return { status: "error", reason: msg, error: err };
  }

  const { taskQueue } = await import("../workers/task-worker.js");
  await taskQueue.add(
    "process-task",
    {
      taskId,
      resumeSessionId: freshSession ? undefined : (status.sessionId ?? undefined),
      resumePrompt: prompt,
      restartFromBranch: !!status.prUrl,
    },
    { jobId: `${taskId}-${jobSuffix}-${Date.now()}` },
  );
  return { status: "applied", reason: `resume:${action.resumeReason}` };
}

async function applyLaunchReview(snapshot: WorldSnapshot): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "repo") {
    return { status: "error", reason: "wrong_kind", error: new Error("not repo") };
  }
  const taskId = snapshot.run.ref.id;
  const { launchReview } = await import("./review-service.js");
  try {
    await launchReview(taskId);
    return { status: "applied", reason: "review_launched" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", reason: msg, error: err };
  }
}

async function applyAutoMergePr(snapshot: WorldSnapshot): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "repo") {
    return { status: "error", reason: "wrong_kind", error: new Error("not repo") };
  }
  const taskId = snapshot.run.ref.id;
  const status = snapshot.run.status;
  const spec = snapshot.run.spec;
  if (!status.prUrl) {
    return { status: "skipped", reason: "no_pr_url" };
  }
  const parsed = parsePrUrl(status.prUrl);
  if (!parsed) return { status: "skipped", reason: "unparseable_pr_url" };

  const { getGitPlatformForRepo } = await import("./git-token-service.js");
  const platformResult = await getGitPlatformForRepo(spec.repoUrl, {}).catch(() => null);
  if (!platformResult) {
    return { status: "error", reason: "no_platform", error: new Error("git platform unavailable") };
  }
  const { platform, ri } = platformResult;
  try {
    await platform.mergePullRequest(ri, parsed.prNumber, "squash");
  } catch (err) {
    const cooldown = await handleGithubWriteBlock(snapshot, err);
    if (cooldown) return cooldown;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, taskId, prNumber: parsed.prNumber }, "auto-merge failed");
    return { status: "error", reason: `merge_failed:${msg}`, error: err };
  }

  // Persist PR state then transition. CAS guards both writes.
  const version = status.updatedAt;
  const casResult = await casUpdate("tasks", taskId, version, {
    prState: "merged",
  });
  if (casResult === "stale") return { status: "stale", reason: "cas_failed_post_merge" };

  try {
    await taskService.transitionTask(
      taskId,
      TaskState.COMPLETED,
      "auto_merged",
      `${parsed.platform === "gitlab" ? "MR" : "PR"} #${parsed.prNumber} auto-merged`,
    );
    return { status: "applied", reason: "auto_merged" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Invalid state transition") || msg.includes("StateRace")) {
      return { status: "stale", reason: msg };
    }
    return { status: "error", reason: msg, error: err };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface ResumeContext {
  prompt: string;
  trigger: string;
  jobSuffix: string;
  freshSession: boolean;
}

function buildResumeContext(
  reason: "ci_failure" | "conflicts" | "review",
  ctx: { prLabel: string; reviewComments: string },
): ResumeContext {
  switch (reason) {
    case "conflicts":
      return {
        prompt: `Your ${ctx.prLabel} has merge conflicts with the base branch. Please:\n1. Run \`git fetch origin && git rebase origin/main\`\n2. Resolve any conflicts\n3. Run the tests to make sure everything still works\n4. Force-push: \`git push --force-with-lease\``,
        trigger: "merge_conflicts",
        jobSuffix: "conflicts",
        freshSession: true,
      };
    case "ci_failure":
      return {
        prompt: `CI checks are failing on your ${ctx.prLabel}. Investigate which checks failed (use \`gh pr checks\`), fix the issues, and push the fixes.`,
        trigger: "ci_failing",
        jobSuffix: "ci-fix",
        freshSession: false,
      };
    case "review":
      return {
        prompt: `A reviewer requested changes on the ${ctx.prLabel}. Please address the following feedback:\n\n${ctx.reviewComments || "(no comment text captured — use \`gh pr view --comments\` to read the review)"}`,
        trigger: "review_changes_requested",
        jobSuffix: "review",
        freshSession: false,
      };
  }
}

function inferPrLabel(prUrl: string | null): string {
  if (!prUrl) return "PR";
  return prUrl.includes("gitlab") ? "MR" : "PR";
}

async function publishStandaloneStateChange(
  runId: string,
  workflowId: string,
  fromState: WorkflowRunState,
  toState: WorkflowRunState,
): Promise<void> {
  const { publishWorkflowRunEvent } = await import("./event-bus.js");
  await publishWorkflowRunEvent({
    type: "workflow_run:state_changed",
    workflowRunId: runId,
    workflowId,
    fromState,
    toState,
    timestamp: new Date().toISOString(),
  });

  const webhookEventMap: Partial<Record<WorkflowRunState, string>> = {
    [WorkflowRunState.RUNNING]: "workflow_run.started",
    [WorkflowRunState.COMPLETED]: "workflow_run.completed",
    [WorkflowRunState.FAILED]: "workflow_run.failed",
  };
  const webhookEvent = webhookEventMap[toState];
  if (!webhookEvent) return;

  const [workflowService, webhookWorker] = await Promise.all([
    import("./workflow-service.js"),
    import("../workers/webhook-worker.js"),
  ]);
  const [run, workflow] = await Promise.all([
    workflowService.getWorkflowRun(runId),
    workflowService.getWorkflow(workflowId),
  ]);
  if (!run || !workflow) return;

  const durationMs =
    run.startedAt && run.finishedAt
      ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
      : run.startedAt
        ? Date.now() - new Date(run.startedAt).getTime()
        : undefined;

  await webhookWorker.enqueueWebhookEvent(webhookEvent as never, {
    runId: run.id,
    workflowId: workflow.id,
    workflowName: workflow.name,
    state: run.state,
    fromState,
    params: run.params ?? null,
    output: run.output ?? null,
    costUsd: run.costUsd ?? undefined,
    inputTokens: run.inputTokens ?? undefined,
    outputTokens: run.outputTokens ?? undefined,
    modelUsed: run.modelUsed ?? undefined,
    errorMessage: run.errorMessage ?? undefined,
    retryCount: run.retryCount,
    durationMs,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  });
}

// ── CAS helpers ─────────────────────────────────────────────────────────────

/**
 * Millisecond-precision `updated_at` comparison — the ONE way every CAS guard
 * in this file must compare versions. Postgres `timestamptz` columns store
 * microseconds, but JavaScript's Date type only carries milliseconds — so a
 * JS-side `eq(updated_at, version)` against a row whose updated_at was set by
 * PG's `now()`/`defaultNow()` (microsecond precision) will silently never
 * match, leaving the row permanently "stale" to the executor. We truncate
 * both sides to milliseconds so the round-trip is symmetric. JS-originated
 * writes are already ms-precision so this is exactly the comparison we want
 * everywhere.
 */
function updatedAtMatches(column: SQLWrapper, version: Date): SQL {
  return sql`date_trunc('milliseconds', ${column})
      = date_trunc('milliseconds', ${version.toISOString()}::timestamptz)`;
}

async function casUpdate(
  table: "tasks" | "workflow_runs" | "pr_reviews" | "persistent_agents",
  id: string,
  version: Date,
  patch: Record<string, unknown>,
): Promise<"applied" | "stale"> {
  const payload = { ...patch, updatedAt: new Date() };
  if (table === "tasks") {
    const rows = await db
      .update(tasks)
      .set(payload)
      .where(and(eq(tasks.id, id), updatedAtMatches(tasks.updatedAt, version)))
      .returning({ id: tasks.id });
    return rows.length > 0 ? "applied" : "stale";
  }
  if (table === "pr_reviews") {
    const rows = await db
      .update(prReviews)
      .set(payload)
      .where(and(eq(prReviews.id, id), updatedAtMatches(prReviews.updatedAt, version)))
      .returning({ id: prReviews.id });
    return rows.length > 0 ? "applied" : "stale";
  }
  if (table === "persistent_agents") {
    const rows = await db
      .update(persistentAgents)
      .set(payload)
      .where(
        and(eq(persistentAgents.id, id), updatedAtMatches(persistentAgents.updatedAt, version)),
      )
      .returning({ id: persistentAgents.id });
    return rows.length > 0 ? "applied" : "stale";
  }
  const rows = await db
    .update(workflowRuns)
    .set(payload)
    .where(and(eq(workflowRuns.id, id), updatedAtMatches(workflowRuns.updatedAt, version)))
    .returning({ id: workflowRuns.id });
  return rows.length > 0 ? "applied" : "stale";
}

// ── GitHub write cooldown ───────────────────────────────────────────────────
// When a content-creating GitHub write (auto-merge, auto-submit-review) is
// blocked by a rate limit or an auth/permission failure, we must stop EVERY
// reconcile producer (event-driven, pr-watcher, resync) from re-issuing that
// write until a deadline — not just the one delayed retry job. We do that by
// persisting `reconcileBackoffUntil` on the run: the pure decision functions
// already short-circuit to a noop while it is in the future, so every producer
// becomes harmless. A single delayed reconcile is scheduled for the deadline.

const GITHUB_RATE_LIMIT_MIN_BACKOFF_MS = 60_000; // GitHub requires >=60s when no Retry-After
const GITHUB_RATE_LIMIT_MAX_BACKOFF_MS = 30 * 60_000; // cap exponential growth

function githubCooldownDeadlineMs(
  failure: GitHubFailure,
  attempts: number,
  nowMs: number,
): { untilMs: number; incrementAttempts: boolean } {
  switch (failure.kind) {
    case "primary_rate_limit":
      // Primary quota: wait until the reset, not the generic 60s floor.
      return {
        untilMs: failure.resetAtMs ?? nowMs + GITHUB_RATE_LIMIT_MIN_BACKOFF_MS,
        incrementAttempts: false,
      };
    case "secondary_rate_limit": {
      if (failure.retryAfterMs != null) {
        return {
          untilMs: nowMs + Math.max(failure.retryAfterMs, GITHUB_RATE_LIMIT_MIN_BACKOFF_MS),
          incrementAttempts: false,
        };
      }
      // No Retry-After: bounded exponential from 60s, escalating with attempts.
      const backoff = Math.min(
        GITHUB_RATE_LIMIT_MAX_BACKOFF_MS,
        GITHUB_RATE_LIMIT_MIN_BACKOFF_MS * 2 ** Math.min(attempts, 6),
      );
      return {
        untilMs: nowMs + backoff + Math.floor(Math.random() * 5_000),
        incrementAttempts: true,
      };
    }
    case "auth":
    case "permission":
      // Retrying the same credential/permission is futile — hold for a long
      // window rather than looping. The classified errorMessage drives the
      // GitHub credential/scope recovery UI.
      return {
        untilMs: nowMs + parseIntEnv("OPTIO_GITHUB_AUTH_COOLDOWN_MS", 60 * 60_000),
        incrementAttempts: false,
      };
  }
}

/**
 * Persist a monotonic (never-shortening) GitHub cooldown on a repo task or
 * pr-review run, bumping updated_at so any in-flight CAS write becomes stale and
 * cannot perform a concurrent GitHub write. `GREATEST` guarantees two concurrent
 * failures keep the later deadline.
 */
async function persistGithubCooldown(
  kind: "repo" | "pr-review",
  id: string,
  untilMs: number,
  opts: { incrementAttempts: boolean; errorMessage: string },
): Promise<void> {
  const until = new Date(untilMs);
  if (kind === "repo") {
    const set: Record<string, unknown> = {
      reconcileBackoffUntil: sql`GREATEST(COALESCE(${tasks.reconcileBackoffUntil}, ${until}), ${until})`,
      errorMessage: opts.errorMessage,
      updatedAt: new Date(),
    };
    if (opts.incrementAttempts) set.reconcileAttempts = sql`${tasks.reconcileAttempts} + 1`;
    await db.update(tasks).set(set).where(eq(tasks.id, id));
    return;
  }
  const set: Record<string, unknown> = {
    reconcileBackoffUntil: sql`GREATEST(COALESCE(${prReviews.reconcileBackoffUntil}, ${until}), ${until})`,
    errorMessage: opts.errorMessage,
    updatedAt: new Date(),
  };
  if (opts.incrementAttempts) set.reconcileAttempts = sql`${prReviews.reconcileAttempts} + 1`;
  await db.update(prReviews).set(set).where(eq(prReviews.id, id));
}

/**
 * If `err` is a GitHub write block (rate limit / auth / permission), persist a
 * cooldown, schedule a single delayed wake, and return an `applied` outcome so
 * the worker does NOT additionally fast-retry. Returns null for transient or
 * non-GitHub errors so the caller falls through to its normal error handling.
 */
async function handleGithubWriteBlock(
  snapshot: WorldSnapshot,
  err: unknown,
): Promise<ExecuteOutcome | null> {
  const failure = classifyGitHubFailure(err);
  if (!failure) return null;
  const run = snapshot.run;
  if (run.kind !== "repo" && run.kind !== "pr-review") return null;
  const nowMs = Date.now();
  const attempts = run.status.reconcileAttempts ?? 0;
  const { untilMs, incrementAttempts } = githubCooldownDeadlineMs(failure, attempts, nowMs);
  await persistGithubCooldown(run.kind, run.ref.id, untilMs, {
    incrementAttempts,
    errorMessage: err instanceof Error ? err.message : String(err),
  });
  await enqueueReconcile(run.ref, {
    reason: `github_cooldown:${failure.kind}`,
    delayMs: Math.max(0, untilMs - nowMs),
  });
  logger.warn(
    { runId: run.ref.id, kind: failure.kind, untilMs },
    "GitHub write blocked — persisted reconcile cooldown",
  );
  return { status: "applied", reason: `github_cooldown:${failure.kind}` };
}

// ── PR Review applicators ──────────────────────────────────────────────────

async function applyPrReviewTransition(
  action: Extract<PrReviewAction, { kind: "transition" }>,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "pr-review") {
    return { status: "error", reason: "wrong_kind", error: new Error("not pr-review") };
  }
  const id = snapshot.run.ref.id;
  const version = snapshot.run.status.updatedAt;
  const patch: Record<string, unknown> = {
    reconcileBackoffUntil: null,
    reconcileAttempts: 0,
    ...(action.statusPatch ?? {}),
  };
  if (action.clearControlIntent) patch.controlIntent = null;

  const casResult = await casUpdate("pr_reviews", id, version, patch);
  if (casResult === "stale") return { status: "stale", reason: "cas_failed_pre_transition" };

  const { transitionPrReview } = await import("./pr-review-service.js");
  const result = await transitionPrReview(id, action.to, action.trigger, {
    message: action.reason,
  });
  if (!result) return { status: "stale", reason: "transition_not_applied" };

  return { status: "applied", reason: `pr_review_transition:${action.to}` };
}

async function applyLaunchReviewRun(
  action: Extract<PrReviewAction, { kind: "launchReviewRun" }>,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "pr-review") {
    return { status: "error", reason: "wrong_kind", error: new Error("not pr-review") };
  }
  const prReviewId = snapshot.run.ref.id;
  const { enqueueReviewRun } = await import("./pr-review-service.js");
  try {
    await enqueueReviewRun(prReviewId, action.runKind, {
      prompt: action.prompt,
      resumeSessionId: action.resumeSessionId,
    });
    return { status: "applied", reason: `launch_${action.runKind}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", reason: msg, error: err };
  }
}

async function applySubmitReview(snapshot: WorldSnapshot): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "pr-review") {
    return { status: "error", reason: "wrong_kind", error: new Error("not pr-review") };
  }
  const prReviewId = snapshot.run.ref.id;
  const { submitReview } = await import("./pr-review-service.js");
  try {
    await submitReview(prReviewId);
    return { status: "applied", reason: "auto_submitted" };
  } catch (err) {
    const cooldown = await handleGithubWriteBlock(snapshot, err);
    if (cooldown) return cooldown;
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", reason: msg, error: err };
  }
}

async function applyMarkStale(snapshot: WorldSnapshot): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "pr-review") {
    return { status: "error", reason: "wrong_kind", error: new Error("not pr-review") };
  }
  const prReviewId = snapshot.run.ref.id;
  const { markStale } = await import("./pr-review-service.js");
  const result = await markStale(prReviewId);
  if (!result) return { status: "skipped", reason: "not_in_ready_state" };
  return { status: "applied", reason: "marked_stale" };
}

async function applyPrReviewPatchStatus(
  action: Extract<PrReviewAction, { kind: "patchStatus" }>,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "pr-review") {
    return { status: "error", reason: "wrong_kind", error: new Error("not pr-review") };
  }
  const id = snapshot.run.ref.id;
  const version = snapshot.run.status.updatedAt;
  const casResult = await casUpdate(
    "pr_reviews",
    id,
    version,
    action.statusPatch as Record<string, unknown>,
  );
  if (casResult === "stale") return { status: "stale", reason: "cas_failed_patch" };
  return { status: "applied", reason: action.reason };
}

// Prevent TS unused-import warning on PrReviewState since it's only used at type level.
void PrReviewState;
void PersistentAgentState;

// ── Persistent Agent applicators ───────────────────────────────────────────

async function applyPersistentAgentTransition(
  action: Extract<PersistentAgentAction, { kind: "transition" }>,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "persistent-agent") {
    return { status: "error", reason: "wrong_kind", error: new Error("not persistent-agent") };
  }
  const id = snapshot.run.ref.id;
  const version = snapshot.run.status.updatedAt;
  const patch: Record<string, unknown> = {
    state: action.to,
    reconcileBackoffUntil: null,
    reconcileAttempts: 0,
    ...(action.statusPatch ?? {}),
  };
  if (action.clearControlIntent) patch.controlIntent = null;

  const casResult = await casUpdate("persistent_agents", id, version, patch);
  if (casResult === "stale") return { status: "stale", reason: "cas_failed_pa_transition" };

  const fromState = snapshot.run.status.state;
  const { publishPersistentAgentEvent } = await import("./event-bus.js");
  await publishPersistentAgentEvent({
    type: "persistent_agent:state_changed",
    agentId: id,
    agentSlug: snapshot.run.spec.slug,
    fromState,
    toState: action.to,
    trigger: action.trigger,
    timestamp: new Date().toISOString(),
    errorMessage: (action.statusPatch?.errorMessage as string | null | undefined) ?? undefined,
  });

  await scheduleBackoffReconcile(snapshot.run.ref, patch.reconcileBackoffUntil);
  // Re-enqueue immediately so the reconciler observes the new state and can
  // act again — e.g., IDLE with pending messages should advance to QUEUED on
  // the next pass. Without this, transitions land but the loop stalls.
  await enqueueReconcile(snapshot.run.ref, { reason: `post_transition_${action.to}` });
  return { status: "applied", reason: `pa_transition:${action.to}` };
}

async function applyEnqueueTurn(
  action: Extract<PersistentAgentAction, { kind: "enqueueTurn" }>,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "persistent-agent") {
    return { status: "error", reason: "wrong_kind", error: new Error("not persistent-agent") };
  }
  const agentId = snapshot.run.ref.id;
  const { persistentAgentTurnQueue } = await import("../workers/persistent-agent-worker.js");
  await persistentAgentTurnQueue.add(
    "process-persistent-agent-turn",
    { agentId, wakeSource: action.wakeSource },
    { jobId: `${agentId}-turn-${Date.now()}-${Math.floor(Math.random() * 1000)}` },
  );
  return { status: "applied", reason: `enqueue_turn:${action.trigger}` };
}

async function applyPersistentAgentPatchStatus(
  action: Extract<PersistentAgentAction, { kind: "patchStatus" }>,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  if (snapshot.run.kind !== "persistent-agent") {
    return { status: "error", reason: "wrong_kind", error: new Error("not persistent-agent") };
  }
  const id = snapshot.run.ref.id;
  const version = snapshot.run.status.updatedAt;
  const casResult = await casUpdate(
    "persistent_agents",
    id,
    version,
    action.statusPatch as Record<string, unknown>,
  );
  if (casResult === "stale") return { status: "stale", reason: "cas_failed_pa_patch" };
  return { status: "applied", reason: action.reason };
}

// Re-export for convenience.
export { TaskState, WorkflowRunState };
