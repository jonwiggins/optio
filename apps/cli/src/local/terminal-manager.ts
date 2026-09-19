import { spawn as ptySpawn, type IPty } from "node-pty";
import { chmodSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { basename, dirname, join, sep } from "node:path";
import {
  LOCAL_DEFAULT_COLS,
  LOCAL_DEFAULT_ROWS,
  extractHyperlinkUrls,
  extractWorkLinks,
  normalizeRepoUrl,
  workLinksKey,
  type LocalDaemonMessage,
  type LocalDaemonTerminalSync,
  type LocalServerMessage,
} from "@optio/shared";
import type { AttentionTracker } from "./attention.js";
import { buildAgentCommand } from "./agent-command.js";
import { buildPreview, stripAnsi } from "./preview.js";
import { RingBuffer } from "./ring-buffer.js";

/**
 * Owns the node-pty processes for one daemon, keyed by terminalId. Emits
 * protocol frames through the injected `send` (which drops while the WS is
 * down) and feeds output into the attention tracker + preview builder.
 */

const RING_CAPACITY = 512 * 1024;
// Tail of the ring persisted server-side as the terminal's final screen.
// Kept under the server's 1 MB frame limit with base64 overhead to spare.
const SNAPSHOT_BYTES = 384 * 1024;
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
  /** workLinksKey() of the last `links` frame sent, to emit only on change. */
  lastLinksKey: string;
  /** Normalized git remote of the dir (for bare `#N` refs), when known. */
  repoUrl?: string;
  killTimer: NodeJS.Timeout | null;
}

export interface TerminalManagerOptions {
  send: (msg: LocalDaemonMessage) => void;
  attention: AttentionTracker;
  /** Current allowlist (absolute paths); re-read on every spawn. */
  getAllowedDirs: () => string[];
  /** Git remote for the allowlisted dir containing `dir`, when detected. */
  getRepoUrlForDir?: (dir: string) => string | undefined;
  hookSettingsPath: string;
  /** Directory holding the `claude` shim; prepended to every spawn's PATH. */
  shimDir?: string;
  /** ZDOTDIR wrapper (see writeZshDotDir) that keeps the shim first for zsh. */
  zdotDir?: string;
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
            buildAgentCommand(msg.spec.agent, msg.spec.prompt, this.opts.hookSettingsPath, {
              mode: msg.spec.mode,
              resumeSessionId: msg.spec.resumeSessionId,
              model: msg.spec.model,
            }),
          ];
          break;
      }

      const env = cleanEnv();
      // The shim makes a hand-launched `claude` report hooks too (see
      // writeClaudeShim). Login rc files that *prepend* to PATH keep it;
      // ones that reset PATH lose it, and the terminal degrades to the
      // silence heuristic as before.
      if (this.opts.shimDir) {
        env.PATH = env.PATH ? `${this.opts.shimDir}:${env.PATH}` : this.opts.shimDir;
        env.OPTIO_LOCAL_HOOK_SETTINGS = this.opts.hookSettingsPath;
        env.OPTIO_LOCAL_SHIM_DIR = this.opts.shimDir;
        // zsh: route dotfiles through the wrapper so rc files that prepend
        // their own bins (~/.local/bin, asdf shims) can't bury the shim.
        if (this.opts.zdotDir && basename(shell) === "zsh") {
          env.OPTIO_USER_ZDOTDIR = env.ZDOTDIR || env.HOME || os.homedir();
          env.ZDOTDIR = this.opts.zdotDir;
        }
      }
      const pty = ptySpawn(shell, args, {
        name: "xterm-256color",
        cols: clampDimension(msg.cols, LOCAL_DEFAULT_COLS),
        rows: clampDimension(msg.rows, LOCAL_DEFAULT_ROWS),
        cwd: dir,
        env: {
          ...env,
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
        lastLinksKey: "",
        repoUrl: normalizeOptional(this.opts.getRepoUrlForDir?.(dir)),
        killTimer: null,
      };
      this.terminals.set(msg.terminalId, term);
      if (msg.spec.kind === "agent") this.opts.attention.markAgent(msg.terminalId);

      pty.onData((data) => this.handleData(term, data));
      pty.onExit(({ exitCode }) => this.handleExit(term, exitCode));

      this.opts.send({ type: "started", terminalId: msg.terminalId });
      this.sendSize(term);
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
    // The human responded — clears a sticky needs_you back to working.
    this.opts.attention.onInput(terminalId);
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
    // Every viewer hears the new grid, including the one that asked: the
    // others switch to rendering this size scaled-to-fit.
    this.sendSize(term);
  }

  /** Tell the server (and so every viewer) the PTY's current grid. */
  private sendSize(term: ManagedTerminal): void {
    this.opts.send({
      type: "size",
      terminalId: term.terminalId,
      cols: term.pty.cols,
      rows: term.pty.rows,
    });
  }

  /**
   * The final screen, sent right before `exit`: what a viewer attached at
   * that moment would have seen, at the grid it was drawn for. The server
   * persists it so the session can be read back after the PTY is gone.
   */
  private sendSnapshot(term: ManagedTerminal): void {
    const tail = term.ring.tail(SNAPSHOT_BYTES);
    if (tail.length === 0) return;
    this.opts.send({
      type: "snapshot",
      terminalId: term.terminalId,
      dataB64: tail.toString("base64"),
      cols: term.pty.cols,
      rows: term.pty.rows,
    });
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
    // A new viewer must know the grid before it can render it faithfully.
    this.sendSize(term);
  }

  detach(terminalId: string): void {
    const term = this.terminals.get(terminalId);
    if (term) term.subscribed = false;
  }

  /**
   * Drop every output subscription. Called on (re)connect: a fresh server
   * connection holds no viewer state, so output must not resume until the
   * server sends a new `attach`.
   */
  clearAllSubscriptions(): void {
    for (const term of this.terminals.values()) {
      term.subscribed = false;
    }
  }

  /**
   * Kill every PTY (daemon shutdown). Best-effort reports each terminal as
   * exited first — on a clean shutdown the WS is still open, so the server
   * marks the rows exited instead of leaving them "running" on an offline
   * host (the injected `send` drops frames once the socket is down).
   */
  killAll(): void {
    for (const term of this.terminals.values()) {
      if (term.previewTimer) clearTimeout(term.previewTimer);
      if (term.killTimer) clearTimeout(term.killTimer);
      this.sendSnapshot(term);
      this.opts.send({ type: "exit", terminalId: term.terminalId, exitCode: null });
      this.opts.attention.remove(term.terminalId);
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
    // Final preview so the wall shows the last output, and the final screen
    // so the pane can replay it.
    this.emitPreview(term);
    this.sendSnapshot(term);
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
    this.emitLinks(term);
  }

  /**
   * PR / ticket links seen anywhere in the scrollback ring (not just the
   * preview tail — a PR URL printed ten minutes ago still identifies this
   * session). Rides the preview throttle; sent only when the set changes.
   */
  private emitLinks(term: ManagedTerminal): void {
    const raw = term.ring.toBuffer().toString("utf-8");
    // OSC 8 hyperlink URLs live only inside the escape sequence (the visible
    // text is just "#581"); harvest them before the stripper discards them.
    const text = `${extractHyperlinkUrls(raw).join("\n")}\n${stripAnsi(raw)}`;
    const links = extractWorkLinks(text, { repoUrl: term.repoUrl });
    const key = workLinksKey(links);
    if (key === term.lastLinksKey) return;
    term.lastLinksKey = key;
    this.opts.send({ type: "links", terminalId: term.terminalId, links });
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

function normalizeOptional(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return normalizeRepoUrl(url);
  } catch {
    return undefined;
  }
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (!value || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), MAX_DIMENSION);
}

/**
 * Claude Code's per-session markers. If the daemon itself was launched from
 * inside a Claude Code session (a `!` shell, a hook, an agent), these leak
 * into every PTY and make nested `claude` runs believe they are child
 * sessions ("Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
 * marker"). Terminals spawned here are always fresh top-level sessions.
 * Deliberately an explicit list: CLAUDE_CODE_OAUTH_TOKEN, *_USE_VERTEX, etc.
 * are real user configuration and must pass through.
 */
const CLAUDE_SESSION_MARKERS = new Set([
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
]);

/** Drop undefined values (node-pty wants strings) and inherited Claude Code session markers. */
export function scrubSpawnEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || CLAUDE_SESSION_MARKERS.has(key)) continue;
    env[key] = value;
  }
  return env;
}

function cleanEnv(): Record<string, string> {
  return scrubSpawnEnv(process.env);
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
