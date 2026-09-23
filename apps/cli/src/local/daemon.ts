import os from "node:os";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import type {
  LocalAttentionState,
  LocalDaemonMessage,
  LocalTranscriptEntry,
  LocalHost,
  LocalHostAgentLimits,
  LocalHostDir,
  LocalServerMessage,
} from "@optio/shared";
import type { ApiClient } from "../api/client.js";
import { CLI_VERSION } from "../version.js";
import { claudeHookSettingsPath } from "../config/paths.js";
import { loadLocalConfig, saveLocalConfig, setHostIdForServer } from "../config/local-store.js";
import { dim, green, red, yellow } from "../output/colors.js";
import { AttentionTracker } from "./attention.js";
import { detectRepoUrl } from "./git-remote.js";
import {
  startHookServer,
  writeClaudeHookSettings,
  writeClaudeShim,
  writeZshDotDir,
} from "./hook-server.js";
import { UsageTracker } from "./usage-tracker.js";
import { TranscriptTracker } from "./transcript-tracker.js";
import { readAgentLimits } from "./codex-limits.js";
import { hasClaudeCredentials, readClaudeCredentials } from "./claude-credentials.js";
import { TerminalManager, ensureSpawnHelperExecutable } from "./terminal-manager.js";

/**
 * The `optio local up` daemon: registers this machine as a host, keeps one
 * outbound WebSocket to /ws/local/daemon, and serves the protocol
 * (spawn/input/resize/kill/attach/detach). Reconnects forever with
 * exponential backoff; on each reconnect it re-registers (dirs may have
 * changed) and re-sends hello with the current terminals so the server can
 * reconcile. See docs/optio-local.md.
 */

const PING_INTERVAL_MS = 30_000;
const AGENT_LIMITS_INTERVAL_MS = 3 * 60_000;
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
// How often a running agent's transcript is re-read between hook events, so
// the conversation view keeps up mid-turn (a turn can be many tool calls
// long; hooks only fire at its edges). A size check when nothing changed.
const TRANSCRIPT_POLL_MS = 3000;
// Entries per `transcript` frame — keeps each frame far under the server's
// 1 MB limit even when every entry is at its text cap.
const TRANSCRIPT_BATCH = 40;
const SHUTDOWN_FLUSH_MS = 200;

interface RememberedAttention {
  state: LocalAttentionState;
  reason: string;
  /** Whether the server has received this state (false while offline). */
  acked: boolean;
}

export async function runDaemon(opts: { client: ApiClient }): Promise<void> {
  const { client } = opts;

  const hookSettingsPath = claudeHookSettingsPath();
  writeClaudeHookSettings(hookSettingsPath);
  const shimDir = writeClaudeShim(join(dirname(hookSettingsPath), "bin"));
  const zdotDir = writeZshDotDir(join(dirname(hookSettingsPath), "zsh"));
  ensureSpawnHelperExecutable();

  let ws: WebSocket | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let limitsTimer: NodeJS.Timeout | null = null;
  let lastLimitsKey = "";
  const sendAgentLimits = () => {
    let limits: LocalHostAgentLimits;
    try {
      limits = readAgentLimits();
    } catch {
      return;
    }
    const key = JSON.stringify(limits);
    if (key === lastLimitsKey) return; // unchanged since last report
    lastLimitsKey = key;
    send({ type: "agent-limits", limits });
  };
  let shuttingDown = false;
  let backoff = BACKOFF_INITIAL_MS;

  /** Last attention per terminal, re-emitted after reconnect if unacked. */
  const attentionByTerminal = new Map<string, RememberedAttention>();

  const status = (line: string): void => {
    const ts = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`${dim(`[${ts}]`)} ${line}\n`);
  };

  const usage = new UsageTracker();
  const transcript = new TranscriptTracker();

  const sendRaw = (msg: LocalDaemonMessage): boolean => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  };

  /** Ship a terminal's new transcript entries, batched. */
  const sendTranscript = (terminalId: string, entries: LocalTranscriptEntry[]): void => {
    for (let i = 0; i < entries.length; i += TRANSCRIPT_BATCH) {
      sendRaw({ type: "transcript", terminalId, entries: entries.slice(i, i + TRANSCRIPT_BATCH) });
    }
  };

  /** Re-read a terminal's transcript (when known) and ship what's new. */
  const flushTranscript = (terminalId: string): void => {
    const path = transcript.paths().find(([id]) => id === terminalId)?.[1];
    if (!path) return;
    sendTranscript(terminalId, transcript.update(terminalId, path));
  };

  // One outbound path: drop while disconnected (don't queue), EXCEPT
  // attention state, which is remembered and re-sent after the next hello.
  const send = (msg: LocalDaemonMessage): void => {
    if (msg.type === "attention") {
      attentionByTerminal.set(msg.terminalId, {
        state: msg.state,
        reason: msg.reason,
        acked: false,
      });
    } else if (msg.type === "exit") {
      attentionByTerminal.delete(msg.terminalId);
      usage.remove(msg.terminalId);
      // The last turn's lines land in the transcript right before the
      // process exits; read them once more so the stored conversation is
      // complete, ahead of the `exit` on the same socket.
      flushTranscript(msg.terminalId);
      transcript.remove(msg.terminalId);
    }
    if (!sendRaw(msg)) return;
    if (msg.type === "attention") {
      const entry = attentionByTerminal.get(msg.terminalId);
      if (entry) entry.acked = true;
    }
  };

  const attention = new AttentionTracker({
    onEvent: (event) =>
      send({
        type: "attention",
        terminalId: event.terminalId,
        state: event.state,
        reason: event.reason,
      }),
  });

  const manager = new TerminalManager({
    send,
    attention,
    getAllowedDirs: () => loadLocalConfig().dirs.map((d) => d.path),
    getRepoUrlForDir: (dir) => {
      const entry = loadLocalConfig()
        .dirs.filter((d) => dir === d.path || dir.startsWith(`${d.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0];
      return entry?.repoUrl;
    },
    hookSettingsPath,
    shimDir,
    zdotDir,
    getHookServerPort: () => hookServer.port,
    onStatus: status,
  });

  // Agent session ids already reported, so each terminal sends its id once.
  const reportedSessions = new Map<string, string>();

  const hookServer = await startHookServer((terminalId, eventName, payload) => {
    if (!manager.has(terminalId)) return;
    // A hook from a terminal whose process just exited (the final Stop) still
    // carries its session id, usage and transcript, sent ahead of its `exit`;
    // attention is over for it.
    if (manager.isLive(terminalId)) attention.hookEvent(terminalId, eventName);
    // The agent's own session id makes the run resumable (`claude --resume`).
    if (payload.sessionId && reportedSessions.get(terminalId) !== payload.sessionId) {
      reportedSessions.set(terminalId, payload.sessionId);
      send({ type: "session", terminalId, agentSessionId: payload.sessionId });
    }
    // Every hook names the transcript; Stop is when a turn's usage is
    // complete, but folding on each event keeps the header fresh mid-turn too.
    if (payload.transcriptPath) {
      const next = usage.update(terminalId, payload.transcriptPath);
      if (next) send({ type: "usage", terminalId, usage: next });
      sendTranscript(terminalId, transcript.update(terminalId, payload.transcriptPath));
    }
  });

  // Between hooks, keep the conversation view current for live sessions.
  const transcriptTimer = setInterval(() => {
    for (const [terminalId, path] of transcript.paths()) {
      if (!manager.has(terminalId)) {
        transcript.remove(terminalId);
        continue;
      }
      sendTranscript(terminalId, transcript.update(terminalId, path));
    }
  }, TRANSCRIPT_POLL_MS);
  transcriptTimer.unref();

  function handleServerMessage(msg: LocalServerMessage): void {
    switch (msg.type) {
      case "spawn":
        manager.spawn(msg);
        return;
      case "input":
        manager.input(msg.terminalId, msg.dataB64);
        return;
      case "resize":
        manager.resize(msg.terminalId, msg.cols, msg.rows);
        return;
      case "kill":
        manager.kill(msg.terminalId, msg.signal);
        return;
      case "attach":
        manager.attach(msg.terminalId, msg.attachId);
        return;
      case "detach":
        manager.detach(msg.terminalId);
        return;
      case "credentials":
        void answerCredentials(msg.requestId);
        return;
      case "pong":
        return;
    }
  }

  /** Re-detect git remotes for every allowlisted dir (persisting changes). */
  async function refreshDirs(): Promise<LocalHostDir[]> {
    const config = loadLocalConfig();
    const dirs: LocalHostDir[] = [];
    let changed = false;
    for (const entry of config.dirs) {
      const repoUrl = await detectRepoUrl(entry.path);
      if (repoUrl !== entry.repoUrl) {
        if (repoUrl) entry.repoUrl = repoUrl;
        else delete entry.repoUrl;
        changed = true;
      }
      dirs.push(repoUrl ? { path: entry.path, repoUrl } : { path: entry.path });
    }
    if (changed) saveLocalConfig(config);
    return dirs;
  }

  async function register(dirs: LocalHostDir[]): Promise<LocalHost> {
    const { host } = await client.post<{ host: LocalHost }>("/api/local/hosts/register", {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      daemonVersion: CLI_VERSION,
      dirs,
    });
    setHostIdForServer(client.serverUrl, host.id);
    return host;
  }

  /**
   * The server asked for this machine's Claude login (to refresh the
   * cluster's token). Only the access token is sent; a machine that isn't
   * logged in answers with the reason.
   */
  async function answerCredentials(requestId: string): Promise<void> {
    const creds = await readClaudeCredentials().catch(() => null);
    if (!creds) {
      send({
        type: "credentials-result",
        requestId,
        error: "No Claude Code login on this machine — run `claude` here and sign in first",
      });
      return;
    }
    send({
      type: "credentials-result",
      requestId,
      token: creds.accessToken,
      expiresAt: creds.expiresAt,
    });
    status("sent the Claude OAuth token from this machine to refresh the server's");
  }

  /** One connection lifetime; resolves when the socket closes. */
  function connectOnce(
    host: LocalHost,
    dirs: LocalHostDir[],
    claudeCredentials: boolean,
  ): Promise<void> {
    return new Promise((resolve) => {
      const protocols = ["optio-ws-v1"];
      const token = client.getToken();
      if (token) protocols.push(`optio-auth-${token}`);
      const socket = new WebSocket(client.getWsUrl("/ws/local/daemon"), protocols);
      ws = socket;

      socket.on("open", () => {
        backoff = BACKOFF_INITIAL_MS;
        // A fresh connection has no viewers: the server dropped all relay
        // subscriptions when the old socket died (without sending detach).
        // Stop streaming output until it re-issues attach for each viewer.
        manager.clearAllSubscriptions();
        const hello: LocalDaemonMessage = {
          type: "hello",
          hostId: host.id,
          daemonVersion: CLI_VERSION,
          dirs,
          terminals: manager.terminalsSync(),
          claudeCredentials,
        };
        socket.send(JSON.stringify(hello));
        status(green(`connected to ${client.serverUrl} as host "${host.name}" (${host.id})`));
        // Attention that changed while offline: bring the server up to date.
        for (const [terminalId, entry] of attentionByTerminal) {
          if (!entry.acked) {
            send({ type: "attention", terminalId, state: entry.state, reason: entry.reason });
          }
        }
        pingTimer = setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS);
        // Agent subscription limits read off this machine (Codex session
        // logs). Once on connect, then every few minutes; the reader only
        // touches file tails so this is cheap.
        sendAgentLimits();
        limitsTimer = setInterval(sendAgentLimits, AGENT_LIMITS_INTERVAL_MS);
      });

      socket.on("message", (raw) => {
        let msg: LocalServerMessage;
        try {
          msg = JSON.parse(raw.toString()) as LocalServerMessage;
        } catch {
          return;
        }
        try {
          handleServerMessage(msg);
        } catch (err) {
          status(red(`failed to handle ${msg.type}: ${err instanceof Error ? err.message : err}`));
        }
      });

      socket.on("error", (err) => {
        if (!shuttingDown) status(red(`connection error: ${err.message}`));
      });

      socket.on("close", (code, reason) => {
        if (limitsTimer) {
          clearInterval(limitsTimer);
          limitsTimer = null;
        }
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        if (ws === socket) ws = null;
        if (!shuttingDown) {
          const why = reason.toString() || `code ${code}`;
          status(yellow(`disconnected (${why})`));
        }
        resolve();
      });
    });
  }

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(transcriptTimer);
    status(yellow("shutting down — killing terminals"));
    manager.killAll();
    try {
      ws?.close(1000, "daemon shutting down");
    } catch {
      // ignore
    }
    void hookServer.close();
    setTimeout(() => process.exit(0), SHUTDOWN_FLUSH_MS);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  status(`optio local daemon v${CLI_VERSION} — hook server on 127.0.0.1:${hookServer.port}`);

  while (!shuttingDown) {
    try {
      const dirs = await refreshDirs();
      if (dirs.length === 0) {
        status(yellow("no directories in the allowlist — run `optio local add <dir>`"));
      }
      const host = await register(dirs);
      // Re-probed per connection: a `claude login` since the last one counts.
      const claudeCredentials = await hasClaudeCredentials().catch(() => false);
      await connectOnce(host, dirs, claudeCredentials);
    } catch (err) {
      if (!shuttingDown) {
        status(red(err instanceof Error ? err.message : String(err)));
      }
    }
    if (shuttingDown) break;
    status(dim(`reconnecting in ${Math.round(backoff / 1000)}s`));
    await sleep(backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
