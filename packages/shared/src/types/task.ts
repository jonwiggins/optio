import type { LocalAgentSessionMode, RunTarget } from "./local.js";

export enum TaskState {
  PENDING = "pending",
  WAITING_ON_DEPS = "waiting_on_deps",
  QUEUED = "queued",
  PROVISIONING = "provisioning",
  RUNNING = "running",
  NEEDS_ATTENTION = "needs_attention",
  PR_OPENED = "pr_opened",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export type TaskActivitySubstate = "active" | "stalled" | "recovered";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  repoUrl: string;
  repoBranch: string;
  state: TaskState;
  agentType: string;
  containerId?: string;
  prUrl?: string;
  resultSummary?: string;
  errorMessage?: string;
  ticketSource?: string;
  ticketExternalId?: string;
  metadata?: Record<string, unknown>;
  retryCount: number;
  maxRetries: number;
  lastActivityAt?: Date;
  activitySubstate?: TaskActivitySubstate;
  /** Where the agent runs: an Optio pod (`cluster`, default) or the owner's machine (`local`). */
  runTarget?: RunTarget;
  localHostId?: string | null;
  localDir?: string | null;
  localSessionMode?: LocalAgentSessionMode | null;
  /** Local runs: the `local_terminals` row executing this task. */
  localTerminalId?: string | null;
  /**
   * Who the work belongs to: null = the organization; set = one person's own.
   * Personal work runs with that person's secrets, model providers and
   * connections, and only they can change it.
   */
  ownerUserId?: string | null;
  /**
   * The secrets (by name) the agent gets in its pod. Null = the workspace's
   * legacy behavior (see `Workspace.restrictPodSecrets`).
   */
  podSecrets?: string[] | null;
  /**
   * Every PR the task opened or tracks (GET /api/tasks/:id only). `prUrl`
   * stays the primary one, which the PR lifecycle follows.
   */
  prs?: TaskPr[];
  /**
   * PR follow-through over the repo's settings ("Works until merged"): resume
   * the agent on failing CI, conflicts, and requested changes / merge once
   * it's green. Null or absent = the repo's `autoResume` / `autoMerge`.
   */
  autoResume?: boolean | null;
  autoMerge?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * How Optio learned a PR belongs to a task: the agent's own PR-creating tool
 * call (`tool_call`), a PR whose head branch is under the task's branch
 * (`branch`), or a person attached it (`attached`).
 */
export type TaskPrSource = "tool_call" | "branch" | "attached";

/** A pull / merge request a task opened or tracks. */
export interface TaskPr {
  id: string;
  taskId: string;
  repoUrl: string;
  number: number;
  url: string;
  headBranch: string | null;
  /** `owner/repo` of the head branch (a fork's differs from the task's repo). */
  headRepo: string | null;
  baseBranch: string | null;
  source: TaskPrSource;
  /** `open` / `merged` / `closed` when last seen. */
  state: string;
  /** True for the task's primary PR (`tasks.pr_url`). */
  primary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StallInfo {
  isStalled: boolean;
  silentForMs: number;
  thresholdMs: number;
  lastLogSummary?: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  fromState?: TaskState;
  toState: TaskState;
  trigger: string;
  message?: string;
  userId?: string;
  createdAt: Date;
}

export interface TaskComment {
  id: string;
  taskId: string;
  userId?: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  user?: {
    id: string;
    displayName: string;
    avatarUrl?: string;
  };
}

export type TaskMessageMode = "soft" | "interrupt";

export interface TaskMessage {
  id: string;
  taskId: string;
  userId?: string;
  content: string;
  mode: TaskMessageMode;
  workspaceId?: string;
  createdAt: Date;
  deliveredAt?: Date | null;
  ackedAt?: Date | null;
  deliveryError?: string | null;
  user?: {
    id: string;
    displayName: string;
    avatarUrl?: string;
  };
}

export interface CreateTaskInput {
  title: string;
  prompt: string;
  repoUrl: string;
  repoBranch?: string;
  agentType: string;
  ticketSource?: string;
  ticketExternalId?: string;
  metadata?: Record<string, unknown>;
  maxRetries?: number;
  priority?: number;
  dependsOn?: string[];
  createdBy?: string;
  /** Run location; defaults to `cluster`. Local runs need `localHostId` + `localDir`. */
  runTarget?: RunTarget;
  localHostId?: string | null;
  localDir?: string | null;
  localSessionMode?: LocalAgentSessionMode | null;
  /** PR follow-through over the repo's settings; see `Task.autoResume`. */
  autoResume?: boolean | null;
  autoMerge?: boolean | null;
}

// ── Review Draft types (PR Review Assistant) ────────────────────────────────

export interface ReviewFileComment {
  path: string;
  line?: number;
  side?: string;
  body: string;
}

export interface ReviewDraft {
  id: string;
  taskId: string;
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  headSha: string;
  state: "drafting" | "ready" | "submitted" | "stale";
  verdict: "approve" | "request_changes" | "comment" | null;
  summary: string | null;
  fileComments: ReviewFileComment[] | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
