import { TaskState } from "../types/task.js";
import { WorkflowRunState } from "../types/workflow.js";

// ── Identity ────────────────────────────────────────────────────────────────

export type RunKind = "repo" | "standalone";

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
   * "coding" — agent opens a PR; full PR-reactive state machine applies
   *   (auto-merge, auto-resume on CI fail, review triggers).
   * "review" — internal review subtask of a coding task; no PR of its own.
   * "pr_review" — external PR review; references a PR via `review_drafts`,
   *   not `tasks.prUrl`. Reconciler treats this as non-PR-reactive.
   *
   * Only "coding" tasks drive PR-reactive behavior. New task types default
   * to non-reactive unless explicitly opted into the coding branch.
   */
  taskType: "coding" | "review" | "pr_review";
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

export type Run =
  | { kind: "repo"; ref: RunRef; spec: RepoRunSpec; status: RepoRunStatus }
  | {
      kind: "standalone";
      ref: RunRef;
      spec: StandaloneRunSpec;
      status: StandaloneRunStatus;
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

export type Action = RepoAction | StandaloneAction;

// ── Helpers ─────────────────────────────────────────────────────────────────

export function isTerminalRepoState(state: TaskState): boolean {
  return state === TaskState.COMPLETED;
}

export function isTerminalStandaloneState(state: WorkflowRunState): boolean {
  return state === WorkflowRunState.COMPLETED;
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
