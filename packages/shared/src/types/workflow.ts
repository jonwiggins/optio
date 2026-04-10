// ── Workflow types (new Workflows data model) ────────────────────────────────

export enum WorkflowRunState {
  QUEUED = "queued",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
}

export enum WorkflowTriggerType {
  MANUAL = "manual",
  SCHEDULE = "schedule",
  WEBHOOK = "webhook",
}

export interface Workflow {
  id: string;
  name: string;
  description?: string | null;
  workspaceId?: string | null;
  environmentSpec?: Record<string, unknown> | null;
  promptTemplate: string;
  paramsSchema?: Record<string, unknown> | null;
  agentRuntime: string;
  model?: string | null;
  maxTurns?: number | null;
  budgetUsd?: string | null;
  maxConcurrent: number;
  maxRetries: number;
  warmPoolSize: number;
  enabled: boolean;
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowTrigger {
  id: string;
  workflowId: string;
  type: WorkflowTriggerType;
  config?: Record<string, unknown> | null;
  paramMapping?: Record<string, unknown> | null;
  enabled: boolean;
  lastFiredAt?: Date | null;
  nextFireAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  triggerId?: string | null;
  params?: Record<string, unknown> | null;
  state: WorkflowRunState;
  output?: Record<string, unknown> | null;
  costUsd?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  modelUsed?: string | null;
  errorMessage?: string | null;
  sessionId?: string | null;
  podName?: string | null;
  retryCount: number;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export enum WorkflowPodState {
  PROVISIONING = "provisioning",
  READY = "ready",
  ERROR = "error",
  TERMINATING = "terminating",
}

export interface WorkflowPod {
  id: string;
  workflowRunId: string;
  workspaceId?: string | null;
  podName: string | null;
  podId: string | null;
  state: WorkflowPodState;
  activeRunCount: number;
  lastRunAt?: Date | null;
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Workflow run state machine ───────────────────────────────────────────────

const VALID_WORKFLOW_RUN_TRANSITIONS: Record<WorkflowRunState, WorkflowRunState[]> = {
  [WorkflowRunState.QUEUED]: [WorkflowRunState.RUNNING, WorkflowRunState.FAILED],
  [WorkflowRunState.RUNNING]: [WorkflowRunState.COMPLETED, WorkflowRunState.FAILED],
  [WorkflowRunState.COMPLETED]: [],
  [WorkflowRunState.FAILED]: [WorkflowRunState.QUEUED],
};

export function canTransitionWorkflowRun(from: WorkflowRunState, to: WorkflowRunState): boolean {
  return VALID_WORKFLOW_RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionWorkflowRun(
  from: WorkflowRunState,
  to: WorkflowRunState,
): WorkflowRunState {
  if (!canTransitionWorkflowRun(from, to)) {
    throw new Error(`Invalid workflow run transition: ${from} → ${to}`);
  }
  return to;
}

export function isTerminalWorkflowRunState(state: WorkflowRunState): boolean {
  return VALID_WORKFLOW_RUN_TRANSITIONS[state]?.length === 0;
}
