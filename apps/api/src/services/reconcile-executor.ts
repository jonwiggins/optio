import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { updatedAtMatches } from "../utils/pg-timestamp.js";
import { db } from "../db/client.js";
import {
  tasks,
  workflowRuns,
  prReviews,
  prReviewRuns,
  persistentAgents,
  persistentAgentTurns,
} from "../db/schema.js";
import type {
  Action,
  CommonReattach,
  CommonRequeueRun,
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
  PrReviewRunState,
  attachJobId,
  parsePrUrl,
  parseIntEnv,
  changeRequestAbbrev,
  resolveRepoPlatform,
} from "@optio/shared";
import * as taskService from "./task-service.js";
import { enqueueReconcile } from "./reconcile-queue.js";
import { resetRunAttempt, stopPreviousAttempt } from "./run-log-service.js";
import { classifyGitHubFailure, type GitHubFailure } from "./git-platform/github.js";
import {
  GitLabNotReadyError,
  classifyGitLabFailure,
  mergeStatusNeedsPerson,
  mergeStatusPending,
} from "./git-platform/gitlab.js";
import { autoMergeSettingBlocker, pullRequestBlocker } from "./auto-merge-guard.js";
import { loadResumeFacts, type ResumeFacts } from "./resume-facts.js";
import { ciFailurePrompt, rebaseTarget } from "./resume-prompts.js";
import { auditAutoMerge } from "./audit.js";
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

      case "reattach":
        return await applyReattach(action, snapshot);

      case "requeueRun":
        return await applyRequeueRun(action, snapshot);

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
  const fields: Record<string, unknown> = {
    reconcileBackoffUntil: null,
    reconcileAttempts: 0,
    ...(action.statusPatch ?? {}),
    ...(action.clearControlIntent ? { controlIntent: null } : {}),
  };
  // The one Job-run transition: CAS on the observed state and version, then
  // the WS event, the outbound webhook, and stopping a failed local run's
  // terminal. This pass already reconciles the run, so no wake.
  const { transitionWorkflowRunCas } = await import("./workflow-service.js");
  const row = await transitionWorkflowRunCas(
    id,
    snapshot.run.status.state,
    action.to,
    fields as Parameters<typeof transitionWorkflowRunCas>[3],
    { version: snapshot.run.status.updatedAt, wakeReconciler: false },
  );
  if (!row) return { status: "stale", reason: "cas_failed_standalone_transition" };

  await scheduleBackoffReconcile(snapshot.run.ref, fields.reconcileBackoffUntil);
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
  const prLabel = inferPrLabel(status.prUrl, snapshot.run.spec.repoUrl);
  // The MR's target branch and the failed jobs' logs (resume-facts.ts).
  // They take seconds to read: a task that moved on meanwhile (another pass
  // already resumed it) is stale, not resumed twice.
  const facts = await loadResumeFacts(snapshot, action.resumeReason);
  if (!(await versionStillMatches("tasks", taskId, status.updatedAt))) {
    return { status: "stale", reason: "cas_failed_resume" };
  }
  const { prompt, trigger, jobSuffix, freshSession } = buildResumeContext(action.resumeReason, {
    prLabel,
    reviewComments: status.prReviewComments ?? "",
    ...facts,
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
  // Only a setting a person confirmed merges by itself (auto-merge-guard.ts).
  const notConfirmed = autoMergeSettingBlocker(snapshot);
  if (notConfirmed) return { status: "skipped", reason: notConfirmed };
  if (!status.prUrl) {
    return { status: "skipped", reason: "no_pr_url" };
  }
  const parsed = parsePrUrl(status.prUrl);
  if (!parsed) return { status: "skipped", reason: "unparseable_pr_url" };
  const headSha = snapshot.pr?.headSha;
  if (!headSha) return { status: "skipped", reason: "missing_pr_head" };

  const { getGitPlatformForRepo } = await import("./git-token-service.js");
  const platformResult = await getGitPlatformForRepo(spec.repoUrl, {}).catch(() => null);
  if (!platformResult) {
    return { status: "error", reason: "no_platform", error: new Error("git platform unavailable") };
  }
  const { platform, ri } = platformResult;
  try {
    // Re-read immediately before the write: the head or CI may have changed
    // since the decision. Never turn an API error into permission to merge.
    const pr = await platform.getPullRequest(ri, parsed.prNumber);
    if (pr.headSha !== headSha) return { status: "stale", reason: "pr_head_changed" };
    if (pr.merged || pr.state !== "open") {
      return { status: "stale", reason: "pr_state_changed" };
    }
    // GitLab is still checking the MR (right after a push): ask again later.
    if (mergeStatusPending(pr.mergeStatus)) {
      return await autoMergeNotReady(snapshot, parsed.prNumber, pr.mergeStatus);
    }
    // Not a draft, no conflict, and no reviewer asking for changes.
    const blocker = pullRequestBlocker(pr, await platform.getReviews(ri, parsed.prNumber));
    if (blocker === "pr_not_mergeable" && platform.type === "gitlab") {
      return await autoMergeNotReady(snapshot, parsed.prNumber, pr.mergeStatus);
    }
    if (blocker) return { status: "skipped", reason: blocker };
    const { determineCheckStatus } = await import("../workers/pr-watcher-worker.js");
    const checksStatus = determineCheckStatus(await platform.getCIChecks(ri, headSha));
    if (checksStatus === "pending" || checksStatus === "failing") {
      return { status: "stale", reason: `pr_checks_${checksStatus}` };
    }

    // Checks can take a moment to register after a push. Keep supporting
    // repos without CI, but require a second empty read at least 60s later
    // for this exact head. Redis shares the observation across replicas and
    // restarts; expiry just makes us wait again. CodeCommit has no native CI.
    if (checksStatus === "none" && platform.type !== "codecommit") {
      const { getRedisClient } = await import("./event-bus.js");
      const redis = getRedisClient();
      const key = `optio:auto-merge:no-checks:${taskId}:${parsed.prNumber}:${headSha}`;
      const now = Date.now();
      await redis.set(key, String(now), "EX", 3600, "NX");
      const observedAt = await redis.get(key);
      const age = observedAt === null ? 0 : now - Number(observedAt);
      if (!Number.isFinite(age) || age < 60_000) {
        await enqueueReconcile(snapshot.run.ref, {
          reason: "auto_merge_waiting_for_checks",
          delayMs: Number.isFinite(age) ? Math.max(1, 60_000 - age) : 60_000,
        });
        return { status: "skipped", reason: "auto_merge_waiting_for_checks" };
      }
    }

    // The platform enforces this SHA atomically if another push races the
    // final read. Manual merges omit it and retain their existing behavior.
    await platform.mergePullRequest(ri, parsed.prNumber, "squash", headSha);
  } catch (err) {
    if (err instanceof GitLabNotReadyError) {
      return await autoMergeNotReady(snapshot, parsed.prNumber, err.mergeStatus);
    }
    const cooldown = await handleGithubWriteBlock(snapshot, err);
    if (cooldown) return cooldown;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, taskId, prNumber: parsed.prNumber }, "auto-merge failed");
    return { status: "error", reason: `merge_failed:${msg}`, error: err };
  }
  // The audit trail names the merge and the confirmation it relied on (docs/audit.md).
  void auditAutoMerge({ taskId, prUrl: status.prUrl, prNumber: parsed.prNumber });

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
  ctx: { prLabel: string; reviewComments: string } & Partial<ResumeFacts>,
): ResumeContext {
  switch (reason) {
    case "conflicts":
      return {
        // Onto the MR's target branch, not a fixed origin/main (resume-facts.ts).
        prompt: `Your ${ctx.prLabel} has merge conflicts with the base branch. Please:\n1. Run \`git fetch origin && git rebase ${rebaseTarget(ctx.targetBranch ?? "main")}\`\n2. Resolve any conflicts\n3. Run the tests to make sure everything still works\n4. Force-push: \`git push --force-with-lease\``,
        trigger: "merge_conflicts",
        jobSuffix: "conflicts",
        freshSession: true,
      };
    case "ci_failure":
      return {
        // With the failed jobs' names and log tails when GitLab gave them.
        prompt: ctx.ciFailure
          ? ciFailurePrompt(ctx.prLabel, ctx.ciFailure)
          : `CI checks are failing on your ${ctx.prLabel}. Investigate which checks failed (use \`${ctx.prLabel === "MR" ? "glab ci status" : "gh pr checks"}\`), fix the issues, and push the fixes.`,
        trigger: "ci_failing",
        jobSuffix: "ci-fix",
        freshSession: false,
      };
    case "review":
      return {
        prompt: `A reviewer requested changes on the ${ctx.prLabel}. Please address the following feedback:\n\n${ctx.reviewComments || `(no comment text captured — use \`${ctx.prLabel === "MR" ? "glab mr view --comments" : "gh pr view --comments"}\` to read the review)`}`,
        trigger: "review_changes_requested",
        jobSuffix: "review",
        freshSession: false,
      };
  }
}

/** "MR" for a merge request (its URL, else the repo's platform), "PR" otherwise. */
function inferPrLabel(prUrl: string | null, repoUrl: string): string {
  return changeRequestAbbrev(prUrl, { platform: resolveRepoPlatform(repoUrl) });
}

// ── Run attachment (docs/plans/scale-out.md §2) ──────────────────────────────

/**
 * The run's agent goes on in its pod and nobody streams it: hand it to an
 * instance through the kind's queue. Gated on the snapshot's version (a
 * check that writes nothing, so a worker finishing the run concurrently
 * never loses its own CAS to this); the job id names the attachment's
 * expiry, so every pass that saw the same expiry asks for one job, and the
 * handler's claim CAS makes a stale delivery a no-op.
 */
async function applyReattach(
  action: CommonReattach,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  const table = tableForKind(snapshot.run.kind);
  if (!(await versionStillMatches(table, snapshot.run.ref.id, snapshot.run.status.updatedAt))) {
    return { status: "stale", reason: "cas_failed_reattach" };
  }
  const jobOpts = {
    jobId: attachJobId(action.runId, action.attempt),
    // Gone once done, so the id frees up for the next expiry's job.
    removeOnComplete: true,
    removeOnFail: true,
  };
  switch (snapshot.run.kind) {
    case "repo": {
      const { taskQueue } = await import("../workers/task-worker.js");
      await taskQueue.add("attach-task", { taskId: action.runId }, jobOpts);
      break;
    }
    case "standalone": {
      const { workflowRunQueue } = await import("../workers/workflow-worker.js");
      await workflowRunQueue.add("attach-workflow-run", { workflowRunId: action.runId }, jobOpts);
      break;
    }
    case "pr-review": {
      const { prReviewRunQueue } = await import("../workers/pr-review-worker.js");
      await prReviewRunQueue.add("attach-pr-review-run", { runId: action.runId }, jobOpts);
      break;
    }
    case "persistent-agent": {
      const { persistentAgentTurnQueue } = await import("../workers/persistent-agent-worker.js");
      await persistentAgentTurnQueue.add(
        "attach-persistent-agent-turn",
        { agentId: snapshot.run.ref.id, turnId: action.runId },
        jobOpts,
      );
      break;
    }
  }
  return { status: "applied", reason: `reattach:${jobOpts.jobId}` };
}

/**
 * The instance setting the run up went away before its agent started: put
 * the run back where its kind's own retry puts it.
 */
async function applyRequeueRun(
  action: CommonRequeueRun,
  snapshot: WorldSnapshot,
): Promise<ExecuteOutcome> {
  const message = "The instance starting the run went away before its agent started; queued again.";
  const run = snapshot.run;
  const version = run.status.updatedAt;
  switch (run.kind) {
    case "repo":
      // provisioning → queued, as the worker's own provisioning retry does;
      // the transition wakes the reconciler, whose queued pass enqueues it.
      return applyRepoTransition(
        {
          kind: "transition",
          to: TaskState.QUEUED,
          statusPatch: { errorMessage: message },
          trigger: action.trigger,
          reason: action.reason,
        },
        snapshot,
      );
    case "standalone": {
      // running → failed → queued, as the worker's provisioning retry does,
      // without spending a retry: nothing ran. Only the first step is gated
      // on the version; the reconciler's own failed pass may win the second
      // (then the run is queued all the same).
      const { transitionWorkflowRunCas } = await import("./workflow-service.js");
      const failed = await transitionWorkflowRunCas(
        run.ref.id,
        WorkflowRunState.RUNNING,
        WorkflowRunState.FAILED,
        { errorMessage: message },
        { version, wakeReconciler: false },
      );
      if (!failed) return { status: "stale", reason: "cas_failed_requeue_run" };
      await transitionWorkflowRunCas(run.ref.id, WorkflowRunState.FAILED, WorkflowRunState.QUEUED, {
        errorMessage: null,
        finishedAt: null,
      });
      return { status: "applied", reason: `requeue_run:${action.trigger}` };
    }
    case "pr-review": {
      if (!action.runId) return { status: "skipped", reason: "requeue_run_without_run" };
      if (!(await versionStillMatches("pr_reviews", run.ref.id, version))) {
        return { status: "stale", reason: "cas_failed_requeue_run" };
      }
      const runId = action.runId;
      const { result: requeued, previous } = await db.transaction((tx) =>
        resetRunAttempt(tx, { kind: "review-run", id: runId }, async (fresh) => {
          const [row] = await tx
            .update(prReviewRuns)
            .set({
              state: PrReviewRunState.QUEUED,
              errorMessage: message,
              ...fresh,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(prReviewRuns.id, runId),
                inArray(prReviewRuns.state, [
                  PrReviewRunState.PROVISIONING,
                  PrReviewRunState.RUNNING,
                ]),
                isNull(prReviewRuns.execState),
              ),
            )
            .returning({ id: prReviewRuns.id });
          return row ?? null;
        }),
      );
      if (!requeued) return { status: "stale", reason: "review_run_moved_on" };
      stopPreviousAttempt(previous);
      const { prReviewRunQueue } = await import("../workers/pr-review-worker.js");
      await prReviewRunQueue.add(
        "process-pr-review-run",
        { runId: action.runId },
        { jobId: `${action.runId}-requeue-${Date.now()}`, priority: 10 },
      );
      return { status: "applied", reason: `requeue_run:${action.trigger}` };
    }
    case "persistent-agent": {
      if (!(await versionStillMatches("persistent_agents", run.ref.id, version))) {
        return { status: "stale", reason: "cas_failed_requeue_run" };
      }
      // The turn ends as an error that never ran; its messages were not
      // drained into it, so they wake the agent again.
      if (action.runId) {
        const paService = await import("./persistent-agent-service.js");
        const [open] = await db
          .select({ id: persistentAgentTurns.id })
          .from(persistentAgentTurns)
          .where(
            and(
              eq(persistentAgentTurns.id, action.runId),
              isNull(persistentAgentTurns.finishedAt),
              isNull(persistentAgentTurns.execState),
            ),
          );
        if (open) {
          await paService.haltPersistentAgentTurn({
            turnId: action.runId,
            haltReason: "error",
            errorMessage: message,
          });
        }
      }
      const { transitionPersistentAgentState } = await import("./persistent-agent-service.js");
      const moved = await transitionPersistentAgentState(
        run.ref.id,
        PersistentAgentState.IDLE,
        version,
        {},
        action.trigger,
      ).catch(() => false);
      if (!moved) return { status: "stale", reason: "cas_failed_requeue_run" };
      await enqueueReconcile(run.ref, { reason: "post_transition_idle" });
      return { status: "applied", reason: `requeue_run:${action.trigger}` };
    }
  }
}

/** The run's row is still at the snapshot's version (a CAS that writes nothing). */
async function versionStillMatches(
  table: "tasks" | "workflow_runs" | "pr_reviews" | "persistent_agents",
  id: string,
  version: Date,
): Promise<boolean> {
  const t =
    table === "tasks"
      ? tasks
      : table === "pr_reviews"
        ? prReviews
        : table === "persistent_agents"
          ? persistentAgents
          : workflowRuns;
  const rows = await db
    .update(t)
    .set({ updatedAt: sql`${t.updatedAt}` })
    .where(and(eq(t.id, id), updatedAtMatches(t.updatedAt, version)))
    .returning({ id: t.id });
  return rows.length > 0;
}

// ── CAS helpers ─────────────────────────────────────────────────────────────

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

/** How long auto-merge waits before asking GitLab again about an MR it won't merge yet. */
const MR_NOT_READY_RETRY_MS = 15_000;
/** How many such waits (≈ 5 min) before the task asks a person instead. */
const MR_NOT_READY_MAX_ATTEMPTS = 20;

/**
 * GitLab won't merge the MR yet — still checking it right after a push
 * (`detailed_merge_status` unchecked/checking), or a 405/406 that polling
 * didn't clear. Not a failure: wake again in 15 s, counted on
 * `reconcileAttempts`, and after `MR_NOT_READY_MAX_ATTEMPTS` hand the task
 * to a person (needs attention) with GitLab's status in the message, so an
 * MR that will never merge (conflicts, a blocking rule) doesn't spin forever.
 * A status only a person clears (an approval rule, unresolved threads, …)
 * goes to a person at once.
 */
async function autoMergeNotReady(
  snapshot: WorldSnapshot,
  prNumber: number,
  mergeStatus: string | undefined,
): Promise<ExecuteOutcome> {
  const run = snapshot.run;
  const attempts = run.status.reconcileAttempts ?? 0;
  const label = mergeStatus ?? "not mergeable";
  if (attempts >= MR_NOT_READY_MAX_ATTEMPTS || mergeStatusNeedsPerson(mergeStatus)) {
    try {
      await taskService.transitionTask(
        run.ref.id,
        TaskState.NEEDS_ATTENTION,
        "auto_merge_not_ready",
        `GitLab still won't merge MR !${prNumber} (${label}) — merge it by hand or fix what blocks it`,
      );
      return { status: "applied", reason: "auto_merge_not_ready_needs_attention" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "stale", reason: msg };
    }
  }
  await db
    .update(tasks)
    .set({ reconcileAttempts: sql`${tasks.reconcileAttempts} + 1` })
    .where(eq(tasks.id, run.ref.id));
  await enqueueReconcile(run.ref, {
    reason: "auto_merge_mr_not_ready",
    delayMs: MR_NOT_READY_RETRY_MS,
  });
  logger.debug(
    { taskId: run.ref.id, prNumber, mergeStatus, attempts: attempts + 1 },
    "auto-merge: GitLab MR not ready yet — retrying",
  );
  return { status: "skipped", reason: "auto_merge_mr_not_ready" };
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
 * If `err` is a GitHub (or GitLab) write block (rate limit / auth /
 * permission), persist a cooldown, schedule a single delayed wake, and return
 * an `applied` outcome so the worker does NOT additionally fast-retry. Returns
 * null for transient or non-platform errors so the caller falls through to
 * its normal error handling.
 */
async function handleGithubWriteBlock(
  snapshot: WorldSnapshot,
  err: unknown,
): Promise<ExecuteOutcome | null> {
  // A GitLab rate limit / token refusal holds the run the same way.
  const githubFailure = classifyGitHubFailure(err);
  const failure = githubFailure ?? classifyGitLabFailure(err);
  if (!failure) return null;
  const platform = githubFailure ? "github" : "gitlab";
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
    reason: `${platform}_cooldown:${failure.kind}`,
    delayMs: Math.max(0, untilMs - nowMs),
  });
  logger.warn(
    { runId: run.ref.id, kind: failure.kind, untilMs },
    `${platform === "github" ? "GitHub" : "GitLab"} write blocked — persisted reconcile cooldown`,
  );
  return { status: "applied", reason: `${platform}_cooldown:${failure.kind}` };
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
  const paService = await import("./persistent-agent-service.js");
  if (paService.stopsRunningTurn(fromState, action.to)) {
    await paService
      .stopOpenTurns(id)
      .catch((err) => logger.warn({ err, agentId: id }, "Failed to stop the agent's running turn"));
  }
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
