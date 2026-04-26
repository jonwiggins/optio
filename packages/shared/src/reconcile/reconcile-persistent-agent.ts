import { PersistentAgentState } from "../types/persistent-agent.js";
import type {
  PersistentAgentAction,
  PersistentAgentRunSpec,
  PersistentAgentRunStatus,
  WorldSnapshot,
} from "./types.js";

/**
 * Pure decision function for Persistent Agents.
 *
 * Inputs: a fully-materialized WorldSnapshot describing the agent (its row,
 * pod, and inbox). Output: a single Action describing what the executor should
 * do. No I/O, no DB, no clock — caller supplies `now` on the snapshot.
 *
 * The state machine here is cyclic:
 *
 *   idle ── pending msg / intent ──▶ queued ──▶ provisioning ──▶ running
 *     ▲                                                              │
 *     └────────────────── turn halted (success) ─────────────────────┘
 *
 * Failures past `consecutiveFailureLimit` route to FAILED (manual resume).
 * `pause`, `archive`, and `restart` control intents transition immediately.
 */
export function reconcilePersistentAgent(snapshot: WorldSnapshot): PersistentAgentAction {
  if (snapshot.run.kind !== "persistent-agent") {
    return {
      kind: "noop",
      reason: `reconcile-persistent-agent called on ${snapshot.run.kind} run`,
    };
  }
  const run = snapshot.run;
  const spec: PersistentAgentRunSpec = run.spec;
  const status: PersistentAgentRunStatus = run.status;
  const nowMs = snapshot.now.getTime();

  // Honor reconcile backoff.
  if (status.reconcileBackoffUntil && status.reconcileBackoffUntil.getTime() > nowMs) {
    return { kind: "noop", reason: "reconcile_backoff_active" };
  }

  // Control intent takes precedence over observed state.
  const intentAction = interpretIntent(status);
  if (intentAction) return intentAction;

  // If a world read failed, defer.
  if (snapshot.readErrors.length > 0) {
    return {
      kind: "deferWithBackoff",
      untilMs: nowMs + jitteredBackoff(status.reconcileAttempts),
      reason: `world_read_failed:${snapshot.readErrors[0].source}`,
    };
  }

  switch (status.state) {
    case PersistentAgentState.IDLE:
      return decideIdle(spec, status);
    case PersistentAgentState.QUEUED:
      return decideQueued(snapshot);
    case PersistentAgentState.PROVISIONING:
      return decideProvisioning(snapshot);
    case PersistentAgentState.RUNNING:
      return decideRunning(snapshot);
    case PersistentAgentState.PAUSED:
      return { kind: "noop", reason: "paused_awaiting_resume_intent" };
    case PersistentAgentState.FAILED:
      return { kind: "noop", reason: "failed_awaiting_resume_intent" };
    case PersistentAgentState.ARCHIVED:
      return { kind: "noop", reason: "terminal_archived" };
    default:
      return {
        kind: "noop",
        reason: `unknown_state:${String(status.state)}`,
      };
  }
}

function interpretIntent(status: PersistentAgentRunStatus): PersistentAgentAction | null {
  if (!status.controlIntent) return null;

  switch (status.controlIntent) {
    case "pause": {
      if (
        status.state === PersistentAgentState.PAUSED ||
        status.state === PersistentAgentState.ARCHIVED
      ) {
        return { kind: "clearControlIntent", reason: "intent_pause_already_paused" };
      }
      return {
        kind: "transition",
        to: PersistentAgentState.PAUSED,
        clearControlIntent: true,
        trigger: "user_pause",
        reason: "control_intent=pause",
      };
    }
    case "resume": {
      if (
        status.state !== PersistentAgentState.PAUSED &&
        status.state !== PersistentAgentState.FAILED
      ) {
        return { kind: "clearControlIntent", reason: "intent_resume_not_paused_or_failed" };
      }
      return {
        kind: "transition",
        to: PersistentAgentState.IDLE,
        statusPatch: {
          consecutiveFailures: 0,
          errorMessage: null,
        },
        clearControlIntent: true,
        trigger: "user_resume",
        reason: "control_intent=resume",
      };
    }
    case "archive": {
      if (status.state === PersistentAgentState.ARCHIVED) {
        return { kind: "clearControlIntent", reason: "intent_archive_already_archived" };
      }
      return {
        kind: "transition",
        to: PersistentAgentState.ARCHIVED,
        clearControlIntent: true,
        trigger: "user_archive",
        reason: "control_intent=archive",
      };
    }
    case "restart": {
      // Reset session + counters, route through idle so the next pending
      // message (or the initial prompt path) wakes a fresh turn.
      return {
        kind: "transition",
        to: PersistentAgentState.IDLE,
        statusPatch: {
          sessionId: null,
          consecutiveFailures: 0,
          errorMessage: null,
        },
        clearControlIntent: true,
        trigger: "user_restart",
        reason: "control_intent=restart",
      };
    }
  }
}

function decideIdle(
  spec: PersistentAgentRunSpec,
  status: PersistentAgentRunStatus,
): PersistentAgentAction {
  if (!spec.enabled) {
    return { kind: "noop", reason: "agent_disabled" };
  }
  if (status.pendingMessages > 0) {
    return {
      kind: "transition",
      to: PersistentAgentState.QUEUED,
      trigger: "inbox_has_messages",
      reason: `pending_messages=${status.pendingMessages}`,
    };
  }
  return { kind: "noop", reason: "idle_inbox_empty" };
}

function decideQueued(snapshot: WorldSnapshot): PersistentAgentAction {
  if (snapshot.run.kind !== "persistent-agent") {
    return { kind: "noop", reason: "wrong_kind" };
  }
  const { global } = snapshot.capacity;
  if (global.running >= global.max) {
    return {
      kind: "requeueSoon",
      delayMs: capacityRequeueDelay(),
      reason: `global_capacity_saturated:${global.running}/${global.max}`,
    };
  }
  return {
    kind: "enqueueTurn",
    trigger: "reconcile_queued",
    wakeSource: "system",
    reason: "queued_capacity_available",
  };
}

function decideProvisioning(snapshot: WorldSnapshot): PersistentAgentAction {
  if (snapshot.run.kind !== "persistent-agent") {
    return { kind: "noop", reason: "wrong_kind" };
  }

  // Pod died while provisioning.
  if (snapshot.pod && (snapshot.pod.phase === "terminated" || snapshot.pod.phase === "error")) {
    return {
      kind: "transition",
      to: PersistentAgentState.IDLE,
      statusPatch: {
        errorMessage: snapshot.pod.lastError ?? `Pod ${snapshot.pod.phase} during provisioning`,
        lastFailureAt: snapshot.now,
        lastFailureReason: `pod_${snapshot.pod.phase}_during_provisioning`,
        consecutiveFailures: snapshot.run.status.consecutiveFailures + 1,
      },
      trigger: "pod_died_during_provisioning",
      reason: `pod_phase=${snapshot.pod.phase}`,
    };
  }

  // Worker handles the actual provisioning → running handoff inside its job.
  // Reconciler just waits.
  return { kind: "noop", reason: "provisioning_in_progress" };
}

function decideRunning(snapshot: WorldSnapshot): PersistentAgentAction {
  if (snapshot.run.kind !== "persistent-agent") {
    return { kind: "noop", reason: "wrong_kind" };
  }
  const { spec, status } = snapshot.run;

  // Stall detection.
  if (snapshot.heartbeat.isStale) {
    const nextFailures = status.consecutiveFailures + 1;
    const escalateToFailed = nextFailures >= spec.consecutiveFailureLimit;
    return {
      kind: "transition",
      to: escalateToFailed ? PersistentAgentState.FAILED : PersistentAgentState.IDLE,
      statusPatch: {
        errorMessage: `Turn stalled: no activity for ${Math.round(
          snapshot.heartbeat.silentForMs / 1000,
        )}s`,
        lastFailureAt: snapshot.now,
        lastFailureReason: "stall_detected",
        consecutiveFailures: nextFailures,
      },
      trigger: "stall_detected",
      reason: `heartbeat_stale failures=${nextFailures}/${spec.consecutiveFailureLimit}`,
    };
  }

  // Pod died.
  if (snapshot.pod && (snapshot.pod.phase === "terminated" || snapshot.pod.phase === "error")) {
    const nextFailures = status.consecutiveFailures + 1;
    const escalateToFailed = nextFailures >= spec.consecutiveFailureLimit;
    return {
      kind: "transition",
      to: escalateToFailed ? PersistentAgentState.FAILED : PersistentAgentState.IDLE,
      statusPatch: {
        errorMessage: snapshot.pod.lastError ?? `Pod ${snapshot.pod.phase}`,
        lastFailureAt: snapshot.now,
        lastFailureReason: `pod_${snapshot.pod.phase}`,
        consecutiveFailures: nextFailures,
      },
      trigger: "pod_died",
      reason: `pod_phase=${snapshot.pod.phase}`,
    };
  }

  return { kind: "noop", reason: "running_healthy" };
}

function capacityRequeueDelay(): number {
  return 10_000 + Math.floor(Math.random() * 5_000);
}

function jitteredBackoff(attempts: number): number {
  const base = 30_000;
  const capped = Math.min(attempts, 6);
  return base * Math.pow(2, capped) + Math.floor(Math.random() * 5_000);
}
