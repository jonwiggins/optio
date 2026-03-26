export enum InteractiveSessionState {
  ACTIVE = "active",
  ENDED = "ended",
}

export interface InteractiveSession {
  id: string;
  repoUrl: string;
  userId: string | null;
  worktreePath: string | null;
  branch: string;
  state: InteractiveSessionState;
  podId: string | null;
  costUsd: string | null;
  createdAt: string;
  endedAt: string | null;
}

export interface SessionPr {
  id: string;
  sessionId: string;
  prUrl: string;
  prNumber: number;
  prState: string | null; // "open" | "merged" | "closed"
  prChecksStatus: string | null; // "pending" | "passing" | "failing" | "none"
  prReviewStatus: string | null; // "approved" | "changes_requested" | "pending" | "none"
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionInput {
  repoUrl: string;
}

/** Client → Server message for the session chat WebSocket */
export type SessionChatClientMessage =
  | { type: "message"; content: string }
  | { type: "interrupt" }
  | { type: "set_model"; model: string };

/** Server → Client message for the session chat WebSocket */
export type SessionChatServerMessage =
  | { type: "chat_event"; event: SessionChatEvent }
  | { type: "cost_update"; costUsd: number }
  | { type: "status"; status: SessionChatStatus; model?: string; costUsd?: number }
  | { type: "error"; message: string };

export type SessionChatStatus = "ready" | "thinking" | "idle" | "error";

export interface SessionChatEvent {
  taskId: string;
  timestamp: string;
  sessionId?: string;
  type: "text" | "tool_use" | "tool_result" | "thinking" | "system" | "error" | "info";
  content: string;
  metadata?: {
    toolName?: string;
    toolInput?: Record<string, unknown>;
    cost?: number;
    turns?: number;
    durationMs?: number;
    [key: string]: unknown;
  };
}
