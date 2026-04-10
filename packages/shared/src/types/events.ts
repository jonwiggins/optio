import type { TaskState } from "./task.js";
import type { InteractiveSessionState } from "./session.js";
import type { WorkflowRunState } from "./workflow.js";
import type { AgentLogEntry } from "./agent-events.js";

export type WsEvent =
  | TaskStateChangedEvent
  | TaskLogEvent
  | TaskCreatedEvent
  | TaskPendingReasonEvent
  | TaskStalledEvent
  | TaskRecoveredEvent
  | AuthFailedEvent
  | SessionCreatedEvent
  | SessionEndedEvent
  | TaskCommentEvent
  | TaskMessageEvent
  | TaskMessageDeliveredEvent
  | WorkflowRunStateChangedEvent
  | WorkflowRunLogEvent;

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

export interface WorkflowRunStateChangedEvent {
  type: "workflow_run:state_changed";
  workflowRunId: string;
  fromState: WorkflowRunState;
  toState: WorkflowRunState;
  timestamp: string;
}

export interface WorkflowRunLogEvent {
  type: "workflow_run:log";
  workflowRunId: string;
  entry: AgentLogEntry;
}
