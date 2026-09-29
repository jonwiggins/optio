import { execFile } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexSessionMeta } from "./codex-transcript.js";

/**
 * Which Codex session a terminal is running. Codex writes each conversation
 * to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`,
 * creating the file with the first message and keeping it open for as long
 * as the session lives — so the rollout a `codex` process under a terminal's
 * PTY holds open *is* that terminal's session. No guessing from directories
 * or timestamps, and it works for `codex` typed into a shell as well as for
 * agent spawns. (Codex has hooks that could name the file, but it asks the
 * person to trust every new hook before running it.)
 *
 * Open files come from `lsof` on macOS and /proc on Linux.
 */

/** A command's stdout. */
function run(file: string, args: string[], maxBuffer: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

const ROLLOUT_RE = /\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/;
const CODEX_COMM_RE = /(^|\/)codex[^/]*$/i;
const COMMAND_TIMEOUT_MS = 3000;
/** Re-read a known session's open files this often, to notice `/new` or a new `codex`. */
const RECHECK_MS = 15_000;

export interface ProcessRow {
  pid: number;
  ppid: number;
  comm: string;
}

/** Every process on the machine: pid, parent, executable. */
export async function listProcesses(): Promise<ProcessRow[]> {
  const stdout = await run("ps", ["-axo", "pid=,ppid=,comm="], 16 * 1024 * 1024);
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3]! });
  }
  return rows;
}

/** `root` and everything under it (a shell's `codex`, the native binary npm's wrapper starts). */
export function processTree(rows: ProcessRow[], root: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r);
    else children.set(r.ppid, [r]);
  }
  const out: ProcessRow[] = [];
  const self = rows.find((r) => r.pid === root);
  if (self) out.push(self);
  const queue = [root];
  const seen = new Set(queue);
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

export function isCodexProcess(row: ProcessRow): boolean {
  return CODEX_COMM_RE.test(row.comm.trim());
}

/** Rollout files a process has open. */
export async function openRollouts(pid: number): Promise<string[]> {
  if (process.platform === "linux") {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (ROLLOUT_RE.test(target)) out.push(target);
      } catch {
        // closed meanwhile
      }
    }
    return out;
  }
  try {
    const stdout = await run("lsof", ["-a", "-p", String(pid), "-Fn"], 4 * 1024 * 1024);
    return stdout
      .split("\n")
      .filter((l) => l.startsWith("n") && ROLLOUT_RE.test(l.slice(1)))
      .map((l) => l.slice(1));
  } catch {
    return []; // no lsof, or the process just went away
  }
}

function firstLine(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString("utf-8", 0, n);
    const end = text.indexOf("\n");
    return end >= 0 ? text.slice(0, end) : text;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The conversation the person is having, among the rollouts a Codex process
 * holds: subagent threads (multi-agent mode forks one per task) are the
 * main thread's internals. Newest first when there are several.
 */
export function pickMainRollout(paths: string[]): string | null {
  const main = [...new Set(paths)].filter((p) => {
    const meta = firstLine(p);
    const parsed = meta ? codexSessionMeta(meta) : null;
    return !parsed?.subagent;
  });
  if (main.length <= 1) return main[0] ?? null;
  const mtime = (p: string) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  return main.sort((a, b) => mtime(b) - mtime(a))[0]!;
}

interface Found {
  /** The Codex pids the rollout was looked up for. */
  pidsKey: string;
  path: string | null;
  checkedAt: number;
}

/**
 * Keeps each terminal's Codex session current. `scan` is cheap to call
 * often: one `ps` per call, and open files are read only for a terminal
 * whose Codex processes changed or whose last look is RECHECK_MS old.
 */
export class CodexSessionFinder {
  private found = new Map<string, Found>();
  private scanning = false;

  constructor(
    private readonly deps: {
      listProcesses: () => Promise<ProcessRow[]>;
      openRollouts: (pid: number) => Promise<string[]>;
      now?: () => number;
    } = { listProcesses, openRollouts },
  ) {}

  /** Terminal id → the rollout its Codex is writing, for terminals running Codex. */
  async scan(terminals: Array<{ terminalId: string; pid: number }>): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (this.scanning || terminals.length === 0) return result;
    this.scanning = true;
    try {
      const rows = await this.deps.listProcesses().catch(() => [] as ProcessRow[]);
      const now = (this.deps.now ?? Date.now)();
      const live = new Set<string>();
      for (const { terminalId, pid } of terminals) {
        live.add(terminalId);
        const codex = processTree(rows, pid).filter(isCodexProcess);
        if (codex.length === 0) {
          this.found.delete(terminalId);
          continue;
        }
        const pidsKey = codex.map((r) => r.pid).join(",");
        const prev = this.found.get(terminalId);
        if (prev && prev.pidsKey === pidsKey && prev.path && now - prev.checkedAt < RECHECK_MS) {
          result.set(terminalId, prev.path);
          continue;
        }
        const paths: string[] = [];
        for (const r of codex) paths.push(...(await this.deps.openRollouts(r.pid)));
        const path = pickMainRollout(paths);
        this.found.set(terminalId, { pidsKey, path, checkedAt: now });
        if (path) result.set(terminalId, path);
      }
      for (const id of this.found.keys()) if (!live.has(id)) this.found.delete(id);
    } finally {
      this.scanning = false;
    }
    return result;
  }
}

export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A finished Codex session's rollout, by thread id. Thread ids are UUIDv7,
 * so the id says roughly when the session started: that day's folder (and
 * the ones beside it, for a timezone change) is looked at first, then all.
 */
export function findCodexRollout(threadId: string, home = codexHomeDir()): string | null {
  if (!THREAD_ID_RE.test(threadId)) return null;
  const root = join(home, "sessions");
  const suffix = `-${threadId.toLowerCase()}.jsonl`;
  const inDir = (dir: string): string | null => {
    try {
      const hit = readdirSync(dir).find(
        (name) => name.startsWith("rollout-") && name.toLowerCase().endsWith(suffix),
      );
      return hit ? join(dir, hit) : null;
    } catch {
      return null;
    }
  };
  const ms = parseInt(threadId.replace(/-/g, "").slice(0, 12), 16);
  if (Number.isFinite(ms) && ms > 0) {
    for (const offset of [0, -1, 1]) {
      const day = new Date(ms + offset * 86_400_000);
      const dir = join(
        root,
        String(day.getFullYear()),
        String(day.getMonth() + 1).padStart(2, "0"),
        String(day.getDate()).padStart(2, "0"),
      );
      const hit = inDir(dir);
      if (hit) return hit;
    }
  }
  const list = (dir: string) => {
    try {
      return readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const y of list(root)) {
    for (const m of list(join(root, y))) {
      for (const d of list(join(root, y, m))) {
        const hit = inDir(join(root, y, m, d));
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** The working dir a rollout recorded for its session. */
export function codexRolloutCwd(path: string): string | null {
  const line = firstLine(path);
  return line ? (codexSessionMeta(line)?.cwd ?? null) : null;
}
