import os from "node:os";
import WebSocket from "ws";
import type {
  LocalAttentionState,
  LocalDaemonMessage,
  LocalHost,
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
import { startHookServer, writeClaudeHookSettings } from "./hook-server.js";
import { UsageTracker } from "./usage-tracker.js";
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
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
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
  ensureSpawnHelperExecutable();

  let ws: WebSocket | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;
  let backoff = BACKOFF_INITIAL_MS;

  /** Last attention per terminal, re-emitted after reconnect if unacked. */
  const attentionByTerminal = new Map<string, RememberedAttention>();

  const status = (line: string): void => {
    const ts = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`${dim(`[${ts}]`)} ${line}\n`);
  };

  const usage = new UsageTracker();

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
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      return;
    }
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
    getHookServerPort: () => hookServer.port,
    onStatus: status,
  });

  const hookServer = await startHookServer((terminalId, eventName, payload) => {
    if (!manager.has(terminalId)) return;
    attention.hookEvent(terminalId, eventName);
    // Every hook names the transcript; Stop is when a turn's usage is
    // complete, but folding on each event keeps the header fresh mid-turn too.
    if (payload.transcriptPath) {
      const next = usage.update(terminalId, payload.transcriptPath);
      if (next) send({ type: "usage", terminalId, usage: next });
    }
  });

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

  /** One connection lifetime; resolves when the socket closes. */
  function connectOnce(host: LocalHost, dirs: LocalHostDir[]): Promise<void> {
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
      await connectOnce(host, dirs);
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
