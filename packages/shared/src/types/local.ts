// Optio Local — terminals on a user's own machine, managed via the daemon
// (`optio local up`). See docs/optio-local.md for the full protocol.

import type { WorkLink } from "../utils/extract-work-links.js";
import type { LocalTerminalUsage } from "../utils/agent-usage.js";
import type { TriggerType } from "./triggers.js";
import type { ModelProviderLaunch } from "./model-provider.js";

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

/** One model as an agent CLI on the machine lists it (Codex's model catalog). */
export interface LocalAgentModel {
  id: string;
  label: string;
  description?: string;
  /** Reasoning efforts the model accepts, in order. */
  efforts: string[];
  /** The effort the CLI uses when none is set. */
  defaultEffort: string | null;
}

/**
 * The models an agent CLI on the machine offers, read by the daemon (no
 * tokens leave the laptop). Codex: `codex debug models` — its current model
 * catalog, refreshed the way Codex refreshes it — so the model and effort
 * pickers track Codex releases without an Optio update.
 */
export interface LocalHostAgentModels {
  codex?: {
    models: LocalAgentModel[];
    /** When the daemon read the catalog. */
    fetchedAt: string;
  };
}

/**
 * How a local agent handles permission prompts. For Claude Code, its
 * `--permission-mode`: `auto` (the daemon's default) lets Claude's classifier
 * approve routine actions and block risky ones, so an unattended run doesn't
 * stall on a prompt; `bypassPermissions` skips every check
 * (`--dangerously-skip-permissions`); `default` asks first (a headless run
 * can't ask, so those actions are denied). For Codex, only
 * `bypassPermissions` means anything: `--yolo` (no approvals, no sandbox);
 * otherwise Codex keeps the machine's own approval and sandbox config.
 */
export type LocalAgentPermissionMode = "auto" | "bypassPermissions" | "default";

export const LOCAL_AGENT_PERMISSION_MODES: readonly LocalAgentPermissionMode[] = [
  "auto",
  "bypassPermissions",
  "default",
];

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
  /**
   * Whether the connected daemon adds and removes allowlisted directories
   * when asked from Optio (the Machines page, the New work form) — the same
   * as `optio local add|remove` on the machine. Live (from the daemon's
   * hello), so false whenever the host is offline.
   */
  manageDirs?: boolean;
  /**
   * Whether the connected daemon can run agents through a model provider
   * (Bedrock). Live, so false whenever the host is offline.
   */
  modelProviders?: boolean;
  /** AWS profiles on the machine, as its daemon last reported them (names only). */
  awsProfiles?: string[] | null;
  /**
   * Whether the connected daemon can refresh agent limits on request (Codex's
   * usage pill refresh button). Live, so false whenever the host is offline.
   */
  refreshLimits?: boolean;
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
      /**
       * Reasoning effort passed to the agent CLI, when set: Claude Code
       * `--effort`, Codex `-c model_reasoning_effort=…`.
       */
      effort?: string;
      /**
       * Claude Code: its `--permission-mode` (the daemon's default is `auto`).
       * Codex: `bypassPermissions` runs it with `--yolo`; anything else keeps
       * the machine's own config.
       */
      permissionMode?: LocalAgentPermissionMode;
      /**
       * "Work on a new branch that becomes a PR": the server wraps the prompt
       * with branch-and-PR instructions off this base before the spawn.
       */
      baseBranch?: string;
      /**
       * Reach the models through this provider (Amazon Bedrock) instead of
       * the CLI's own sign-in, with the machine's own AWS credentials. Only
       * sent to daemons whose hello set `modelProviders`.
       */
      provider?: ModelProviderLaunch;
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
 * idempotent. Claude Code's JSONL and Codex's session rollout
 * (`~/.codex/sessions/…/rollout-*.jsonl`) both distill to this shape.
 *
 * `user` is the person typing in the session. Everything else the agent CLI
 * files as a "user" turn — a background task reporting back, another agent's
 * message, the summary that replaced a compacted conversation — is `system`,
 * with `source` saying which.
 */
export type LocalTranscriptRole = "user" | "assistant" | "tool" | "system";
export type LocalTranscriptKind = "text" | "thinking" | "tool_use" | "tool_result";

/**
 * Where an entry came from, when it isn't simply what it looks like:
 * - `prompt` (role `user`): the prompt the session was started with — from
 *   the New work form, an automation's template, or a headless `-p` run —
 *   rather than something typed into the running session
 * - `task`: a background task or agent the session started reported back
 * - `agent`: a message from another agent session
 * - `compact`: the summary that replaced the conversation so far
 * - `interrupt`: the turn was stopped
 * - `rewind`: the conversation was rolled back to an earlier turn
 * - `other`: anything else the CLI injected as a turn
 */
export type LocalTranscriptSource =
  | "prompt"
  | "task"
  | "agent"
  | "compact"
  | "interrupt"
  | "rewind"
  | "other";

export const LOCAL_TRANSCRIPT_SOURCES: readonly LocalTranscriptSource[] = [
  "prompt",
  "task",
  "agent",
  "compact",
  "interrupt",
  "rewind",
  "other",
];

export interface LocalTranscriptEntry {
  seq: number;
  role: LocalTranscriptRole;
  kind: LocalTranscriptKind;
  /** See LocalTranscriptSource; null / missing for an ordinary entry (and from older daemons). */
  source?: LocalTranscriptSource | null;
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
  /**
   * The type of the trigger that started it (`github`, `schedule`, …), for
   * its source badge. Null when no trigger did, or the trigger is gone.
   */
  triggerType?: TriggerType | null;
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
  /** When a person last typed into it (throttled to a minute); null = never. Lists order by it, then creation. */
  lastInteractedAt?: string | null;
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
  /** `{{param}}` template each spawned terminal is titled from; null = the blueprint name. */
  runTitle?: string | null;
  /** Non-null = run the rendered template as this agent (gets attention hooks). */
  agent: LocalAgentKind | null;
  spawnMode: LocalBlueprintSpawnMode;
  /** Agent spawns only: stay open for chat, or exit when the turn is done. */
  sessionMode: LocalAgentSessionMode;
  /**
   * Agent spawns: per-run agent parameters keyed like the provider catalog
   * (`claudeModel`, `claudeEffort`, `claudePermissionMode`, `copilotModel`,
   * `copilotEffort`, `codexPermissionMode`; string or boolean values) — the
   * fields that apply to a run on a machine. Null = the machine's own defaults.
   */
  agentOptions?: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// Automation triggers are rows in `workflow_triggers` with target_type =
// "local_blueprint"; the trigger vocabulary (types, event kinds, configs)
// lives in ./triggers.ts and is shared with Jobs, scheduled Tasks, and
// persistent agents.

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
      /** The daemon answers `transcript-request` (reads a finished session's conversation off disk). */
      transcriptBackfill?: boolean;
      /** The daemon answers `dirs` (adds / removes an allowlisted directory when asked from Optio). */
      manageDirs?: boolean;
      /** The daemon runs agents through a model provider (`spec.provider`). */
      modelProviders?: boolean;
      /** AWS profile names in the machine's ~/.aws/config and credentials (names only). */
      awsProfiles?: string[];
      /** The daemon answers `limits-refresh` (reads Codex's limits on request). */
      refreshLimits?: boolean;
    }
  /** Answer to `limits-refresh`: the limits it read, or why it couldn't. */
  | {
      type: "limits-refresh-result";
      requestId: string;
      limits?: LocalHostAgentLimits;
      error?: string;
    }
  /**
   * Answer to `dirs`: the allowlist after the change (the host's `dirs` from
   * then on) and the directory as the daemon resolved it (`~` expanded,
   * symlinks followed) — or why it refused (no such directory, not in the
   * list, …).
   */
  | {
      type: "dirs-result";
      requestId: string;
      dirs?: LocalHostDir[];
      path?: string;
      error?: string;
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
  /**
   * Answer to `attach`: the terminal as it stands, as bytes that rebuild it
   * (the daemon's screen model, serialized: scrollback, screen, cursor, the
   * program's modes), drawn for `cols`×`rows`. Daemons before the screen
   * model sent the raw tail of the output and no grid.
   */
  | {
      type: "scrollback";
      terminalId: string;
      attachId: string;
      dataB64: string;
      cols?: number;
      rows?: number;
    }
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
  /**
   * Answer to `transcript-request`: the whole conversation of a finished
   * session, read from the agent CLI's own transcript on disk, in `seq`
   * order from 1 across frames. `done` marks the last frame; `error` says
   * why there is nothing to show (no transcript on this machine, the
   * session ran outside the allowlisted dirs, …).
   */
  | {
      type: "transcript-backfill";
      requestId: string;
      terminalId: string;
      entries: LocalTranscriptEntry[];
      done: boolean;
      error?: string;
    }
  /** The agent CLI's own session id, once its hooks report it (sent once). */
  | { type: "session"; terminalId: string; agentSessionId: string }
  | { type: "agent-limits"; limits: LocalHostAgentLimits }
  /** The models the machine's agent CLIs offer (on connect, then every few hours). */
  | { type: "agent-models"; models: LocalHostAgentModels }
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
  /**
   * Ask the daemon for the machine's current agent limits now (Codex's, from
   * its app server — the session log only moves when Codex runs). Only sent
   * to daemons whose hello set `refreshLimits`; answered with
   * `limits-refresh-result` (and an `agent-limits` frame when they changed).
   */
  | { type: "limits-refresh"; requestId: string }
  /**
   * Read a finished agent session's conversation off disk, for a session
   * whose transcript was never streamed (it ran under a daemon that predates
   * transcripts, or its hooks never named the file). Only sent to daemons
   * whose hello set `transcriptBackfill`; answered with `transcript-backfill`.
   */
  | {
      type: "transcript-request";
      requestId: string;
      terminalId: string;
      agent: LocalAgentKind;
      agentSessionId: string;
      /** The prompt the session was spawned with: its turn reads as the prompt, as when streamed. */
      prompt?: string;
    }
  /**
   * Add a directory to the machine's allowlist, or remove one — what
   * `optio local add|remove <dir>` does there. `path` is absolute or under
   * `~`. Only sent to daemons whose hello set `manageDirs`; answered with
   * `dirs-result`.
   */
  | { type: "dirs"; requestId: string; op: LocalDirOp; path: string }
  | { type: "pong" };

export type LocalDirOp = "add" | "remove";

// ── Browser ⇄ server stream protocol (/ws/local/terminals/:id/stream) ──────
// Server → client: binary frames are raw terminal bytes; JSON text frames are
// control messages. Client → server: JSON only.

export type LocalStreamServerMessage =
  | { type: "status"; state: LocalTerminalState; attentionState: LocalAttentionState }
  /**
   * The PTY's current grid. `yours` says whether this viewer holds it (the
   * server picks the screen in use, see services/local-grid.ts): true — fit
   * the terminal to your own screen; false — render this grid scaled to fit,
   * with "Use this screen". Servers before it omit `yours`; viewers then
   * treat a grid they did not ask for as another screen's (see
   * local-terminal.tsx). For an exited terminal it is the grid its final
   * screen was recorded at, without `yours`: the replay that follows only
   * reads right at that size.
   */
  | { type: "size"; cols: number; rows: number; yours?: boolean }
  /**
   * The binary frame that follows is the terminal as it stood when this
   * viewer attached, drawn for this grid: lay it out at this size, write it,
   * then size the terminal as the `size` frames that follow say. A replay
   * written at another width wraps a full-screen program's rows and an
   * inline one's rules. Sent only ahead of a snapshot from a daemon that
   * names its grid.
   */
  | { type: "replay"; cols: number; rows: number }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string };

export type LocalStreamClientMessage =
  | { type: "input"; data: string }
  /** Size the PTY to this screen now: a click or keystroke here, or "Use this screen". */
  | { type: "resize"; cols: number; rows: number }
  /**
   * How this viewer sees the terminal, sent on connect and whenever it
   * changes: the grid that fits its screen, whether the terminal is on screen
   * (a visible tab, the app in front), and how long since its user last
   * touched it. `open` marks the user arriving — the pane opened, its tab came
   * to the front, or they came back after LOCAL_VIEW_IN_USE_MS away — and asks
   * for the grid: the server fits the PTY to this screen unless another
   * screen showing the terminal was used within LOCAL_VIEW_IN_USE_MS.
   */
  | {
      type: "view";
      cols: number;
      rows: number;
      visible: boolean;
      idleMs: number;
      open?: boolean;
    };

/** A screen touched this recently is in use: it keeps the terminal's grid. */
export const LOCAL_VIEW_IN_USE_MS = 60_000;

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
