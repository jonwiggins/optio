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
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
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
