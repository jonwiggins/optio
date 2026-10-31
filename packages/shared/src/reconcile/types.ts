import { TaskState } from "../types/task.js";
import { WorkflowRunState } from "../types/workflow.js";
import {
  PrReviewState,
  PrReviewRunState,
  PrReviewRunKind,
  PrReviewVerdict,
  PrReviewOrigin,
  PrReviewControlIntent,
  PrReviewFileComment,
} from "../types/pr-review.js";
import {
  PersistentAgentState,
  PersistentAgentControlIntent,
  PersistentAgentPodLifecycle,
} from "../types/persistent-agent.js";
import type { RunTarget } from "../types/local.js";
import type { RunExecution } from "./attachment.js";

// ── Identity ────────────────────────────────────────────────────────────────

export type RunKind = "repo" | "standalone" | "pr-review" | "persistent-agent";

export interface RunRef {
  kind: RunKind;
  id: string;
}

export function runKey(ref: RunRef): string {
  // Separator is intentionally `__` (not `:`) because BullMQ rejects `:`
  // in custom job IDs, and we use runKey as the jobId for per-run dedup.
  return `${ref.kind}__${ref.id}`;
}

// ── Intent ──────────────────────────────────────────────────────────────────

export type ControlIntent = "cancel" | "retry" | "resume" | "restart";

// ── Spec/status views ───────────────────────────────────────────────────────

export interface RepoRunSpec {
  repoUrl: string;
  repoBranch: string;
  agentType: string;
  prompt: string;
  title: string;
  /**
   * "coding" — agent opens a PR; full PR-reactive state machine applies.
   * "review" — internal review subtask of a coding task; no PR of its own.
   *
   * External PR reviews used to be a third value here ("pr_review") but
   * they now live in the `pr_reviews` table with their own reconciler.
   */
  taskType: "coding" | "review";
  maxRetries: number;
  priority: number;
  ignoreOffPeak: boolean;
  parentTaskId: string | null;
  blocksParent: boolean;
  workspaceId: string | null;
  /**
   * `local` runs execute on the owner's machine via the Optio Local daemon:
   * no pod, no cluster capacity, and liveness comes from the daemon (the
   * heartbeat/stall machinery does not apply).
   */
  runTarget: RunTarget;
}

export interface RepoRunStatus {
  state: TaskState;
  prUrl: string | null;
  prNumber: number | null;
  prState: "open" | "merged" | "closed" | null;
  prChecksStatus: "pending" | "passing" | "failing" | "none" | "conflicts" | null;
  prReviewStatus: "approved" | "changes_requested" | "pending" | "none" | null;
  prReviewComments: string | null;
  containerId: string | null;
  sessionId: string | null;
  worktreeState: string | null;
  lastPodId: string | null;
  lastActivityAt: Date | null;
  retryCount: number;
  errorMessage: string | null;
  costUsd: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  controlIntent: ControlIntent | null;
  reconcileBackoffUntil: Date | null;
  reconcileAttempts: number;
  updatedAt: Date;
}

export interface StandaloneRunSpec {
  workflowId: string;
  workflowEnabled: boolean;
  agentRuntime: string;
  promptRendered: string;
  params: Record<string, unknown> | null;
  maxConcurrent: number;
  maxRetries: number;
  workspaceId: string | null;
  /** See RepoRunSpec.runTarget. */
  runTarget: RunTarget;
}

export interface StandaloneRunStatus {
  state: WorkflowRunState;
  costUsd: string | null;
  errorMessage: string | null;
  sessionId: string | null;
  podName: string | null;
  retryCount: number;
  /** Execution outcome is unknown; only an explicit user retry can continue. */
  recoveryRequired?: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  controlIntent: ControlIntent | null;
  reconcileBackoffUntil: Date | null;
  reconcileAttempts: number;
  updatedAt: Date;
}

// ── Persistent Agent run types ──────────────────────────────────────────────
//
// A PA's "run" identity is the agent itself — turns are output actions, not
// inputs to the reconciler (analogous to PR reviews, where pr_review_runs are
// children of the pr_reviews row).

export interface PersistentAgentRunSpec {
  agentId: string;
  slug: string;
  workspaceId: string | null;
  agentRuntime: string;
  enabled: boolean;
  podLifecycle: PersistentAgentPodLifecycle;
  idlePodTimeoutMs: number;
  consecutiveFailureLimit: number;
  maxTurnDurationMs: number;
}

export interface PersistentAgentRunStatus {
  state: PersistentAgentState;
  errorMessage: string | null;
  sessionId: string | null;
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  lastFailureReason: string | null;
  lastTurnAt: Date | null;
  totalCostUsd: string;
  controlIntent: PersistentAgentControlIntent | null;
  reconcileBackoffUntil: Date | null;
  reconcileAttempts: number;
  updatedAt: Date;
  /** Pending message count (un-drained inbox). Wakes the agent when ≥1. */
  pendingMessages: number;
  /** Receivedat of the oldest pending message — for ordering across agents. */
  oldestPendingAt: Date | null;
}

// ── PR Review run types ─────────────────────────────────────────────────────
//
// A PR review's primary record lives in `pr_reviews`. The reconciler treats
// that row (not the individual `pr_review_runs` rows) as the run for
// scheduling purposes — runs are output actions, not inputs.

export interface PrReviewRunSpec {
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  repoUrl: string;
  workspaceId: string | null;
  origin: PrReviewOrigin;
  userEngaged: boolean;
  autoSubmitted: boolean;
  headSha: string;
  /** Does the owning user want auto-submit on first ready draft? */
  autoSubmitOnReady: boolean;
  /** Cap on auto-rereviews before we leave in stale. */
  maxAutoRereviews: number;
}

export interface PrReviewRunStatus {
  state: PrReviewState;
  verdict: PrReviewVerdict | null;
  summary: string | null;
  fileComments: PrReviewFileComment[] | null;
  submittedAt: Date | null;
  errorMessage: string | null;
  controlIntent: PrReviewControlIntent | null;
  /** Latest active/completed run's kind, for decision context. */
  latestRunKind: PrReviewRunKind | null;
  latestRunState: PrReviewRunState | null;
  /** Count of auto_rereview_* events since the last manual action. */
  recentAutoRereviewCount: number;
  reconcileBackoffUntil: Date | null;
  reconcileAttempts: number;
  updatedAt: Date;
}

export type Run =
  | { kind: "repo"; ref: RunRef; spec: RepoRunSpec; status: RepoRunStatus }
  | {
      kind: "standalone";
      ref: RunRef;
      spec: StandaloneRunSpec;
      status: StandaloneRunStatus;
    }
  | {
      kind: "pr-review";
      ref: RunRef;
      spec: PrReviewRunSpec;
      status: PrReviewRunStatus;
    }
  | {
      kind: "persistent-agent";
      ref: RunRef;
      spec: PersistentAgentRunSpec;
      status: PersistentAgentRunStatus;
    };

// ── World observations ──────────────────────────────────────────────────────

export interface PodStatus {
  podName: string;
  phase: "pending" | "running" | "ready" | "error" | "terminated" | "unknown";
  lastError: string | null;
}

export interface PrStatus {
  url: string;
  number: number;
  state: "open" | "merged" | "closed";
  merged: boolean;
  draft?: boolean;
  mergeable: boolean | null;
  checksStatus: "none" | "pending" | "passing" | "failing";
  reviewStatus: "none" | "pending" | "approved" | "changes_requested";
  latestReviewComments: string | null;
  /** Head SHA of the PR. Used by pr-review reconciler for stale detection. */
  headSha: string | null;
}

export interface DependencyObservation {
  taskId: string;
  state: TaskState;
  blocksParent: boolean;
}

export interface Capacity {
  running: number;
  max: number;
}

export type WorldReadError = {
  source: "pr" | "pod" | "deps" | "capacity";
  message: string;
};

export interface WorldSnapshot {
  now: Date;
  run: Run;
  pod: PodStatus | null;
  pr: PrStatus | null;
  dependencies: DependencyObservation[];
  blockingSubtasks: DependencyObservation[];
  capacity: {
    global: Capacity;
    repo?: Capacity;
  };
  heartbeat: {
    lastActivityAt: Date | null;
    isStale: boolean;
    silentForMs: number;
  };
  settings: {
    stallThresholdMs: number;
    autoMerge: boolean;
    /**
     * The deployment asks for a confirmation before automatic merging
     * (OPTIO_MERGE_CONFIRMATION, work/auto-merge.ts). Unset or false: the
     * reconciler merges on `autoMerge` alone, as it always has.
     */
    mergeConfirmationRequired?: boolean;
    /**
     * With `mergeConfirmationRequired`: a person ticked "merge automatically"
     * AND accepted the dialog for the setting `autoMerge` comes from. Anything
     * but true then merges nothing.
     */
    autoMergeConfirmed?: boolean;
    cautiousMode: boolean;
    autoResume: boolean;
    reviewEnabled: boolean;
    reviewTrigger: "on_pr" | "on_ci_pass" | null;
    offPeakOnly: boolean;
    offPeakActive: boolean;
    hasReviewSubtask: boolean;
    /** Cap on auto_resume_* events since the last manual action. When the
     *  count reaches this value, decideFromPrStatus escalates to
     *  NEEDS_ATTENTION instead of returning resumeAgent. */
    maxAutoResumes: number;
    recentAutoResumeCount: number;
  };
  readErrors: WorldReadError[];
  /**
   * The run's agent in its pod and the instance streaming it
   * (docs/plans/scale-out.md §2): the row's own for a Repo Task or Job run,
   * the open turn's for a persistent agent, the active run's for a PR
   * review. Absent or null when nothing runs under the run protocol (a run
   * on a machine, an idle agent, a review between runs).
   */
  execution?: RunExecution | null;
}

// ── Actions ─────────────────────────────────────────────────────────────────

export interface ActionBase {
  reason: string;
}

export type CommonNoop = { kind: "noop" } & ActionBase;
export type CommonRequeue = {
  kind: "requeueSoon";
  delayMs: number;
} & ActionBase;
export type CommonDefer = {
  kind: "deferWithBackoff";
  untilMs: number;
} & ActionBase;
export type CommonClearIntent = { kind: "clearControlIntent" } & ActionBase;

/**
 * The run's agent runs in its pod and no instance streams it: enqueue the
 * kind's attach job (`attachJobId(runId, attempt)`), whose handler claims
 * the attachment by CAS and finishes the run from its consumed offset.
 */
export type CommonReattach = {
  kind: "reattach";
  /** The execution row: the task or Job run, the turn, the review run. */
  runId: string;
  attempt: number;
} & ActionBase;

/**
 * The instance setting the run up went away before its agent started: put
 * the run back where its kind's own retry puts it (a task or review run to
 * `queued`, a Job run through failed to `queued` without spending a retry,
 * an agent's turn halted and the agent back to `idle` with its messages
 * still pending).
 */
export type CommonRequeueRun = {
  kind: "requeueRun";
  /** The execution row, when there is one (a persistent agent may have none yet). */
  runId: string | null;
  trigger: string;
} & ActionBase;

export type RepoTransition = {
  kind: "transition";
  to: TaskState;
  statusPatch?: Partial<RepoRunStatus>;
  clearControlIntent?: boolean;
  trigger: string;
} & ActionBase;

export type RepoPatchStatus = {
  kind: "patchStatus";
  statusPatch: Partial<RepoRunStatus>;
} & ActionBase;

export type StandaloneTransition = {
  kind: "transition";
  to: WorkflowRunState;
  statusPatch?: Partial<StandaloneRunStatus>;
  clearControlIntent?: boolean;
  trigger: string;
} & ActionBase;

export type RepoLaunchReview = { kind: "launchReview" } & ActionBase;
export type RepoAutoMerge = { kind: "autoMergePr" } & ActionBase;
export type RepoResume = {
  kind: "resumeAgent";
  resumeReason: "ci_failure" | "conflicts" | "review";
} & ActionBase;
export type RepoRequeueForAgent = {
  kind: "requeueForAgent";
  statusPatch?: Partial<RepoRunStatus>;
  trigger: string;
} & ActionBase;

export type StandaloneEnqueueAgent = {
  kind: "enqueueAgent";
  trigger: string;
} & ActionBase;

// ── Persistent Agent actions ────────────────────────────────────────────────

export type PersistentAgentTransition = {
  kind: "transition";
  to: PersistentAgentState;
  statusPatch?: Partial<PersistentAgentRunStatus>;
  clearControlIntent?: boolean;
  trigger: string;
} & ActionBase;

export type PersistentAgentEnqueueTurn = {
  kind: "enqueueTurn";
  trigger: string;
  /** Wake source attributable to this turn — informs prompt assembly. */
  wakeSource: "user" | "agent" | "webhook" | "schedule" | "ticket" | "system" | "initial";
} & ActionBase;

export type PersistentAgentPatchStatus = {
  kind: "patchStatus";
  statusPatch: Partial<PersistentAgentRunStatus>;
} & ActionBase;

// ── PR Review actions ───────────────────────────────────────────────────────

export type PrReviewTransition = {
  kind: "transition";
  to: PrReviewState;
  statusPatch?: Partial<PrReviewRunStatus>;
  clearControlIntent?: boolean;
  trigger: string;
} & ActionBase;

export type PrReviewPatchStatus = {
  kind: "patchStatus";
  statusPatch: Partial<PrReviewRunStatus>;
} & ActionBase;

export type PrReviewLaunchRun = {
  kind: "launchReviewRun";
  runKind: PrReviewRunKind;
  trigger: string;
  /** Optional resume-session plumbing for chat turns. */
  resumeSessionId?: string;
  prompt?: string;
} & ActionBase;

export type PrReviewSubmit = { kind: "submitReview"; trigger: string } & ActionBase;
export type PrReviewMarkStale = { kind: "markStale" } & ActionBase;

export type PrReviewAction =
  | CommonNoop
  | CommonRequeue
  | CommonDefer
  | CommonClearIntent
  | CommonReattach
  | CommonRequeueRun
  | PrReviewTransition
  | PrReviewPatchStatus
  | PrReviewLaunchRun
  | PrReviewSubmit
  | PrReviewMarkStale;

export type RepoAction =
  | CommonNoop
  | CommonRequeue
  | CommonDefer
  | CommonClearIntent
  | CommonReattach
  | CommonRequeueRun
  | RepoTransition
  | RepoPatchStatus
  | RepoLaunchReview
  | RepoAutoMerge
  | RepoResume
  | RepoRequeueForAgent;

export type StandaloneAction =
  | CommonNoop
  | CommonRequeue
  | CommonDefer
  | CommonClearIntent
  | CommonReattach
  | CommonRequeueRun
  | StandaloneTransition
  | StandaloneEnqueueAgent;

export type PersistentAgentAction =
  | CommonNoop
  | CommonRequeue
  | CommonDefer
  | CommonClearIntent
  | CommonReattach
  | CommonRequeueRun
  | PersistentAgentTransition
  | PersistentAgentEnqueueTurn
  | PersistentAgentPatchStatus;

export type Action = RepoAction | StandaloneAction | PrReviewAction | PersistentAgentAction;

// ── Helpers ─────────────────────────────────────────────────────────────────

export function isTerminalRepoState(state: TaskState): boolean {
  return state === TaskState.COMPLETED;
}

export function isTerminalStandaloneState(state: WorkflowRunState): boolean {
  return state === WorkflowRunState.COMPLETED;
}

export function isTerminalPrReviewState(state: PrReviewState): boolean {
  return state === PrReviewState.CANCELLED;
}

export const NON_TERMINAL_REPO_STATES: TaskState[] = [
  TaskState.PENDING,
  TaskState.WAITING_ON_DEPS,
  TaskState.QUEUED,
  TaskState.PROVISIONING,
  TaskState.RUNNING,
  TaskState.NEEDS_ATTENTION,
  TaskState.PR_OPENED,
  TaskState.FAILED,
  TaskState.CANCELLED,
];

export const NON_TERMINAL_STANDALONE_STATES: WorkflowRunState[] = [
  WorkflowRunState.QUEUED,
  WorkflowRunState.RUNNING,
  WorkflowRunState.FAILED,
];

// Re-export PR review types for convenience so consumers can do
// `import { PrReviewState, ... } from "@optio/shared"`.
export {
  PrReviewState,
  PrReviewRunState,
  type PrReviewRunKind,
  type PrReviewVerdict,
  type PrReviewOrigin,
  type PrReviewControlIntent,
  type PrReviewFileComment,
};
