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
  workflowRunId: string | null;
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
}

export interface StandaloneRunStatus {
  state: WorkflowRunState;
  costUsd: string | null;
  errorMessage: string | null;
  sessionId: string | null;
  podName: string | null;
  retryCount: number;
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
  | StandaloneTransition
  | StandaloneEnqueueAgent;

export type PersistentAgentAction =
  | CommonNoop
  | CommonRequeue
  | CommonDefer
  | CommonClearIntent
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
