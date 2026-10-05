import { execFile } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { codexSessionMeta } from "./codex-transcript.js";

/**
 * Which Codex session a terminal is running. Codex writes each conversation
 * to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`,
 * creating the file when the session starts and keeping it open for as long
 * as the session lives — so the rollout a `codex` process under a terminal's
 * PTY holds open *is* that terminal's session. No guessing from directories
 * or timestamps, and it works for `codex` typed into a shell as well as for
 * agent spawns. (Codex has hooks that could name the file, but it asks the
 * person to trust every new hook before running it.)
 *
 * Since Codex 0.160 the TUI is a thin client of a machine-wide app-server
 * daemon (`~/.codex/app-server-daemon`), and *that* process holds every
 * rollout open — the terminal's own tree holds none. For a Codex that holds
 * no rollout the session is matched instead by what the rollout says about
 * itself: a session in the terminal's working dir that started when its
 * Codex process did (`session_meta.timestamp` vs the process's `etime`), or
 * failing that one there that has been written to since (a resume). A
 * rollout another terminal already follows is never picked twice.
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
  /** When the process started (ms since the epoch), when `ps` said. */
  startedAt?: number;
}

/** `ps`'s elapsed time (`[[dd-]hh:]mm:ss`) in milliseconds, or null. */
export function parseElapsed(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(min) * 60 + Number(s)) * 1000;
}

/** Every process on the machine: pid, parent, start time, executable. */
export async function listProcesses(now = Date.now()): Promise<ProcessRow[]> {
  const stdout = await run("ps", ["-axo", "pid=,ppid=,etime=,comm="], 16 * 1024 * 1024);
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const elapsed = parseElapsed(m[3]!);
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      comm: m[4]!,
      ...(elapsed === null ? {} : { startedAt: now - elapsed }),
    });
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
  /** The rollout was matched by dir and time, not held open by the terminal's Codex. */
  inferred: boolean;
}

/** What a rollout on disk says about its session. */
export interface RolloutInfo {
  path: string;
  cwd: string | null;
  /** `session_meta.timestamp`, ms since the epoch (the file's birth when absent). */
  startedAt: number;
  modifiedAt: number;
  subagent: boolean;
}

/** A session's start, from its meta line (`payload.timestamp`) or the line's own stamp. */
function sessionStartedAt(line: string): number | null {
  try {
    const d = JSON.parse(line);
    const stamp = d?.payload?.timestamp ?? d?.timestamp;
    const ms = typeof stamp === "string" ? Date.parse(stamp) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

const dayDir = (root: string, t: number) => {
  const day = new Date(t);
  return join(
    root,
    String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, "0"),
    String(day.getDate()).padStart(2, "0"),
  );
};

/** Trailing-slash-insensitive, resolved form of a dir for comparing cwds. */
function sameDir(a: string | null, b: string): boolean {
  return a !== null && resolve(a) === resolve(b);
}

const DAY_MS = 86_400_000;
/** A session is "the process's own" when it started this close to the process. */
const START_SLACK_MS = 5_000;

/**
 * The rollouts written on the days from `since` to `now` (at most a week),
 * each described by its meta line. Meta lines never change, so they are
 * read once per path; the mtime is fresh each call.
 */
export class RolloutIndex {
  private meta = new Map<string, { cwd: string | null; startedAt: number; subagent: boolean }>();

  constructor(private readonly home: string = codexHomeDir()) {}

  list(since: number, now: number): RolloutInfo[] {
    const root = join(this.home, "sessions");
    const out: RolloutInfo[] = [];
    const seenDirs = new Set<string>();
    for (let t = Math.max(since, now - 7 * DAY_MS); t <= now + DAY_MS; t += DAY_MS) {
      const dir = dayDir(root, t);
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
        const path = join(dir, name);
        let modifiedAt: number;
        let birth: number;
        try {
          const st = statSync(path);
          modifiedAt = st.mtimeMs;
          birth = st.birthtimeMs || st.ctimeMs;
        } catch {
          continue;
        }
        let meta = this.meta.get(path);
        if (!meta) {
          const line = firstLine(path);
          const parsed = line ? codexSessionMeta(line) : null;
          if (!line || !parsed) continue; // not written yet, or not a rollout
          meta = {
            cwd: parsed.cwd,
            startedAt: sessionStartedAt(line) ?? birth,
            subagent: parsed.subagent,
          };
          this.meta.set(path, meta);
        }
        out.push({
          path,
          modifiedAt,
          cwd: meta.cwd,
          startedAt: meta.startedAt,
          subagent: meta.subagent,
        });
      }
    }
    return out;
  }
}

/**
 * The rollout a Codex process that holds none open is writing through the
 * app-server daemon: among the sessions in the terminal's dir that are not
 * another terminal's, the one that started with the process (earliest after
 * it), else the one most recently written to since the process started (a
 * resumed thread). Null when nothing fits — a `codex` still at its prompt
 * with no session yet.
 */
export function matchRollout(
  rollouts: RolloutInfo[],
  dir: string,
  processStartedAt: number,
  taken: ReadonlySet<string>,
): string | null {
  const since = processStartedAt - START_SLACK_MS;
  const mine = rollouts.filter(
    (r) => !r.subagent && !taken.has(r.path) && sameDir(r.cwd, dir) && r.modifiedAt >= since,
  );
  const fresh = mine.filter((r) => r.startedAt >= since).sort((a, b) => a.startedAt - b.startedAt);
  if (fresh.length > 0) return fresh[0]!.path;
  const resumed = mine.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return resumed[0]?.path ?? null;
}

export interface LiveTerminal {
  terminalId: string;
  pid: number;
  /** The terminal's working dir, for matching a rollout by its `cwd`. */
  dir?: string;
}

/**
 * Keeps each terminal's Codex session current. `scan` is cheap to call
 * often: one `ps` per call, and open files are read only for a terminal
 * whose Codex processes changed or whose last look is RECHECK_MS old.
 */
export class CodexSessionFinder {
  private found = new Map<string, Found>();
  private scanning = false;
  private readonly index: RolloutIndex;

  constructor(
    private readonly deps: {
      listProcesses: () => Promise<ProcessRow[]>;
      openRollouts: (pid: number) => Promise<string[]>;
      now?: () => number;
      codexHome?: string;
    } = { listProcesses, openRollouts },
  ) {
    this.index = new RolloutIndex(deps.codexHome);
  }

  /** Terminal id → the rollout its Codex is writing, for terminals running Codex. */
  async scan(terminals: LiveTerminal[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (this.scanning || terminals.length === 0) return result;
    this.scanning = true;
    try {
      const rows = await this.deps.listProcesses().catch(() => [] as ProcessRow[]);
      const now = (this.deps.now ?? Date.now)();
      const live = new Set<string>();
      let rollouts: RolloutInfo[] | null = null;
      for (const { terminalId, pid, dir } of terminals) {
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
        let path = pickMainRollout(paths);
        let inferred = false;
        if (!path && prev?.inferred && prev.pidsKey === pidsKey) {
          // Matched earlier by dir and time; the same process keeps it (the
          // next session started in that dir may well be another terminal's).
          path = prev.path;
          inferred = true;
        } else if (!path && dir) {
          const started = Math.min(...codex.map((r) => r.startedAt ?? now));
          rollouts ??= this.index.list(now - 7 * DAY_MS, now);
          const taken = new Set<string>();
          for (const [id, f] of this.found) if (id !== terminalId && f.path) taken.add(f.path);
          path = matchRollout(rollouts, dir, started, taken);
          inferred = path !== null;
        }
        this.found.set(terminalId, { pidsKey, path, checkedAt: now, inferred });
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
