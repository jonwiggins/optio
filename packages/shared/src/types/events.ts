import type { TaskState } from "./task.js";
import type { InteractiveSessionState } from "./session.js";
import type { WorkflowRunState } from "./workflow.js";
import type { PrReviewState, PrReviewRunState } from "./pr-review.js";
import type { PersistentAgentState, PersistentAgentTurnHaltReason } from "./persistent-agent.js";

export type WsEvent =
  | TaskStateChangedEvent
  | TaskLogEvent
  | TaskCreatedEvent
  | TaskPendingReasonEvent
  | TaskStalledEvent
  | TaskRecoveredEvent
  | AuthFailedEvent
  | AuthStatusChangedEvent
  | SessionCreatedEvent
  | SessionEndedEvent
  | TaskCommentEvent
  | TaskMessageEvent
  | TaskMessageDeliveredEvent
  | WorkflowRunStateChangedEvent
  | WorkflowRunLogEvent
  | PrReviewStateChangedEvent
  | PrReviewRunStateChangedEvent
  | PrReviewRunLogEvent
  | PrReviewStaleEvent
  | ActivityNewEvent
  | PersistentAgentStateChangedEvent
  | PersistentAgentTurnStartedEvent
  | PersistentAgentTurnHaltedEvent
  | PersistentAgentMessageEvent
  | PersistentAgentLogEvent;

export interface TaskStateChangedEvent {
  type: "task:state_changed";
  taskId: string;
  fromState: TaskState;
  toState: TaskState;
  timestamp: string;
  /** Cost/token/model fields — populated on terminal-state transitions */
  costUsd?: string;
  inputTokens?: number;
  outputTokens?: number;
  modelUsed?: string;
  /** Reason the task needs attention or failed — populated on needs_attention/failed transitions */
  errorMessage?: string;
}

export interface TaskLogEvent {
  type: "task:log";
  taskId: string;
  stream: "stdout" | "stderr";
  content: string;
  timestamp: string;
}

export interface TaskCreatedEvent {
  type: "task:created";
  taskId: string;
  title: string;
  timestamp: string;
}

export interface TaskPendingReasonEvent {
  type: "task:pending_reason";
  taskId: string;
  data: { pendingReason: string | null };
}

export interface AuthFailedEvent {
  type: "auth:failed";
  message: string;
  timestamp: string;
}

export interface AuthStatusChangedEvent {
  type: "auth:status_changed";
  timestamp: string;
}

export interface SessionCreatedEvent {
  type: "session:created";
  sessionId: string;
  repoUrl: string;
  state: InteractiveSessionState;
  timestamp: string;
}

export interface SessionEndedEvent {
  type: "session:ended";
  sessionId: string;
  timestamp: string;
}

export interface TaskStalledEvent {
  type: "task:stalled";
  taskId: string;
  lastActivityAt: string; // ISO
  silentForMs: number;
  lastLogSummary?: string; // e.g. "Bash $ npm test"
  timestamp: string;
}

export interface TaskRecoveredEvent {
  type: "task:recovered";
  taskId: string;
  silentWasMs: number;
  timestamp: string;
}

export interface TaskCommentEvent {
  type: "task:comment";
  taskId: string;
  commentId: string;
  timestamp: string;
}

export interface TaskMessageEvent {
  type: "task:message";
  taskId: string;
  messageId: string;
  userId: string | null;
  userDisplayName: string | null;
  content: string;
  mode: "soft" | "interrupt";
  createdAt: string;
}

export interface TaskMessageDeliveredEvent {
  type: "task:message_delivered" | "task:message_acked";
  taskId: string;
  messageId: string;
  timestamp: string;
}

// ── Activity Events ─────────────────────────────────────────────────────────

export interface ActivityNewEvent {
  type: "activity:new";
  action: string;
  userId?: string;
  resourceType?: string;
  resourceId?: string;
  summary: string;
  timestamp: string;
}

// ── Workflow Run Events ─────────────────────────────────────────────────────

export interface WorkflowRunStateChangedEvent {
  type: "workflow_run:state_changed";
  workflowRunId: string;
  workflowId: string;
  fromState: WorkflowRunState;
  toState: WorkflowRunState;
  timestamp: string;
  costUsd?: string;
  inputTokens?: number;
  outputTokens?: number;
  modelUsed?: string;
  errorMessage?: string;
}

export interface WorkflowRunLogEvent {
  type: "workflow_run:log";
  workflowRunId: string;
  stream: "stdout" | "stderr";
  content: string;
  timestamp: string;
  logType?: string;
  metadata?: Record<string, unknown>;
}

// ── PR Review Events ────────────────────────────────────────────────────────

export interface PrReviewStateChangedEvent {
  type: "pr_review:state_changed";
  prReviewId: string;
  fromState: PrReviewState | null;
  toState: PrReviewState;
  trigger: string;
  timestamp: string;
}

export interface PrReviewRunStateChangedEvent {
  type: "pr_review_run:state_changed";
  prReviewId: string;
  runId: string;
  fromState: PrReviewRunState | null;
  toState: PrReviewRunState;
  timestamp: string;
}

export interface PrReviewRunLogEvent {
  type: "pr_review_run:log";
  prReviewId: string;
  runId: string;
  stream: "stdout" | "stderr";
  content: string;
  timestamp: string;
  logType?: string;
  metadata?: Record<string, unknown>;
}

export interface PrReviewStaleEvent {
  type: "pr_review:stale";
  prReviewId: string;
  timestamp: string;
}

// ── Persistent Agent Events ─────────────────────────────────────────────────

export interface PersistentAgentStateChangedEvent {
  type: "persistent_agent:state_changed";
  agentId: string;
  agentSlug: string;
  fromState: PersistentAgentState | null;
  toState: PersistentAgentState;
  trigger: string;
  timestamp: string;
  errorMessage?: string;
}

export interface PersistentAgentTurnStartedEvent {
  type: "persistent_agent:turn_started";
  agentId: string;
  agentSlug: string;
  turnId: string;
  turnNumber: number;
  wakeSource: string;
  timestamp: string;
}

export interface PersistentAgentTurnHaltedEvent {
  type: "persistent_agent:turn_halted";
  agentId: string;
  agentSlug: string;
  turnId: string;
  turnNumber: number;
  haltReason: PersistentAgentTurnHaltReason;
  costUsd?: string;
  inputTokens?: number;
  outputTokens?: number;
  errorMessage?: string;
  summary?: string;
  timestamp: string;
}

export interface PersistentAgentMessageEvent {
  type: "persistent_agent:message";
  agentId: string;
  agentSlug: string;
  messageId: string;
  senderType: "user" | "agent" | "system" | "external";
  senderId: string | null;
  senderName: string | null;
  body: string;
  broadcasted: boolean;
  timestamp: string;
}

export interface PersistentAgentLogEvent {
  type: "persistent_agent:log";
  agentId: string;
  agentSlug: string;
  turnId: string;
  stream: "stdout" | "stderr";
  content: string;
  logType?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}
