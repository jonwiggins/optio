import { PrReviewState } from "../types/pr-review.js";
import type { PrReviewAction, PrReviewRunStatus, WorldSnapshot } from "./types.js";
import { readExecution } from "./attachment.js";

/**
 * Pure decision function for PR reviews. Inputs: a WorldSnapshot with
 * `run.kind === "pr-review"` describing the review, PR state (CI, merged,
 * closed, head_sha), settings. Output: a single Action. No I/O, no DB,
 * no clock — the caller supplies `now`.
 *
 * The state machine is smaller than the repo task one:
 *   queued → waiting_ci → reviewing → ready ⇄ stale
 *                              ↓          ↓
 *                            failed    submitted ↺ stale
 *
 * Terminal: cancelled. submitted is "soft terminal" — it can still flip
 * to stale if the PR advances after the review was posted.
 */
export function reconcilePrReview(snapshot: WorldSnapshot): PrReviewAction {
  if (snapshot.run.kind !== "pr-review") {
    return {
      kind: "noop",
      reason: `reconcile-pr-review called on ${snapshot.run.kind} run`,
    };
  }
  const run = snapshot.run;
  const status: PrReviewRunStatus = run.status;
  const nowMs = snapshot.now.getTime();

  // Backoff guard.
  if (status.reconcileBackoffUntil && status.reconcileBackoffUntil.getTime() > nowMs) {
    return { kind: "noop", reason: "reconcile_backoff_active" };
  }

  // Control intent takes precedence.
  const intentAction = interpretIntent(status);
  if (intentAction) return intentAction;

  // The review's active run (any kind, a chat turn too) whose instance went
  // away (docs/plans/scale-out.md §2): attach to its agent again, or — when
  // the agent never started — queue the run again. Neither needs the PR.
  const execution = readExecution(snapshot.execution, snapshot.now);
  if (execution.kind === "detached") {
    return {
      kind: "reattach",
      runId: snapshot.execution!.runId,
      attempt: execution.attempt,
      reason: "review_run_unattached",
    };
  }
  if (execution.kind === "never_started") {
    return {
      kind: "requeueRun",
      runId: snapshot.execution!.runId,
      trigger: "review_run_start_interrupted",
      reason: "review_run_unattached_never_started",
    };
  }

  // Blocking read errors defer.
  if (snapshot.readErrors.length > 0) {
    return {
      kind: "deferWithBackoff",
      untilMs: nowMs + jitteredBackoff(status.reconcileAttempts),
      reason: `world_read_failed:${snapshot.readErrors[0].source}`,
    };
  }

  // If the PR itself has closed or merged, cancel the review — there's
  // nothing left to review against.
  const pr = snapshot.pr;
  if (pr) {
    if (pr.merged && status.state !== PrReviewState.CANCELLED) {
      return {
        kind: "transition",
        to: PrReviewState.CANCELLED,
        statusPatch: { errorMessage: "PR was merged before review completed" },
        clearControlIntent: true,
        trigger: "pr_merged",
        reason: "pr_merged_cancel_review",
      };
    }
    if (pr.state === "closed" && !pr.merged && status.state !== PrReviewState.CANCELLED) {
      return {
        kind: "transition",
        to: PrReviewState.CANCELLED,
        statusPatch: { errorMessage: "PR was closed before review completed" },
        clearControlIntent: true,
        trigger: "pr_closed",
        reason: "pr_closed_cancel_review",
      };
    }
  }

  switch (status.state) {
    case PrReviewState.QUEUED:
      return decideQueued(snapshot);
    case PrReviewState.WAITING_CI:
      return decideWaitingCi(snapshot);
    case PrReviewState.REVIEWING:
      return decideReviewing(snapshot);
    case PrReviewState.READY:
      return decideReady(snapshot);
    case PrReviewState.STALE:
      return decideStale(snapshot);
    case PrReviewState.SUBMITTED:
      return decideSubmitted(snapshot);
    case PrReviewState.FAILED:
      return { kind: "noop", reason: "failed_awaiting_retry" };
    case PrReviewState.CANCELLED:
      return { kind: "noop", reason: "terminal_cancelled" };
    default:
      return { kind: "noop", reason: `unknown_state:${status.state as string}` };
  }
}

// ── Intent ──────────────────────────────────────────────────────────────────

function interpretIntent(status: PrReviewRunStatus): PrReviewAction | null {
  if (!status.controlIntent) return null;

  switch (status.controlIntent) {
    case "cancel": {
      if (status.state === PrReviewState.CANCELLED) {
        return { kind: "clearControlIntent", reason: "intent_cancel_on_terminal" };
      }
      return {
        kind: "transition",
        to: PrReviewState.CANCELLED,
        statusPatch: { errorMessage: "Cancelled by user" },
        clearControlIntent: true,
        trigger: "user_cancel",
        reason: "control_intent=cancel",
      };
    }
    case "rereview": {
      // Only meaningful from ready/stale/submitted/failed. Anything else:
      // just clear the intent silently — the user likely hit the button in
      // a state where it doesn't apply.
      const allowed: PrReviewState[] = [
        PrReviewState.READY,
        PrReviewState.STALE,
        PrReviewState.SUBMITTED,
        PrReviewState.FAILED,
      ];
      if (!allowed.includes(status.state)) {
        return { kind: "clearControlIntent", reason: "intent_rereview_invalid_state" };
      }
      return {
        kind: "launchReviewRun",
        runKind: "rereview",
        trigger: "user_rereview",
        reason: "control_intent=rereview",
      };
    }
  }
}

// ── Per-state decisions ─────────────────────────────────────────────────────

function decideQueued(snapshot: WorldSnapshot): PrReviewAction {
  const pr = snapshot.pr;
  // If we don't know the PR state yet, wait — don't guess.
  if (!pr) return { kind: "noop", reason: "pr_info_not_yet_available" };

  // Caller can park in waiting_ci when they want CI to clear first.
  // We infer from settings: origin=auto + CI pending → waiting_ci.
  if (snapshot.run.kind !== "pr-review") return { kind: "noop", reason: "wrong_kind" };
  const spec = snapshot.run.spec;
  if (spec.origin === "auto" && pr.checksStatus === "pending") {
    return {
      kind: "transition",
      to: PrReviewState.WAITING_CI,
      trigger: "waiting_ci",
      reason: "queued_auto_ci_pending",
    };
  }
  // Launch the initial review run.
  return {
    kind: "launchReviewRun",
    runKind: "initial",
    trigger: "launch_initial_review",
    reason: "queued_launch",
  };
}

function decideWaitingCi(snapshot: WorldSnapshot): PrReviewAction {
  const pr = snapshot.pr;
  if (!pr) return { kind: "noop", reason: "pr_info_not_yet_available" };
  if (pr.checksStatus === "pending") {
    return { kind: "noop", reason: "still_waiting_ci" };
  }
  // CI resolved either way — go review. (Even if CI failed, the review
  // may be useful. The agent can mention the failing checks.)
  return {
    kind: "launchReviewRun",
    runKind: "initial",
    trigger: "ci_resolved",
    reason: "waiting_ci_resolved",
  };
}

function decideReviewing(snapshot: WorldSnapshot): PrReviewAction {
  if (snapshot.run.kind !== "pr-review") return { kind: "noop", reason: "wrong_kind" };
  const status = snapshot.run.status;
  // Worker drives reviewing → ready/failed via the run row. We only
  // intervene if stuck: run has failed but pr_reviews state hasn't
  // caught up.
  if (status.latestRunState === "failed") {
    return {
      kind: "transition",
      to: PrReviewState.FAILED,
      statusPatch: { errorMessage: status.errorMessage ?? "Review run failed" },
      trigger: "run_failed",
      reason: "reviewing_run_failed",
    };
  }
  if (status.latestRunState === "completed") {
    // Worker should have moved us; if not, snap forward.
    return {
      kind: "transition",
      to: PrReviewState.READY,
      trigger: "run_completed",
      reason: "reviewing_run_completed",
    };
  }
  return { kind: "noop", reason: "reviewing_in_progress" };
}

function decideReady(snapshot: WorldSnapshot): PrReviewAction {
  if (snapshot.run.kind !== "pr-review") return { kind: "noop", reason: "wrong_kind" };
  const spec = snapshot.run.spec;
  const pr = snapshot.pr;
  if (!pr) return { kind: "noop", reason: "pr_info_not_yet_available" };

  // PR advanced since the review was drafted.
  if (pr.headSha && pr.headSha !== spec.headSha) {
    if (
      spec.origin === "auto" &&
      !spec.userEngaged &&
      snapshot.settings.recentAutoResumeCount < spec.maxAutoRereviews
    ) {
      return {
        kind: "launchReviewRun",
        runKind: "rereview",
        trigger: "auto_rereview_new_commits",
        reason: "ready_headsha_changed_auto",
      };
    }
    return { kind: "markStale", reason: "ready_headsha_changed" };
  }

  // Auto-submit if configured for on_pr_post.
  if (spec.autoSubmitOnReady && spec.origin === "auto" && !spec.userEngaged) {
    return {
      kind: "submitReview",
      trigger: "auto_submit_on_ready",
      reason: "auto_submit_ready",
    };
  }

  return { kind: "noop", reason: "ready_awaiting_user" };
}

function decideStale(snapshot: WorldSnapshot): PrReviewAction {
  if (snapshot.run.kind !== "pr-review") return { kind: "noop", reason: "wrong_kind" };
  const spec = snapshot.run.spec;
  // Auto-origin + under cap → silently rereview. Otherwise wait for user.
  if (
    spec.origin === "auto" &&
    !spec.userEngaged &&
    snapshot.settings.recentAutoResumeCount < spec.maxAutoRereviews
  ) {
    return {
      kind: "launchReviewRun",
      runKind: "rereview",
      trigger: "auto_rereview_stale",
      reason: "stale_auto_rereview",
    };
  }
  return { kind: "noop", reason: "stale_awaiting_user" };
}

function decideSubmitted(snapshot: WorldSnapshot): PrReviewAction {
  if (snapshot.run.kind !== "pr-review") return { kind: "noop", reason: "wrong_kind" };
  const spec = snapshot.run.spec;
  const pr = snapshot.pr;
  if (!pr) return { kind: "noop", reason: "pr_info_not_yet_available" };

  // PR got new commits after a submitted review → mark stale so the user
  // can decide whether to re-review. (Auto rereview from submitted is
  // possible but we prefer to be conservative and require user intent.)
  if (pr.headSha && pr.headSha !== spec.headSha) {
    if (
      spec.origin === "auto" &&
      !spec.userEngaged &&
      snapshot.settings.recentAutoResumeCount < spec.maxAutoRereviews
    ) {
      return {
        kind: "launchReviewRun",
        runKind: "rereview",
        trigger: "auto_rereview_after_submit",
        reason: "submitted_headsha_changed_auto",
      };
    }
    return {
      kind: "transition",
      to: PrReviewState.STALE,
      trigger: "submitted_pr_advanced",
      reason: "submitted_headsha_changed",
    };
  }
  return { kind: "noop", reason: "submitted_stable" };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function jitteredBackoff(attempts: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
  const jitter = Math.floor(Math.random() * 0.3 * base);
  return base + jitter;
}
