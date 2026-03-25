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
