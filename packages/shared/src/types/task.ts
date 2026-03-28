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
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
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

export interface WorkflowStep {
  id: string;
  title: string;
  prompt: string;
  repoUrl?: string;
  agentType?: string;
  dependsOn?: string[];
  condition?: {
    type: "always" | "if_pr_opened" | "if_ci_passes" | "if_cost_under";
    value?: string;
  };
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description?: string;
  workspaceId?: string;
  steps: WorkflowStep[];
  status: "draft" | "active" | "archived";
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowRun {
  id: string;
  workflowTemplateId: string;
  workspaceId?: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  taskMapping?: Record<string, string>;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}
