import { WorkflowRunState } from "../types/workflow.js";
import type {
  StandaloneAction,
  WorldSnapshot,
  StandaloneRunSpec,
  StandaloneRunStatus,
} from "./types.js";

/**
 * Pure decision function for Standalone Task runs (workflow_runs).
 *
 * Inputs: a fully-materialized WorldSnapshot describing the run and its
 * observable environment. Output: a single Action describing what the
 * executor should do. No I/O, no DB, no clock — the caller supplies `now`
 * on the snapshot.
 */
export function reconcileStandalone(snapshot: WorldSnapshot): StandaloneAction {
  if (snapshot.run.kind !== "standalone") {
    return {
      kind: "noop",
      reason: `reconcile-standalone called on ${snapshot.run.kind} run`,
    };
  }
  const run = snapshot.run;
  const spec: StandaloneRunSpec = run.spec;
  const status: StandaloneRunStatus = run.status;
  const nowMs = snapshot.now.getTime();

  // Backoff — caller should also filter these out, but double-check.
  if (status.reconcileBackoffUntil && status.reconcileBackoffUntil.getTime() > nowMs) {
    return { kind: "noop", reason: "reconcile_backoff_active" };
  }

  // Control intent takes precedence over observed state.
  const intentAction = interpretIntent(status, spec);
  if (intentAction) return intentAction;

  // If any upstream world read failed, defer rather than act on stale data.
  if (snapshot.readErrors.length > 0) {
    return {
      kind: "deferWithBackoff",
      untilMs: nowMs + jitteredBackoff(status.reconcileAttempts),
      reason: `world_read_failed:${snapshot.readErrors[0].source}`,
    };
  }

  switch (status.state) {
    case WorkflowRunState.QUEUED:
      return decideQueued(snapshot);
    case WorkflowRunState.RUNNING:
      return decideRunning(snapshot);
    case WorkflowRunState.COMPLETED:
      return { kind: "noop", reason: "terminal_completed" };
    case WorkflowRunState.FAILED:
      return decideFailed(snapshot);
    default:
      return {
        kind: "noop",
        reason: `unknown_state:${status.state as string}`,
      };
  }
}

function decideFailed(snapshot: WorldSnapshot): StandaloneAction {
  if (snapshot.run.kind !== "standalone") {
    return { kind: "noop", reason: "wrong_kind" };
  }
  const { spec, status } = snapshot.run;
  // Auto-retry with exponential backoff. Setting reconcileBackoffUntil in
  // the patch defers the next reconcile until the backoff window expires;
  // the executor schedules a delayed reconcile to fire at that time.
  if (status.retryCount < spec.maxRetries) {
    const backoffMs = retryBackoff(status.retryCount);
    return {
      kind: "transition",
      to: WorkflowRunState.QUEUED,
      statusPatch: {
        retryCount: status.retryCount + 1,
        errorMessage: null,
        reconcileBackoffUntil: new Date(snapshot.now.getTime() + backoffMs),
        // Clear stale finishedAt so decideRunning doesn't short-circuit
        // the retry to COMPLETED when the worker advances to RUNNING.
        finishedAt: null,
      },
      trigger: "auto_retry",
      reason: `auto_retry_${status.retryCount + 1}/${spec.maxRetries}`,
    };
  }
  return { kind: "noop", reason: "failed_no_retry_intent" };
}

function retryBackoff(retryCount: number): number {
  // 5s, 10s, 20s, 40s ... + jitter. Matches workflow-worker's prior policy.
  const base = 5_000 * Math.pow(2, retryCount);
  return base + Math.floor(Math.random() * 3_000);
}

function interpretIntent(
  status: StandaloneRunStatus,
  spec: StandaloneRunSpec,
): StandaloneAction | null {
  if (!status.controlIntent) return null;

  switch (status.controlIntent) {
    case "cancel": {
      if (status.state === WorkflowRunState.COMPLETED || status.state === WorkflowRunState.FAILED) {
        return { kind: "clearControlIntent", reason: "intent_cancel_on_terminal" };
      }
      return {
        kind: "transition",
        to: WorkflowRunState.FAILED,
        statusPatch: {
          errorMessage: "Cancelled by user",
          finishedAt: new Date(status.reconcileBackoffUntil ?? Date.now()),
          // Exhaust the retry budget so decideFailed never auto-retries a
          // user-cancelled run back to QUEUED (it cannot otherwise tell a
          // cancellation apart from an agent failure). An explicit user retry
          // via workflowService.retryWorkflowRun still works — it does not
          // consult maxRetries. Mirrors workflowService.cancelWorkflowRun.
          retryCount: Math.max(status.retryCount, spec.maxRetries),
        },
        clearControlIntent: true,
        trigger: "user_cancel",
        reason: "control_intent=cancel",
      };
    }
    case "retry": {
      if (status.state !== WorkflowRunState.FAILED) {
        return { kind: "clearControlIntent", reason: "intent_retry_not_failed" };
      }
      if (status.retryCount >= spec.maxRetries) {
        return {
          kind: "clearControlIntent",
          reason: "intent_retry_exhausted",
        };
      }
      return {
        kind: "transition",
        to: WorkflowRunState.QUEUED,
        statusPatch: {
          errorMessage: null,
          retryCount: status.retryCount + 1,
          // Clear stale finishedAt so decideRunning doesn't short-circuit
          // the retry to COMPLETED when the worker advances to RUNNING.
          finishedAt: null,
        },
        clearControlIntent: true,
        trigger: "user_retry",
        reason: "control_intent=retry",
      };
    }
    case "resume":
    case "restart":
      // Standalone runs don't support resume/restart semantics — treat as a
      // no-op intent clear so the UI doesn't get stuck.
      return {
        kind: "clearControlIntent",
        reason: `intent_unsupported_for_standalone:${status.controlIntent}`,
      };
  }
}

function decideQueued(snapshot: WorldSnapshot): StandaloneAction {
  if (snapshot.run.kind !== "standalone") {
    return { kind: "noop", reason: "wrong_kind" };
  }
  const { spec } = snapshot.run;
  if (!spec.workflowEnabled) {
    return {
      kind: "transition",
      to: WorkflowRunState.FAILED,
      statusPatch: { errorMessage: "Workflow is disabled" },
      trigger: "workflow_disabled",
      reason: "workflow_disabled",
    };
  }

  const { global } = snapshot.capacity;
  if (global.running >= global.max) {
    return {
      kind: "requeueSoon",
      delayMs: capacityRequeueDelay(),
      reason: `global_capacity_saturated:${global.running}/${global.max}`,
    };
  }

  // Per-workflow concurrency (tracked in spec.maxConcurrent vs
  // snapshot.capacity.repo when provided by the builder).
  const workflowCapacity = snapshot.capacity.repo;
  if (workflowCapacity && workflowCapacity.running >= workflowCapacity.max) {
    return {
      kind: "requeueSoon",
      delayMs: capacityRequeueDelay(),
      reason: `workflow_capacity_saturated:${workflowCapacity.running}/${workflowCapacity.max}`,
    };
  }

  return {
    kind: "enqueueAgent",
    trigger: "reconcile_queued",
    reason: "queued_capacity_available",
  };
}

function decideRunning(snapshot: WorldSnapshot): StandaloneAction {
  if (snapshot.run.kind !== "standalone") {
    return { kind: "noop", reason: "wrong_kind" };
  }
  const { status } = snapshot.run;

  // Agent already finished (worker set finishedAt while the reconciler
  // hadn't transitioned yet). Close out based on whether an error was recorded.
  if (status.finishedAt) {
    if (status.errorMessage) {
      return {
        kind: "transition",
        to: WorkflowRunState.FAILED,
        statusPatch: {},
        trigger: "agent_finished_with_error",
        reason: "finishedAt_set_with_error",
      };
    }
    return {
      kind: "transition",
      to: WorkflowRunState.COMPLETED,
      statusPatch: {},
      trigger: "agent_finished",
      reason: "finishedAt_set",
    };
  }

  // Stall detection.
  if (snapshot.heartbeat.isStale) {
    return {
      kind: "transition",
      to: WorkflowRunState.FAILED,
      statusPatch: {
        errorMessage: `Agent stalled: no activity for ${Math.round(
          snapshot.heartbeat.silentForMs / 1000,
        )}s`,
        finishedAt: snapshot.now,
      },
      trigger: "stall_detected",
      reason: "heartbeat_stale",
    };
  }

  // Pod died.
  if (snapshot.pod && (snapshot.pod.phase === "terminated" || snapshot.pod.phase === "error")) {
    return {
      kind: "transition",
      to: WorkflowRunState.FAILED,
      statusPatch: {
        errorMessage: snapshot.pod.lastError ?? `Pod ${snapshot.pod.phase}`,
        finishedAt: snapshot.now,
      },
      trigger: "pod_died",
      reason: `pod_phase=${snapshot.pod.phase}`,
    };
  }

  return { kind: "noop", reason: "running_healthy" };
}

function capacityRequeueDelay(): number {
  // 10s base + up to 5s jitter; matches existing task-worker behavior.
  return 10_000 + Math.floor(Math.random() * 5_000);
}

function jitteredBackoff(attempts: number): number {
  const base = 30_000;
  const capped = Math.min(attempts, 6);
  return base * Math.pow(2, capped) + Math.floor(Math.random() * 5_000);
}
