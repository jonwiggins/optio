import { TaskState } from "../types/task.js";
import type {
  RepoAction,
  WorldSnapshot,
  RepoRunSpec,
  RepoRunStatus,
  DependencyObservation,
} from "./types.js";

/**
 * Pure decision function for Repo Task runs (tasks table).
 *
 * Inputs: a WorldSnapshot describing the run, pod state, PR state,
 * dependencies, capacity, heartbeat, and repo settings. Output: a single
 * Action. No I/O, no DB, no clock — the caller supplies `now`.
 */
export function reconcileRepo(snapshot: WorldSnapshot): RepoAction {
  if (snapshot.run.kind !== "repo") {
    return {
      kind: "noop",
      reason: `reconcile-repo called on ${snapshot.run.kind} run`,
    };
  }
  const run = snapshot.run;
  const spec: RepoRunSpec = run.spec;
  const status: RepoRunStatus = run.status;
  const nowMs = snapshot.now.getTime();

  // Backoff guard.
  if (status.reconcileBackoffUntil && status.reconcileBackoffUntil.getTime() > nowMs) {
    return { kind: "noop", reason: "reconcile_backoff_active" };
  }

  // Control intent takes precedence over observed state.
  const intentAction = interpretIntent(status, spec);
  if (intentAction) return intentAction;

  // If any upstream world read failed, defer rather than act on stale data.
  // Exception: capacity reads are only needed in QUEUED.
  const hasBlockingReadError = snapshot.readErrors.some((e) =>
    e.source === "capacity" ? status.state === TaskState.QUEUED : true,
  );
  if (hasBlockingReadError) {
    return {
      kind: "deferWithBackoff",
      untilMs: nowMs + jitteredBackoff(status.reconcileAttempts),
      reason: `world_read_failed:${snapshot.readErrors[0].source}`,
    };
  }

  switch (status.state) {
    case TaskState.PENDING:
      return decidePending(snapshot);
    case TaskState.WAITING_ON_DEPS:
      return decideWaitingOnDeps(snapshot);
    case TaskState.QUEUED:
      return decideQueued(snapshot);
    case TaskState.PROVISIONING:
      return decideProvisioning(snapshot);
    case TaskState.RUNNING:
      return decideRunning(snapshot);
    case TaskState.NEEDS_ATTENTION:
      return decideNeedsAttention();
    case TaskState.PR_OPENED:
      return decidePrOpened(snapshot);
    case TaskState.FAILED:
      return decideFailed(snapshot);
    case TaskState.CANCELLED:
      return { kind: "noop", reason: "cancelled_no_intent" };
    case TaskState.COMPLETED:
      return { kind: "noop", reason: "terminal_completed" };
    default:
      return {
        kind: "noop",
        reason: `unknown_state:${status.state as string}`,
      };
  }
}

// ── Intent ──────────────────────────────────────────────────────────────────

function interpretIntent(status: RepoRunStatus, spec: RepoRunSpec): RepoAction | null {
  if (!status.controlIntent) return null;

  const terminal = status.state === TaskState.COMPLETED || status.state === TaskState.CANCELLED;

  switch (status.controlIntent) {
    case "cancel": {
      if (terminal) {
        return { kind: "clearControlIntent", reason: "intent_cancel_on_terminal" };
      }
      if (status.state === TaskState.FAILED) {
        // FAILED has no direct transition to CANCELLED; surface via clear and
        // leave the failed state in place.
        return {
          kind: "clearControlIntent",
          reason: "intent_cancel_on_failed",
        };
      }
      return {
        kind: "transition",
        to: TaskState.CANCELLED,
        statusPatch: { errorMessage: "Cancelled by user" },
        clearControlIntent: true,
        trigger: "user_cancel",
        reason: "control_intent=cancel",
      };
    }
    case "retry": {
      if (status.state !== TaskState.FAILED && status.state !== TaskState.CANCELLED) {
        return { kind: "clearControlIntent", reason: "intent_retry_invalid_state" };
      }
      if (status.retryCount >= spec.maxRetries) {
        return {
          kind: "clearControlIntent",
          reason: "intent_retry_exhausted",
        };
      }
      return {
        kind: "transition",
        to: TaskState.QUEUED,
        statusPatch: {
          errorMessage: null,
          retryCount: status.retryCount + 1,
        },
        clearControlIntent: true,
        trigger: "user_retry",
        reason: "control_intent=retry",
      };
    }
    case "resume": {
      if (status.state !== TaskState.NEEDS_ATTENTION) {
        return {
          kind: "clearControlIntent",
          reason: "intent_resume_invalid_state",
        };
      }
      return {
        kind: "transition",
        to: TaskState.QUEUED,
        statusPatch: { errorMessage: null },
        clearControlIntent: true,
        trigger: "user_resume",
        reason: "control_intent=resume",
      };
    }
    case "restart": {
      if (terminal || status.state === TaskState.FAILED) {
        return {
          kind: "transition",
          to: TaskState.QUEUED,
          statusPatch: {
            errorMessage: null,
            retryCount: 0,
            containerId: null,
            sessionId: null,
          },
          clearControlIntent: true,
          trigger: "force_restart",
          reason: "control_intent=restart",
        };
      }
      return {
        kind: "clearControlIntent",
        reason: "intent_restart_invalid_state",
      };
    }
  }
}

// ── Per-state decisions ─────────────────────────────────────────────────────

function decidePending(snapshot: WorldSnapshot): RepoAction {
  if (snapshot.dependencies.length === 0) {
    return {
      kind: "transition",
      to: TaskState.QUEUED,
      trigger: "no_deps",
      reason: "pending_no_deps",
    };
  }
  return {
    kind: "transition",
    to: TaskState.WAITING_ON_DEPS,
    trigger: "deps_pending",
    reason: "pending_has_deps",
  };
}

function decideWaitingOnDeps(snapshot: WorldSnapshot): RepoAction {
  const { dependencies } = snapshot;
  const anyFailed = dependencies.some(
    (d) => d.state === TaskState.FAILED || d.state === TaskState.CANCELLED,
  );
  if (anyFailed) {
    return {
      kind: "transition",
      to: TaskState.FAILED,
      statusPatch: { errorMessage: "Upstream dependency failed" },
      trigger: "dependency_failed",
      reason: "upstream_failed",
    };
  }
  const allComplete = dependencies.every((d) => d.state === TaskState.COMPLETED);
  if (allComplete) {
    return {
      kind: "transition",
      to: TaskState.QUEUED,
      trigger: "deps_satisfied",
      reason: "all_deps_complete",
    };
  }
  return { kind: "noop", reason: "deps_still_pending" };
}

function decideQueued(snapshot: WorldSnapshot): RepoAction {
  if (snapshot.run.kind !== "repo") return { kind: "noop", reason: "wrong_kind" };
  const { spec } = snapshot.run;

  if (snapshot.settings.offPeakOnly && !spec.ignoreOffPeak && !snapshot.settings.offPeakActive) {
    return {
      kind: "requeueSoon",
      delayMs: offPeakRequeueDelay(),
      reason: "off_peak_blocked",
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

  const repoCapacity = snapshot.capacity.repo;
  if (repoCapacity && repoCapacity.running >= repoCapacity.max) {
    return {
      kind: "requeueSoon",
      delayMs: capacityRequeueDelay(),
      reason: `repo_capacity_saturated:${repoCapacity.running}/${repoCapacity.max}`,
    };
  }

  return {
    kind: "requeueForAgent",
    trigger: "reconcile_queued",
    reason: "queued_capacity_available",
  };
}

function decideProvisioning(snapshot: WorldSnapshot): RepoAction {
  const { pod } = snapshot;
  if (pod && (pod.phase === "terminated" || pod.phase === "error")) {
    return {
      kind: "transition",
      to: TaskState.FAILED,
      statusPatch: {
        errorMessage: pod.lastError ?? `Pod ${pod.phase} during provisioning`,
      },
      trigger: "provisioning_pod_died",
      reason: `pod_phase=${pod.phase}`,
    };
  }
  // Otherwise let the worker drive provisioning → running.
  return { kind: "noop", reason: "provisioning_in_progress" };
}

function decideRunning(snapshot: WorldSnapshot): RepoAction {
  if (snapshot.run.kind !== "repo") return { kind: "noop", reason: "wrong_kind" };
  const { spec, status } = snapshot.run;

  // PR was just detected in agent output; promote. Only coding tasks follow
  // the PR lifecycle — pr_review tasks reference someone else's PR and never
  // enter PR_OPENED even if a prUrl is set on the row.
  if (spec.taskType === "coding" && status.prUrl && status.state === TaskState.RUNNING) {
    return {
      kind: "transition",
      to: TaskState.PR_OPENED,
      trigger: "pr_detected",
      reason: "pr_url_set_while_running",
    };
  }

  // Pod died.
  if (snapshot.pod && (snapshot.pod.phase === "terminated" || snapshot.pod.phase === "error")) {
    return {
      kind: "transition",
      to: TaskState.FAILED,
      statusPatch: {
        errorMessage: snapshot.pod.lastError ?? `Pod ${snapshot.pod.phase} while running`,
      },
      trigger: "running_pod_died",
      reason: `pod_phase=${snapshot.pod.phase}`,
    };
  }

  // Stall detection.
  if (snapshot.heartbeat.isStale) {
    return {
      kind: "transition",
      to: TaskState.FAILED,
      statusPatch: {
        errorMessage: `Agent stalled: no activity for ${Math.round(
          snapshot.heartbeat.silentForMs / 1000,
        )}s`,
      },
      trigger: "stall_detected",
      reason: "heartbeat_stale",
    };
  }

  return { kind: "noop", reason: "running_healthy" };
}

function decideNeedsAttention(): RepoAction {
  // Waiting for user intent (resume / cancel). Reconciler cannot self-advance
  // out of NEEDS_ATTENTION without explicit intent — that's the whole point.
  return { kind: "noop", reason: "awaiting_user_intent" };
}

function decidePrOpened(snapshot: WorldSnapshot): RepoAction {
  return decideFromPrStatus(snapshot, /*allowFailComplete*/ true);
}

function decideFailed(snapshot: WorldSnapshot): RepoAction {
  if (snapshot.run.kind !== "repo") return { kind: "noop", reason: "wrong_kind" };
  const { status } = snapshot.run;
  // Failed tasks with an open PR are still watched (CI may recover, auto-merge
  // may become possible). Failed tasks without a PR are terminal for the
  // reconciler — only user retry intent advances them.
  if (status.prUrl && snapshot.pr) {
    return decideFromPrStatus(snapshot, /*allowFailComplete*/ true);
  }
  return { kind: "noop", reason: "failed_no_pr" };
}

/** Map PR status into an action. Mirrors determinePrAction in pr-watcher-worker. */
function decideFromPrStatus(snapshot: WorldSnapshot, allowFailComplete: boolean): RepoAction {
  if (snapshot.run.kind !== "repo") return { kind: "noop", reason: "wrong_kind" };
  const { spec, status } = snapshot.run;
  // Only coding tasks own the PR attached to their row. Review subtasks and
  // external pr_review tasks must never drive PR-reactive actions (auto-merge,
  // auto-resume, launch-review) — the PR they reference isn't theirs.
  // Defence-in-depth: even if a stray prUrl write ever leaks through, this
  // guard prevents the reconciler from acting on it.
  if (spec.taskType !== "coding") {
    return { kind: "noop", reason: `pr_machinery_disabled_for_${spec.taskType}` };
  }
  const pr = snapshot.pr;
  if (!pr) {
    return { kind: "noop", reason: "pr_info_not_yet_available" };
  }

  // PR merged → complete.
  if (pr.merged) {
    if (!allowFailComplete && status.state === TaskState.FAILED) {
      return { kind: "noop", reason: "failed_state_no_complete" };
    }
    return {
      kind: "transition",
      to: TaskState.COMPLETED,
      statusPatch: {
        prState: "merged",
        prChecksStatus: effectiveChecksStatus(pr, status),
      },
      trigger: "pr_merged",
      reason: "pr_merged",
    };
  }

  // PR closed without merge → fail (unless already failed).
  if (pr.state === "closed") {
    if (status.state === TaskState.FAILED) {
      return { kind: "noop", reason: "pr_closed_already_failed" };
    }
    return {
      kind: "transition",
      to: TaskState.FAILED,
      statusPatch: {
        prState: "closed",
        prChecksStatus: effectiveChecksStatus(pr, status),
        errorMessage: "PR was closed without merging",
      },
      trigger: "pr_closed",
      reason: "pr_closed",
    };
  }

  const canResume = status.state !== TaskState.FAILED;
  const prev = {
    checks: status.prChecksStatus,
    review: status.prReviewStatus,
  };

  const autoResumeAllowed =
    snapshot.settings.autoResume &&
    canResume &&
    snapshot.settings.recentAutoResumeCount < snapshot.settings.maxAutoResumes;

  // Merge conflicts (edge-triggered).
  if (pr.mergeable === false && pr.state === "open" && prev.checks !== "conflicts") {
    if (autoResumeAllowed) {
      return {
        kind: "resumeAgent",
        resumeReason: "conflicts",
        reason: "pr_conflicts_auto_resume",
      };
    }
    return {
      kind: "transition",
      to: TaskState.NEEDS_ATTENTION,
      statusPatch: { prChecksStatus: "failing" },
      trigger: "merge_conflicts",
      reason: "pr_conflicts_needs_attention",
    };
  }

  // CI just started failing.
  if (pr.checksStatus === "failing" && prev.checks !== "failing" && pr.state === "open") {
    if (autoResumeAllowed) {
      return {
        kind: "resumeAgent",
        resumeReason: "ci_failure",
        reason: "ci_failing_auto_resume",
      };
    }
    return {
      kind: "transition",
      to: TaskState.NEEDS_ATTENTION,
      statusPatch: { prChecksStatus: "failing" },
      trigger: "ci_failing",
      reason: "ci_failing_needs_attention",
    };
  }

  // CI just passed → trigger review if configured for on_ci_pass.
  if (
    pr.checksStatus === "passing" &&
    prev.checks !== "passing" &&
    pr.state === "open" &&
    snapshot.settings.reviewEnabled &&
    snapshot.settings.reviewTrigger === "on_ci_pass" &&
    !snapshot.settings.hasReviewSubtask
  ) {
    return { kind: "launchReview", reason: "ci_passing_launch_review" };
  }

  // First PR detection → trigger review if configured for on_pr.
  if (
    prev.checks === null &&
    pr.state === "open" &&
    snapshot.settings.reviewEnabled &&
    snapshot.settings.reviewTrigger === "on_pr" &&
    !snapshot.settings.hasReviewSubtask
  ) {
    return { kind: "launchReview", reason: "on_pr_launch_review" };
  }

  // Auto-merge path.
  const checksOk = pr.checksStatus === "passing" || pr.checksStatus === "none";
  if (
    checksOk &&
    pr.state === "open" &&
    snapshot.settings.autoMerge &&
    !snapshot.settings.cautiousMode &&
    blockingSubtasksComplete(snapshot.blockingSubtasks)
  ) {
    return { kind: "autoMergePr", reason: "auto_merge_ready" };
  }

  // Review requested changes (edge-triggered).
  if (pr.reviewStatus === "changes_requested" && prev.review !== "changes_requested") {
    if (autoResumeAllowed) {
      return {
        kind: "resumeAgent",
        resumeReason: "review",
        reason: "review_changes_auto_resume",
      };
    }
    return {
      kind: "transition",
      to: TaskState.NEEDS_ATTENTION,
      statusPatch: { prReviewStatus: "changes_requested" },
      trigger: "review_changes_requested",
      reason: "review_changes_needs_attention",
    };
  }

  // Persist current PR snapshot so the UI reflects the latest.
  const patch: Partial<RepoRunStatus> = {};
  const effectiveChecks = effectiveChecksStatus(pr, status);
  if (prev.checks !== effectiveChecks) patch.prChecksStatus = effectiveChecks;
  if (prev.review !== pr.reviewStatus) patch.prReviewStatus = pr.reviewStatus;
  if (status.prState !== pr.state) patch.prState = pr.state;
  if (Object.keys(patch).length > 0) {
    return {
      kind: "patchStatus",
      statusPatch: patch,
      reason: "pr_status_fields_refresh",
    };
  }

  return { kind: "noop", reason: "pr_status_steady" };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function blockingSubtasksComplete(subs: DependencyObservation[]): boolean {
  if (subs.length === 0) return true;
  return subs.every((s) => s.state === TaskState.COMPLETED || !s.blocksParent);
}

function effectiveChecksStatus(
  pr: NonNullable<WorldSnapshot["pr"]>,
  _status: RepoRunStatus,
): "pending" | "passing" | "failing" | "none" {
  return pr.checksStatus;
}

function capacityRequeueDelay(): number {
  return 10_000 + Math.floor(Math.random() * 5_000);
}

function offPeakRequeueDelay(): number {
  // Check again in a minute — off-peak windows are coarse-grained.
  return 60_000 + Math.floor(Math.random() * 15_000);
}

function jitteredBackoff(attempts: number): number {
  const base = 30_000;
  const capped = Math.min(attempts, 6);
  return base * Math.pow(2, capped) + Math.floor(Math.random() * 5_000);
}
