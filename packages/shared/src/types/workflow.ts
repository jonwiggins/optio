// ── Workflow types (new Workflows data model) ────────────────────────────────

import type { LocalAgentSessionMode, RunTarget } from "./local.js";

export enum WorkflowRunState {
  QUEUED = "queued",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  /** Documented by the API (`WorkflowRunSchema`); a user's cancel is stored as `failed` today. */
  CANCELLED = "cancelled",
}

export enum WorkflowTriggerType {
  MANUAL = "manual",
  SCHEDULE = "schedule",
  WEBHOOK = "webhook",
  TICKET = "ticket",
  GITHUB = "github",
  GITLAB = "gitlab",
  SLACK = "slack",
  LINEAR = "linear",
  JIRA = "jira",
  PYLON = "pylon",
  PAGERDUTY = "pagerduty",
  SENTRY = "sentry",
  ALERTMANAGER = "alertmanager",
  DATADOG = "datadog",
}

export interface Workflow {
  id: string;
  name: string;
  description?: string | null;
  workspaceId?: string | null;
  environmentSpec?: Record<string, unknown> | null;
  promptTemplate: string;
  /** `{{param}}` template each run is named from; null = the workflow's name. */
  runTitle?: string | null;
  paramsSchema?: Record<string, unknown> | null;
  agentRuntime: string;
  model?: string | null;
  maxTurns?: number | null;
  budgetUsd?: string | null;
  maxConcurrent: number;
  maxRetries: number;
  warmPoolSize: number;
  /** Where runs execute: an Optio pod (`cluster`, default) or the owner's machine (`local`). */
  runTarget: RunTarget;
  localHostId?: string | null;
  localDir?: string | null;
  localSessionMode?: LocalAgentSessionMode | null;
  enabled: boolean;
  createdBy?: string | null;
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
  /** The workflow's runTitle rendered with this run's params; null = no template. */
  title?: string | null;
  state: WorkflowRunState;
  output?: Record<string, unknown> | null;
  costUsd?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  modelUsed?: string | null;
  errorMessage?: string | null;
  sessionId?: string | null;
  podName?: string | null;
  /** Local runs: the `local_terminals` row executing this run. */
  localTerminalId?: string | null;
  retryCount: number;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Workflow run state machine ───────────────────────────────────────────────

const VALID_WORKFLOW_RUN_TRANSITIONS: Record<WorkflowRunState, WorkflowRunState[]> = {
  [WorkflowRunState.QUEUED]: [WorkflowRunState.RUNNING, WorkflowRunState.FAILED],
  [WorkflowRunState.RUNNING]: [WorkflowRunState.COMPLETED, WorkflowRunState.FAILED],
  [WorkflowRunState.COMPLETED]: [],
  [WorkflowRunState.FAILED]: [WorkflowRunState.QUEUED],
  [WorkflowRunState.CANCELLED]: [],
};

export function canTransitionWorkflowRun(from: WorkflowRunState, to: WorkflowRunState): boolean {
  return VALID_WORKFLOW_RUN_TRANSITIONS[from]?.includes(to) ?? false;
}
