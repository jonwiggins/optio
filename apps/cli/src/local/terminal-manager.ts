import { spawn as ptySpawn, type IPty } from "node-pty";
import { chmodSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import {
  LOCAL_DEFAULT_COLS,
  LOCAL_DEFAULT_ROWS,
  type LocalDaemonMessage,
  type LocalDaemonTerminalSync,
  type LocalServerMessage,
} from "@optio/shared";
import type { AttentionTracker } from "./attention.js";
import { buildAgentCommand } from "./agent-command.js";
import { buildPreview } from "./preview.js";
import { RingBuffer } from "./ring-buffer.js";

/**
 * Owns the node-pty processes for one daemon, keyed by terminalId. Emits
 * protocol frames through the injected `send` (which drops while the WS is
 * down) and feeds output into the attention tracker + preview builder.
 */

const RING_CAPACITY = 512 * 1024;
const PREVIEW_THROTTLE_MS = 2000;
const PREVIEW_SOURCE_BYTES = 16 * 1024;
const KILL_ESCALATION_MS = 5000;
const MAX_DIMENSION = 1000;

type SpawnMessage = Extract<LocalServerMessage, { type: "spawn" }>;

interface ManagedTerminal {
  terminalId: string;
  pty: IPty;
  ring: RingBuffer;
  subscribed: boolean;
  previewTimer: NodeJS.Timeout | null;
  lastPreviewAt: number;
  killTimer: NodeJS.Timeout | null;
}

export interface TerminalManagerOptions {
  send: (msg: LocalDaemonMessage) => void;
  attention: AttentionTracker;
  /** Current allowlist (absolute paths); re-read on every spawn. */
  getAllowedDirs: () => string[];
  hookSettingsPath: string;
  getHookServerPort: () => number;
  onStatus?: (line: string) => void;
}

export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>();

  constructor(private readonly opts: TerminalManagerOptions) {}

  has(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  /** Running terminals for the hello frame. */
  terminalsSync(): LocalDaemonTerminalSync[] {
    return [...this.terminals.keys()].map((terminalId) => ({ terminalId, running: true }));
  }

  spawn(msg: SpawnMessage): void {
    if (this.terminals.has(msg.terminalId)) {
      // Duplicate spawn (e.g. server retry) — the terminal is already up.
      this.opts.send({ type: "started", terminalId: msg.terminalId });
      return;
    }
    try {
      const dir = this.validateDir(msg.dir);
      const shell = process.env.SHELL || "/bin/bash";
      let args: string[];
      switch (msg.spec.kind) {
        case "shell":
          args = ["-l"];
          break;
        case "command":
          args = ["-l", "-c", msg.spec.command];
          break;
        case "agent":
          args = [
            "-l",
            "-c",
            buildAgentCommand(msg.spec.agent, msg.spec.prompt, this.opts.hookSettingsPath),
          ];
          break;
      }

      const pty = ptySpawn(shell, args, {
        name: "xterm-256color",
        cols: clampDimension(msg.cols, LOCAL_DEFAULT_COLS),
        rows: clampDimension(msg.rows, LOCAL_DEFAULT_ROWS),
        cwd: dir,
        env: {
          ...cleanEnv(),
          TERM: "xterm-256color",
          OPTIO_LOCAL_TERMINAL_ID: msg.terminalId,
          OPTIO_LOCAL_DAEMON_PORT: String(this.opts.getHookServerPort()),
        },
      });

      const term: ManagedTerminal = {
        terminalId: msg.terminalId,
        pty,
        ring: new RingBuffer(RING_CAPACITY),
        subscribed: false,
        previewTimer: null,
        lastPreviewAt: 0,
        killTimer: null,
      };
      this.terminals.set(msg.terminalId, term);

      pty.onData((data) => this.handleData(term, data));
      pty.onExit(({ exitCode }) => this.handleExit(term, exitCode));

      this.opts.send({ type: "started", terminalId: msg.terminalId });
      this.opts.onStatus?.(`spawned terminal ${msg.terminalId} (${msg.spec.kind}) in ${dir}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.send({ type: "spawn-error", terminalId: msg.terminalId, message });
      this.opts.onStatus?.(`spawn failed for terminal ${msg.terminalId}: ${message}`);
    }
  }

  input(terminalId: string, dataB64: string): void {
    const term = this.terminals.get(terminalId);
    if (!term) return;
    term.pty.write(Buffer.from(dataB64, "base64").toString("utf-8"));
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const term = this.terminals.get(terminalId);
    if (!term) return;
    try {
      term.pty.resize(
        clampDimension(cols, LOCAL_DEFAULT_COLS),
        clampDimension(rows, LOCAL_DEFAULT_ROWS),
      );
    } catch {
      // resizing a just-exited pty throws — ignore
    }
  }

  kill(terminalId: string, signal?: string): void {
    const term = this.terminals.get(terminalId);
    if (!term) return;
    try {
      term.pty.kill(signal ?? "SIGTERM");
    } catch {
      // already dead
    }
    if (!term.killTimer) {
      term.killTimer = setTimeout(() => {
        term.killTimer = null;
        if (this.terminals.has(terminalId)) {
          try {
            term.pty.kill("SIGKILL");
          } catch {
            // already dead
          }
        }
      }, KILL_ESCALATION_MS);
    }
  }

  /**
   * Snapshot the ring buffer and enable live output atomically (in that
   * order): frames go out on one socket, so the viewer sees scrollback
   * followed by every subsequent byte — no gap.
   */
  attach(terminalId: string, attachId: string): void {
    const term = this.terminals.get(terminalId);
    if (!term) {
      this.opts.send({
        type: "attach-error",
        terminalId,
        attachId,
        message: "Unknown terminal — the daemon may have restarted since it ran",
      });
      return;
    }
    this.opts.send({
      type: "scrollback",
      terminalId,
      attachId,
      dataB64: term.ring.toBuffer().toString("base64"),
    });
    term.subscribed = true;
  }

  detach(terminalId: string): void {
    const term = this.terminals.get(terminalId);
    if (term) term.subscribed = false;
  }

  /** Kill every PTY (daemon shutdown). */
  killAll(): void {
    for (const term of this.terminals.values()) {
      if (term.previewTimer) clearTimeout(term.previewTimer);
      if (term.killTimer) clearTimeout(term.killTimer);
      try {
        term.pty.kill("SIGTERM");
      } catch {
        // already dead
      }
    }
    this.terminals.clear();
  }

  private handleData(term: ManagedTerminal, data: string): void {
    const chunk = Buffer.from(data, "utf-8");
    term.ring.append(chunk);
    this.opts.attention.feed(term.terminalId, chunk);
    this.schedulePreview(term);
    if (term.subscribed) {
      this.opts.send({
        type: "output",
        terminalId: term.terminalId,
        dataB64: chunk.toString("base64"),
      });
    }
  }

  private handleExit(term: ManagedTerminal, exitCode: number | undefined): void {
    if (!this.terminals.has(term.terminalId)) return; // killAll already cleaned up
    if (term.previewTimer) {
      clearTimeout(term.previewTimer);
      term.previewTimer = null;
    }
    if (term.killTimer) {
      clearTimeout(term.killTimer);
      term.killTimer = null;
    }
    // Final preview so the wall shows the last output.
    this.emitPreview(term);
    this.opts.send({ type: "exit", terminalId: term.terminalId, exitCode: exitCode ?? null });
    this.opts.attention.remove(term.terminalId);
    this.terminals.delete(term.terminalId);
    this.opts.onStatus?.(`terminal ${term.terminalId} exited (code ${exitCode ?? "unknown"})`);
  }

  /** Throttled (≥2 s) preview emission. */
  private schedulePreview(term: ManagedTerminal): void {
    if (term.previewTimer) return;
    const delay = Math.max(0, PREVIEW_THROTTLE_MS - (Date.now() - term.lastPreviewAt));
    term.previewTimer = setTimeout(() => {
      term.previewTimer = null;
      this.emitPreview(term);
    }, delay);
  }

  private emitPreview(term: ManagedTerminal): void {
    term.lastPreviewAt = Date.now();
    const preview = buildPreview(term.ring.tail(PREVIEW_SOURCE_BYTES).toString("utf-8"));
    this.opts.send({
      type: "preview",
      terminalId: term.terminalId,
      preview,
      lastActivityAt: new Date().toISOString(),
    });
  }

  /**
   * Defense in depth (the server also checks): the dir must exist and resolve
   * inside the allowlist.
   */
  private validateDir(dir: string): string {
    let resolved: string;
    try {
      resolved = realpathSync(dir);
    } catch {
      throw new Error(`Directory does not exist: ${dir}`);
    }
    if (!statSync(resolved).isDirectory()) {
      throw new Error(`Not a directory: ${dir}`);
    }
    const allowed = this.opts.getAllowedDirs().some((allowedDir) => {
      let allowedResolved: string;
      try {
        allowedResolved = realpathSync(allowedDir);
      } catch {
        return false;
      }
      return resolved === allowedResolved || resolved.startsWith(allowedResolved + sep);
    });
    if (!allowed) {
      throw new Error(`Directory is not in the allowlist: ${dir} — run \`optio local add\``);
    }
    return resolved;
  }
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (!value || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), MAX_DIMENSION);
}

/** process.env without undefined values (node-pty wants string values). */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * pnpm extracts node-pty's prebuilt `spawn-helper` without its execute bit
 * (its install script does not restore it), which makes every spawn fail with
 * "posix_spawnp failed" on macOS. Best-effort fixup at daemon start.
 */
export function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  try {
    const require = createRequire(import.meta.url);
    const ptyEntry = require.resolve("node-pty");
    const helper = join(
      dirname(ptyEntry),
      "..",
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    const st = statSync(helper);
    if ((st.mode & 0o111) === 0) chmodSync(helper, st.mode | 0o755);
  } catch {
    // no prebuild for this platform (node-gyp build) — nothing to fix
  }
}
