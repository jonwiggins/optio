// Optio Local — terminals on a user's own machine, managed via the daemon
// (`optio local up`). See docs/optio-local.md for the full protocol.

export type LocalHostState = "online" | "offline";

export interface LocalHostDir {
  path: string;
  /** Normalized git remote URL detected for the dir, when it is a git repo. */
  repoUrl?: string;
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
  state: LocalHostState;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LocalTerminalState = "pending" | "launching" | "running" | "exited" | "error";

/** Why a terminal is sitting in `pending`. */
export type LocalTerminalPendingReason = "hold" | "host_offline";

export type LocalAttentionState = "working" | "needs_you" | "idle";

export type LocalSpawnSource = "manual" | "ticket" | "trigger" | "blueprint" | "api";

/** How the daemon should build the process for a terminal. */
export type LocalTerminalSpec =
  | { kind: "shell" }
  | { kind: "command"; command: string }
  | { kind: "agent"; agent: LocalAgentKind; prompt?: string };

/** Agent CLIs the daemon knows how to launch (and, for claude-code, hook). */
export type LocalAgentKind = "claude-code" | "codex" | "cursor" | "gemini" | "opencode";

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
  preview: string | null;
  costUsd: string | null;
  lastActivityAt: string | null;
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
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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
    }
  | { type: "started"; terminalId: string }
  | { type: "spawn-error"; terminalId: string; message: string }
  | { type: "output"; terminalId: string; dataB64: string }
  | { type: "scrollback"; terminalId: string; attachId: string; dataB64: string }
  | { type: "attach-error"; terminalId: string; attachId: string; message: string }
  | { type: "attention"; terminalId: string; state: LocalAttentionState; reason: string }
  | { type: "preview"; terminalId: string; preview: string; lastActivityAt: string }
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
  | { type: "pong" };

// ── Browser ⇄ server stream protocol (/ws/local/terminals/:id/stream) ──────
// Server → client: binary frames are raw terminal bytes; JSON text frames are
// control messages. Client → server: JSON only.

export type LocalStreamServerMessage =
  | { type: "status"; state: LocalTerminalState; attentionState: LocalAttentionState }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string };

export type LocalStreamClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

/** Content-free nudge published on the shared /ws/events stream. */
export interface LocalChangedEvent {
  type: "local:changed";
  terminalId: string;
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
