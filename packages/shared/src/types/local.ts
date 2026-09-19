// Optio Local — terminals on a user's own machine, managed via the daemon
// (`optio local up`). See docs/optio-local.md for the full protocol.

import type { WorkLink } from "../utils/extract-work-links.js";
import type { LocalTerminalUsage } from "../utils/agent-usage.js";

export type LocalHostState = "online" | "offline";

export interface LocalHostDir {
  path: string;
  /** Normalized git remote URL detected for the dir, when it is a git repo. */
  repoUrl?: string;
}

/** One rate-limit window as an agent CLI reports it. */
export interface AgentLimitWindow {
  /** 0–100. */
  usedPercent: number;
  windowMinutes: number | null;
  /** ISO time the window resets, when known. */
  resetsAt: string | null;
}

/**
 * Agent subscription limits the daemon reads off the machine (no tokens
 * leave the laptop). Codex: the newest `rate_limits` snapshot in its
 * session logs, so it's only as fresh as the last Codex turn — hence
 * `observedAt`.
 */
export interface LocalHostAgentLimits {
  codex?: {
    primary: AgentLimitWindow | null;
    secondary: AgentLimitWindow | null;
    planType: string | null;
    observedAt: string;
  };
}

export interface LocalHost {
  id: string;
  /** Null only in auth-disabled dev installs. */
  userId: string | null;
  workspaceId: string | null;
  name: string;
  hostname: string;
  platform: string;
  arch: string | null;
  daemonVersion: string | null;
  dirs: LocalHostDir[];
  /** Agent subscription limits read from the machine; null until reported. */
  agentLimits: LocalHostAgentLimits | null;
  /**
   * Whether the connected daemon can hand Optio a fresh Claude OAuth token
   * from the machine's own Claude Code login (Keychain / credentials file).
   * Live (from the daemon's hello), so false whenever the host is offline.
   */
  claudeCredentials?: boolean;
  state: LocalHostState;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LocalTerminalState = "pending" | "launching" | "running" | "exited" | "error";

/** Why a terminal is sitting in `pending`. */
export type LocalTerminalPendingReason = "hold" | "host_offline";

export type LocalAttentionState = "working" | "needs_you" | "idle";

/**
 * What created a terminal. `job` / `task` terminals back a Job run
 * (`workflow_runs`) or a Repo Task (`tasks`) whose run location is a local
 * host — their lifecycle drives the run's state (see
 * `services/local-run-service.ts`).
 */
export type LocalSpawnSource =
  | "manual"
  | "ticket"
  | "trigger"
  | "blueprint"
  | "api"
  | "resume"
  | "job"
  | "task";

/**
 * What happens once an agent finishes its first turn.
 * - `interactive`: the agent halts at its prompt and waits for you (the
 *   session lands in the "needs you" queue; you can chat with it).
 * - `headless`: the agent runs in one-shot / print mode and the process exits
 *   when the turn is done. The transcript is kept, so the session can still be
 *   resumed into an interactive chat later.
 */
export type LocalAgentSessionMode = "interactive" | "headless";

/** How the daemon should build the process for a terminal. */
export type LocalTerminalSpec =
  | { kind: "shell" }
  | { kind: "command"; command: string }
  | {
      kind: "agent";
      agent: LocalAgentKind;
      prompt?: string;
      /** Default `interactive`. */
      mode?: LocalAgentSessionMode;
      /**
       * Resume a previous agent session (its id as reported by the agent's
       * hooks) instead of starting a fresh one. Interactive unless the agent
       * supports a headless resume (Claude Code: `claude -p --resume`).
       */
      resumeSessionId?: string;
      /** Model override passed to the agent CLI (`--model` / `-m`), when set. */
      model?: string;
    };

/** Agent CLIs the daemon knows how to launch (and, for claude-code, hook). */
export type LocalAgentKind = "claude-code" | "codex" | "cursor" | "gemini" | "opencode";

export const LOCAL_AGENT_KINDS: readonly LocalAgentKind[] = [
  "claude-code",
  "codex",
  "cursor",
  "gemini",
  "opencode",
];

/**
 * Map a Task / Job agent runtime (`agentType` / `agentRuntime`) onto the
 * agent CLI the local daemon launches. Null for cluster-only runtimes
 * (copilot, openclaw) — a run pinned to a local host can't use those.
 */
export function toLocalAgentKind(agentType: string | null | undefined): LocalAgentKind | null {
  return agentType && (LOCAL_AGENT_KINDS as readonly string[]).includes(agentType)
    ? (agentType as LocalAgentKind)
    : null;
}

// ── Run location ────────────────────────────────────────────────────────────
// Shared by Repo Tasks (`tasks`), their blueprints (`task_configs`), and Jobs
// (`workflows`): where the agent executes.

/**
 * `cluster` — an Optio-managed Kubernetes pod (the default).
 * `local` — the owner's own machine, in an allowlisted directory, through the
 * Optio Local daemon. The run is backed by a `local_terminals` row and uses
 * the machine's own agent CLI + auth (no server secrets leave the cluster).
 */
export type RunTarget = "cluster" | "local";

export const RUN_TARGETS: readonly RunTarget[] = ["cluster", "local"];

export interface RunLocation {
  runTarget: RunTarget;
  /** Local runs: the paired host (`local_hosts.id`). */
  localHostId: string | null;
  /** Local runs: absolute directory on the host, inside its allowlist. */
  localDir: string | null;
  /**
   * Local agent runs: `headless` (default) runs the agent's one-shot entry
   * point and exits when the turn is done; `interactive` keeps the session
   * open at the agent's prompt so you can keep chatting.
   */
  localSessionMode: LocalAgentSessionMode | null;
}

/**
 * One entry of an agent session's conversation, distilled by the daemon from
 * the agent CLI's own transcript (Claude Code's JSONL at the hooks'
 * `transcript_path`). Unlike the terminal's screen — which for a full-screen
 * TUI holds only the last redraw — this is the whole exchange: every prompt,
 * every reply, every tool call and its result, as plain text that reflows to
 * any screen. `seq` is the daemon's per-terminal counter, 1-based and
 * monotonic; the server stores entries keyed by it so a re-sent batch is
 * idempotent.
 */
export type LocalTranscriptRole = "user" | "assistant" | "tool";
export type LocalTranscriptKind = "text" | "thinking" | "tool_use" | "tool_result";

export interface LocalTranscriptEntry {
  seq: number;
  role: LocalTranscriptRole;
  kind: LocalTranscriptKind;
  /** The prompt / reply / thinking text, a tool call's one-line summary, or the tool's result. */
  text: string;
  /** `tool_use`: the full input (JSON, bounded); `tool_result`: unused. */
  detail: string | null;
  toolName: string | null;
  /** Pairs a `tool_use` with its `tool_result`. */
  toolUseId: string | null;
  isError: boolean;
  /** The transcript line's timestamp, when it carried one. */
  at: string | null;
}

/** Longest `text` the server keeps per entry (a reply is rarely near this; tool results are cut). */
export const LOCAL_TRANSCRIPT_TEXT_MAX = 16 * 1024;
/** Longest `detail` (a tool call's full input) kept per entry. */
export const LOCAL_TRANSCRIPT_DETAIL_MAX = 8 * 1024;
/** Entries kept per terminal; later ones are dropped (the daemon stops sending past it). */
export const LOCAL_TRANSCRIPT_MAX_ENTRIES = 20_000;

export interface LocalTerminal {
  id: string;
  hostId: string;
  /** Null only in auth-disabled dev installs. */
  userId: string | null;
  workspaceId: string | null;
  title: string;
  dir: string;
  /** Display string of what runs in the terminal (not re-executed from here). */
  command: string | null;
  spec: LocalTerminalSpec;
  state: LocalTerminalState;
  pendingReason: LocalTerminalPendingReason | null;
  exitCode: number | null;
  errorMessage: string | null;
  attentionState: LocalAttentionState;
  attentionReason: string | null;
  spawnedBy: LocalSpawnSource;
  blueprintId: string | null;
  triggerId: string | null;
  ticketSource: string | null;
  ticketExternalId: string | null;
  ticketUrl: string | null;
  /**
   * The agent CLI's own session id (Claude Code `session_id` from hooks).
   * Lets an exited run be resumed as an interactive chat.
   */
  agentSessionId: string | null;
  /** The Job run (`workflow_runs.id`) this terminal executes, for `spawnedBy: "job"`. */
  workflowRunId: string | null;
  /** The Repo Task (`tasks.id`) this terminal executes, for `spawnedBy: "task"`. */
  taskId: string | null;
  preview: string | null;
  /** PR / ticket links the daemon spotted in the output (first-seen order). */
  links: WorkLink[];
  /** Token / cost totals the daemon summed from the agent's transcript (agent spawns only). */
  usage: LocalTerminalUsage | null;
  costUsd: string | null;
  lastActivityAt: string | null;
  /**
   * "Later": while set and in the future the terminal is not in the needs-you
   * queue (Watch, widgets, push). Cleared by DELETE /snooze or by expiry.
   */
  snoozedUntil?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export type LocalBlueprintSpawnMode = "auto" | "hold";

export interface LocalBlueprint {
  id: string;
  /** Null only in auth-disabled dev installs. */
  userId: string | null;
  workspaceId: string | null;
  name: string;
  description: string | null;
  /** Pinned host, or null = any online host owned by the user. */
  hostId: string | null;
  /** Working dir; null = resolve via repoUrl against the host's dir list. */
  dir: string | null;
  repoUrl: string | null;
  /**
   * Rendered with {{param}} substitution. When `agent` is null the result is a
   * shell command and params are shell-quoted first; when `agent` is set the
   * result is the agent's prompt (a single quoted argv element), so params are
   * substituted raw.
   */
  commandTemplate: string;
  /** Non-null = run the rendered template as this agent (gets attention hooks). */
  agent: LocalAgentKind | null;
  spawnMode: LocalBlueprintSpawnMode;
  /** Agent spawns only: stay open for chat, or exit when the turn is done. */
  sessionMode: LocalAgentSessionMode;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Automation triggers ─────────────────────────────────────────────────────
// Rows in `workflow_triggers` with target_type = "local_blueprint". The classic
// four (manual / schedule / webhook / ticket) are shared with Jobs and Task
// Configs; `github` / `slack` / `linear` are event triggers fed by the signed
// ingress endpoints under /api/webhooks/*.

export type LocalTriggerType =
  | "manual"
  | "schedule"
  | "webhook"
  | "ticket"
  | "github"
  | "slack"
  | "linear";

export const LOCAL_TRIGGER_TYPES: readonly LocalTriggerType[] = [
  "manual",
  "schedule",
  "webhook",
  "ticket",
  "github",
  "slack",
  "linear",
];

/** Things that can happen to you on GitHub. */
export type LocalGitHubEventKind =
  | "review_requested"
  | "mentioned"
  | "assigned"
  | "pr_opened"
  | "issue_opened";

export const LOCAL_GITHUB_EVENT_KINDS: readonly LocalGitHubEventKind[] = [
  "review_requested",
  "mentioned",
  "assigned",
  "pr_opened",
  "issue_opened",
];

export interface LocalGitHubTriggerConfig {
  /** Which kinds fire this trigger (empty / missing = any). */
  events?: LocalGitHubEventKind[];
  /** Your GitHub login: `review_requested` / `mentioned` / `assigned` match against it. */
  login?: string;
  /** Restrict to these `owner/name` repos (empty = any). */
  repos?: string[];
}

/** One normalized GitHub happening (from the webhook payload). */
export interface LocalGitHubEvent {
  kinds: LocalGitHubEventKind[];
  /** Logins the event concerns: requested reviewer, assignee, @-mentions. */
  targets: string[];
  repo: string;
  repoUrl: string;
  kind: "pr" | "issue";
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  headBranch: string | null;
  baseBranch: string | null;
  /** Comment / review body when the event is a comment or review. */
  commentBody: string | null;
  commentUrl: string | null;
  /** Raw `X-GitHub-Event` + `action`. */
  event: string;
  action: string;
}

export interface LocalSlackTriggerConfig {
  /** Channel id (C0123…) to listen on. Required. */
  channelId: string;
  /** Only fire when the message contains this text (case-insensitive). */
  keyword?: string;
  /** Only fire for messages that @-mention the app (`app_mention` events). */
  mentionOnly?: boolean;
  /** Also fire for thread replies (default: top-level messages only). */
  includeThreads?: boolean;
}

export interface LocalSlackEvent {
  /** `message` | `app_mention`. */
  event: string;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs: string | null;
  teamId: string | null;
  eventId: string | null;
}

export type LocalLinearEventKind = "assigned" | "mentioned" | "created" | "labeled";

export const LOCAL_LINEAR_EVENT_KINDS: readonly LocalLinearEventKind[] = [
  "assigned",
  "mentioned",
  "created",
  "labeled",
];

export interface LocalLinearTriggerConfig {
  /** Which kinds fire this trigger (empty / missing = any). */
  events?: LocalLinearEventKind[];
  /** Your Linear user id, or display name / `@handle` — `assigned` / `mentioned` match against it. */
  user?: string;
  /** Any-match label filter (empty = any). */
  labels?: string[];
  /** Restrict to these team keys (empty = any). */
  teams?: string[];
}

export interface LocalLinearEvent {
  kinds: LocalLinearEventKind[];
  /** User ids / names the event concerns: new assignee, @-mentions. */
  targets: string[];
  /** e.g. ENG-123 */
  identifier: string;
  title: string;
  description: string;
  url: string;
  labels: string[];
  teamKey: string | null;
  assignee: string | null;
  priority: number | null;
  state: string | null;
  commentBody: string | null;
  commentUrl: string | null;
  actor: string | null;
  /** Raw `type` + `action`. */
  type: string;
  action: string;
}

// ── Daemon ⇄ server WebSocket protocol (/ws/local/daemon) ──────────────────

export interface LocalDaemonTerminalSync {
  terminalId: string;
  running: boolean;
}

export type LocalDaemonMessage =
  | {
      type: "hello";
      hostId: string;
      daemonVersion: string;
      dirs: LocalHostDir[];
      terminals: LocalDaemonTerminalSync[];
      /** The machine has a Claude Code login the server may ask for (see `credentials`). */
      claudeCredentials?: boolean;
    }
  /**
   * Answer to the server's `credentials` request: the machine's current
   * Claude OAuth access token (never the refresh token), or why not.
   */
  | {
      type: "credentials-result";
      requestId: string;
      token?: string;
      expiresAt?: string | null;
      error?: string;
    }
  | { type: "started"; terminalId: string }
  | { type: "spawn-error"; terminalId: string; message: string }
  | { type: "output"; terminalId: string; dataB64: string }
  | { type: "scrollback"; terminalId: string; attachId: string; dataB64: string }
  | { type: "attach-error"; terminalId: string; attachId: string; message: string }
  | { type: "attention"; terminalId: string; state: LocalAttentionState; reason: string }
  | { type: "preview"; terminalId: string; preview: string; lastActivityAt: string }
  | { type: "links"; terminalId: string; links: WorkLink[] }
  | { type: "usage"; terminalId: string; usage: LocalTerminalUsage }
  /**
   * New conversation entries read from the agent's transcript since the last
   * frame (in `seq` order). Sent as turns complete while the terminal runs
   * and flushed once more right before `exit`.
   */
  | { type: "transcript"; terminalId: string; entries: LocalTranscriptEntry[] }
  /** The agent CLI's own session id, once its hooks report it (sent once). */
  | { type: "session"; terminalId: string; agentSessionId: string }
  | { type: "agent-limits"; limits: LocalHostAgentLimits }
  /** The PTY's current grid — sent on spawn, after every resize, and to each new attach. */
  | { type: "size"; terminalId: string; cols: number; rows: number }
  /**
   * The final screen, sent right before `exit`: the tail of the output ring
   * plus the grid it was laid out for. Persisted so a terminal opened after
   * it finished can replay what was on screen at the recorded size
   * (scrollback otherwise dies with the PTY). Its own frame so an oversize
   * snapshot the server rejects can never swallow the `exit`.
   */
  | { type: "snapshot"; terminalId: string; dataB64: string; cols: number; rows: number }
  | { type: "exit"; terminalId: string; exitCode: number | null }
  | { type: "ping" };

export type LocalServerMessage =
  | {
      type: "spawn";
      terminalId: string;
      dir: string;
      cols: number;
      rows: number;
      spec: LocalTerminalSpec;
    }
  | { type: "input"; terminalId: string; dataB64: string }
  | { type: "resize"; terminalId: string; cols: number; rows: number }
  | { type: "kill"; terminalId: string; signal?: string }
  | { type: "attach"; terminalId: string; attachId: string }
  | { type: "detach"; terminalId: string }
  /**
   * Ask the daemon for the machine's Claude OAuth access token so the
   * cluster's CLAUDE_CODE_OAUTH_TOKEN can be refreshed without a copy/paste.
   * Only ever sent to a host owned by an admin (or in auth-disabled dev).
   */
  | { type: "credentials"; requestId: string }
  | { type: "pong" };

// ── Browser ⇄ server stream protocol (/ws/local/terminals/:id/stream) ──────
// Server → client: binary frames are raw terminal bytes; JSON text frames are
// control messages. Client → server: JSON only.

export type LocalStreamServerMessage =
  | { type: "status"; state: LocalTerminalState; attentionState: LocalAttentionState }
  /**
   * The PTY's current grid. Viewers that did not ask for this size render it
   * scaled to fit rather than fighting over the PTY (see local-terminal.tsx).
   * For an exited terminal it is the grid its final screen was recorded at:
   * the replay that follows only reads right at that size.
   */
  | { type: "size"; cols: number; rows: number }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string };

export type LocalStreamClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

/** Content-free nudge published on the shared /ws/events stream. */
export interface LocalChangedEvent {
  type: "local:changed";
  /** Null for host-level changes (online/offline) with no specific terminal. */
  terminalId: string | null;
  hostId: string;
  userId: string | null;
}

/** Default PTY size for daemon spawns. */
export const LOCAL_DEFAULT_COLS = 120;
export const LOCAL_DEFAULT_ROWS = 32;

/** Host is considered offline after this long without a daemon ping. */
export const LOCAL_HOST_OFFLINE_AFTER_MS = 90_000;

/** A `launching` terminal older than this is failed by the sweeper. */
export const LOCAL_LAUNCH_TIMEOUT_MS = 30_000;

/**
 * Single-quote a string for POSIX shells. The only viable quoting strategy
 * for untrusted values: wrap in single quotes and escape embedded single
 * quotes as '\'' .
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
