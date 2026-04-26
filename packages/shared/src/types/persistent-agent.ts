// ── Persistent Agent types ──────────────────────────────────────────────────
//
// Long-lived, named, message-driven agent processes. See docs/persistent-agents.md.

export enum PersistentAgentState {
  IDLE = "idle",
  QUEUED = "queued",
  PROVISIONING = "provisioning",
  RUNNING = "running",
  PAUSED = "paused",
  FAILED = "failed",
  ARCHIVED = "archived",
}

export enum PersistentAgentPodLifecycle {
  ALWAYS_ON = "always-on",
  STICKY = "sticky",
  ON_DEMAND = "on-demand",
}

export type PersistentAgentWakeSource =
  | "user"
  | "agent"
  | "webhook"
  | "schedule"
  | "ticket"
  | "system"
  | "initial";

export type PersistentAgentControlIntent = "pause" | "resume" | "archive" | "restart";

export type PersistentAgentTurnHaltReason =
  | "natural"
  | "wait_tool"
  | "max_duration"
  | "max_turns"
  | "error"
  | "cancelled";

export type PersistentAgentMessageSenderType = "user" | "agent" | "system" | "external";

export interface PersistentAgent {
  id: string;
  workspaceId?: string | null;
  slug: string;
  name: string;
  description?: string | null;
  agentRuntime: string;
  model?: string | null;
  systemPrompt?: string | null;
  agentsMd?: string | null;
  initialPrompt: string;
  promptTemplateId?: string | null;
  repoId?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  podLifecycle: PersistentAgentPodLifecycle;
  idlePodTimeoutMs: number;
  stickyPodId?: string | null;
  maxTurnDurationMs: number;
  maxTurns: number;
  consecutiveFailureLimit: number;
  state: PersistentAgentState;
  enabled: boolean;
  totalCostUsd: string;
  consecutiveFailures: number;
  lastFailureAt?: Date | null;
  lastFailureReason?: string | null;
  lastTurnAt?: Date | null;
  sessionId?: string | null;
  controlIntent?: PersistentAgentControlIntent | null;
  reconcileBackoffUntil?: Date | null;
  reconcileAttempts: number;
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PersistentAgentTurn {
  id: string;
  agentId: string;
  turnNumber: number;
  wakeSource: PersistentAgentWakeSource;
  wakePayload?: Record<string, unknown> | null;
  promptUsed?: string | null;
  podId?: string | null;
  podName?: string | null;
  haltReason?: PersistentAgentTurnHaltReason | null;
  errorMessage?: string | null;
  costUsd?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  sessionId?: string | null;
  summary?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
}

export interface PersistentAgentMessage {
  id: string;
  agentId: string;
  senderType: PersistentAgentMessageSenderType;
  senderId?: string | null;
  senderName?: string | null;
  body: string;
  structuredPayload?: Record<string, unknown> | null;
  broadcasted: boolean;
  receivedAt: Date;
  processedAt?: Date | null;
  turnId?: string | null;
}

export interface PersistentAgentPod {
  id: string;
  agentId: string;
  workspaceId?: string | null;
  podName?: string | null;
  podId?: string | null;
  state: "provisioning" | "ready" | "error" | "terminating";
  lastTurnAt?: Date | null;
  keepWarmUntil?: Date | null;
  errorMessage?: string | null;
  jobName?: string | null;
  managedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── State machine ──────────────────────────────────────────────────────────
//
// Cyclic — unlike Tasks which run once and terminate, a Persistent Agent
// returns to `idle` after each turn and waits for the next wake event.

const VALID_PA_TRANSITIONS: Record<PersistentAgentState, PersistentAgentState[]> = {
  [PersistentAgentState.IDLE]: [
    PersistentAgentState.QUEUED,
    PersistentAgentState.PAUSED,
    PersistentAgentState.ARCHIVED,
  ],
  [PersistentAgentState.QUEUED]: [
    PersistentAgentState.PROVISIONING,
    PersistentAgentState.IDLE, // requeue/cancel
    PersistentAgentState.PAUSED,
    PersistentAgentState.ARCHIVED,
  ],
  [PersistentAgentState.PROVISIONING]: [
    PersistentAgentState.RUNNING,
    PersistentAgentState.IDLE, // pod ready handoff failure → back to idle
    PersistentAgentState.FAILED,
    PersistentAgentState.PAUSED,
    PersistentAgentState.ARCHIVED,
  ],
  [PersistentAgentState.RUNNING]: [
    PersistentAgentState.IDLE, // turn halted normally
    PersistentAgentState.FAILED, // turn errored past failure limit
    PersistentAgentState.PAUSED,
    PersistentAgentState.ARCHIVED,
  ],
  [PersistentAgentState.PAUSED]: [PersistentAgentState.IDLE, PersistentAgentState.ARCHIVED],
  [PersistentAgentState.FAILED]: [PersistentAgentState.IDLE, PersistentAgentState.ARCHIVED],
  [PersistentAgentState.ARCHIVED]: [], // terminal
};

export class InvalidPersistentAgentTransitionError extends Error {
  constructor(
    public readonly from: PersistentAgentState,
    public readonly to: PersistentAgentState,
  ) {
    super(`Invalid persistent agent transition: ${from} → ${to}`);
    this.name = "InvalidPersistentAgentTransitionError";
  }
}

export function canTransitionPersistentAgent(
  from: PersistentAgentState,
  to: PersistentAgentState,
): boolean {
  return VALID_PA_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionPersistentAgent(
  from: PersistentAgentState,
  to: PersistentAgentState,
): PersistentAgentState {
  if (!canTransitionPersistentAgent(from, to)) {
    throw new InvalidPersistentAgentTransitionError(from, to);
  }
  return to;
}

export function isTerminalPersistentAgentState(state: PersistentAgentState): boolean {
  return VALID_PA_TRANSITIONS[state]?.length === 0;
}

// ── Inter-agent message envelope ──────────────────────────────────────────
//
// Wire format used when injecting messages into a turn's prompt. Same-shape
// across user, agent, and system senders so the receiving agent can handle
// them uniformly. Mirrors Scion's structured message block.

export const PERSISTENT_AGENT_MESSAGE_BEGIN = "---BEGIN OPTIO MESSAGE---";
export const PERSISTENT_AGENT_MESSAGE_END = "---END OPTIO MESSAGE---";

export interface PersistentAgentMessageEnvelope {
  version: 1;
  timestamp: string; // ISO-8601
  sender: string; // "user:<email|id>" | "agent:<workspace>/<slug>" | "system:<label>" | "external:<label>"
  type: "instruction" | "broadcast" | "reply" | "event";
  broadcasted: boolean;
  body: string;
  payload?: Record<string, unknown>;
}

export function formatMessageEnvelope(envelope: PersistentAgentMessageEnvelope): string {
  return [
    PERSISTENT_AGENT_MESSAGE_BEGIN,
    JSON.stringify(envelope),
    PERSISTENT_AGENT_MESSAGE_END,
  ].join("\n");
}

export function buildSenderId(args: {
  type: PersistentAgentMessageSenderType;
  workspaceId?: string | null;
  slug?: string | null;
  userId?: string | null;
  label?: string | null;
}): string {
  switch (args.type) {
    case "user":
      return `user:${args.userId ?? args.label ?? "unknown"}`;
    case "agent":
      return `agent:${args.workspaceId ?? "default"}/${args.slug ?? "unknown"}`;
    case "system":
      return `system:${args.label ?? "optio"}`;
    case "external":
      return `external:${args.label ?? "unknown"}`;
  }
}
