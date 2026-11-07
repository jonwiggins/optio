/**
 * The process runtime runs a child process with its parent's privileges.
 * It is for trusted local callers only; API-requested agent work must use an
 * isolated container. It speaks the run protocol's four operations and keeps the run
 * directory's files (run-protocol.ts: `output.ndjson`, `stderr.log`,
 * `stdin.ndjson`, `pid`, `exit`), so a consumer attaches from a byte offset
 * exactly as it does to a pod.
 *
 * What differs from the pod runtimes: there is no detached supervisor. The
 * agent is this process's child, in its own process group (`killRun`
 * signals the group), reaped here, and gone with this process — an API
 * restart ends its runs (a later attach finds them `lost`), which is the
 * trade the placement makes. The start script runs as given, in the
 * foreground: callers build it without `superviseAgent()`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ContainerSpec, ContainerHandle, ContainerStatus, ExecSession } from "@optio/shared";
import type {
  ContainerRuntime,
  ExecOptions,
  LogOptions,
  RunAttachInput,
  RunAttachment,
  RunExit,
  RunKillInput,
  RunStartInput,
  RunStartResult,
  RunStdinInput,
} from "./types.js";
import { RUN_DIR_ENV, RUN_FILES, RunStdinClosedError, STDIN_EOF_SENTINEL } from "./run-protocol.js";

/** The one handle: there is no container, only this process. */
export const PROCESS_HANDLE: ContainerHandle = { id: "process", name: "api-process" };

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_RUN_DIR = /^\/[A-Za-z0-9_./-]+$/;

interface LiveRun {
  runId: string;
  runDir: string;
  child: ChildProcess;
  pid: number;
  /** Bytes appended to `output.ndjson` so far. */
  written: number;
  /** `data(chunk, offsetBefore)` as output lands; `end` once the agent exited. */
  events: EventEmitter;
  stdinClosed: boolean;
  exited: RunExit | null;
}

export interface ProcessRuntimeOptions {
  /** The child's base environment (the start script exports the run's own). Default: PATH and HOME of this process. */
  env?: Record<string, string>;
}

export class ProcessContainerRuntime implements ContainerRuntime {
  private readonly runs = new Map<string, LiveRun>();
  private readonly env: Record<string, string>;

  constructor(opts: ProcessRuntimeOptions = {}) {
    this.env = opts.env ?? baseEnv();
  }

  async create(_spec: ContainerSpec): Promise<ContainerHandle> {
    return PROCESS_HANDLE;
  }

  async status(_handle: ContainerHandle): Promise<ContainerStatus> {
    return { state: "running" };
  }

  async *logs(_handle: ContainerHandle, _opts?: LogOptions): AsyncIterable<string> {}

  async exec(
    _handle: ContainerHandle,
    command: string[],
    _opts?: ExecOptions,
  ): Promise<ExecSession> {
    const [bin, ...args] = command;
    if (!bin) throw new Error("exec: empty command");
    const child = spawn(bin, args, { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      resize() {},
      close() {
        child.kill("SIGTERM");
      },
    };
  }

  async destroy(_handle: ContainerHandle): Promise<void> {}

  async ping(): Promise<boolean> {
    return true;
  }

  // ── The run protocol ──────────────────────────────────────────────────

  async startRun(_handle: ContainerHandle, input: RunStartInput): Promise<RunStartResult> {
    const runDir = assertRunDir(input.runDir);
    if (!SAFE_RUN_ID.test(input.runId))
      throw new Error(`Invalid run id: ${JSON.stringify(input.runId)}`);
    const previous = this.runs.get(input.runId);
    if (previous && !previous.exited) {
      throw new Error(`run ${input.runId} is still active; inspect before retrying`);
    }
    mkdirSync(runDir, { recursive: true });
    for (const f of [RUN_FILES.output, RUN_FILES.stderr, RUN_FILES.exit, RUN_FILES.pid]) {
      writeFileSync(join(runDir, f), "");
    }
    writeFileSync(join(runDir, RUN_FILES.stdin), input.initialStdin);
    writeFileSync(join(runDir, RUN_FILES.agent), input.script);

    const child = spawn("bash", ["-c", input.script], {
      cwd: runDir,
      env: { ...this.env, [RUN_DIR_ENV]: runDir },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!child.pid) throw new Error("the run's process did not start");
    const run: LiveRun = {
      runId: input.runId,
      runDir,
      child,
      pid: child.pid,
      written: 0,
      events: new EventEmitter(),
      stdinClosed: false,
      exited: null,
    };
    run.events.setMaxListeners(0);
    this.runs.set(input.runId, run);
    writeFileSync(join(runDir, RUN_FILES.pid), `${child.pid} ${Date.now()}\n`);

    child.stdout.on("data", (chunk: Buffer) => {
      const before = run.written;
      appendFileSync(join(runDir, RUN_FILES.output), chunk);
      run.written += chunk.length;
      run.events.emit("data", chunk, before);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      appendFileSync(join(runDir, RUN_FILES.stderr), chunk);
    });
    child.stdin.on("error", () => {
      // The agent closed its stdin first (a non-interactive harness): nothing to deliver to.
    });
    child.on("exit", (code, signal) => {
      const exitCode = code ?? (signal ? 128 + signalNumber(signal) : 1);
      run.exited = { kind: "exited", code: exitCode };
      writeFileSync(join(runDir, RUN_FILES.exit), `${exitCode}\n`);
      run.events.emit("end");
    });

    // Prime stdin the way the supervisor does: every line up to the EOF
    // sentinel goes to the agent, and the sentinel closes its stdin.
    this.feed(run, input.initialStdin);
    return { pid: child.pid, output: "" };
  }

  async attachRun(_handle: ContainerHandle, input: RunAttachInput): Promise<RunAttachment> {
    const runDir = assertRunDir(input.runDir);
    const from = Number.isFinite(input.fromByte) ? Math.max(0, Math.floor(input.fromByte)) : 0;
    const run = this.runs.get(input.runId);
    const output = new Readable({ read() {} });
    let settle!: (exit: RunExit) => void;
    const exit = new Promise<RunExit>((resolve) => {
      settle = resolve;
    });
    let done = false;
    const finish = (value: RunExit) => {
      if (done) return;
      done = true;
      output.push(null);
      settle(value);
    };

    if (!run) {
      // No live run in this process: a finished run's files, or a run that
      // died with an earlier process (lost).
      const exitText = readIfExists(join(runDir, RUN_FILES.exit));
      const bytes = readFromByte(join(runDir, RUN_FILES.output), from);
      if (bytes.length) output.push(bytes);
      if (exitText !== null && exitText.trim() !== "") {
        finish({ kind: "exited", code: Number.parseInt(exitText.trim(), 10) || 0 });
      } else {
        finish({ kind: "lost" });
      }
      return { output, exit, close() {} };
    }

    // Subscribe first, then read what is on disk: a chunk landing in between
    // is skipped by its offset, so nothing is delivered twice or missed.
    let position = from;
    const onData = (chunk: Buffer, before: number) => {
      if (before < position) {
        const skip = position - before;
        if (skip >= chunk.length) return;
        chunk = chunk.subarray(skip);
      }
      position += chunk.length;
      output.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      finish(run.exited ?? { kind: "exited", code: 1 });
    };
    const cleanup = () => {
      run.events.off("data", onData);
      run.events.off("end", onEnd);
    };
    run.events.on("data", onData);
    run.events.on("end", onEnd);
    const bytes = readFromByte(join(runDir, RUN_FILES.output), from, run.written);
    if (bytes.length) {
      output.push(bytes);
      position = from + bytes.length;
    }
    if (run.exited) onEnd();
    return {
      output,
      exit,
      close() {
        cleanup();
        finish({ kind: "detached", reason: "closed" });
      },
    };
  }

  async deliverStdin(_handle: ContainerHandle, input: RunStdinInput): Promise<void> {
    const run = this.runs.get(input.runId);
    if (!run || run.exited || run.stdinClosed) throw new RunStdinClosedError(input.runId);
    appendFileSync(join(run.runDir, RUN_FILES.stdin), input.line + "\n");
    this.feed(run, input.line + "\n");
  }

  async killRun(_handle: ContainerHandle, input: RunKillInput): Promise<boolean> {
    const run = this.runs.get(input.runId);
    if (!run || run.exited) return false;
    if (input.pid !== undefined && input.pid !== run.pid) return false;
    for (const target of [-run.pid, run.pid]) {
      try {
        process.kill(target, `SIG${input.signal}`);
        return true;
      } catch {
        // not a group leader, or already gone: try the next form
      }
    }
    return false;
  }

  /** Lines to the agent's stdin; the EOF sentinel closes it. */
  private feed(run: LiveRun, text: string): void {
    if (run.stdinClosed || !text) return;
    const stdin = run.child.stdin!;
    const lines = text.split("\n");
    // A trailing newline leaves an empty last element: not a line.
    if (lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      if (line === STDIN_EOF_SENTINEL) {
        run.stdinClosed = true;
        stdin.end();
        return;
      }
      stdin.write(line + "\n");
    }
  }

  /** Runs this process started that have not exited (for tests and the placement cap). */
  liveRunIds(): string[] {
    return [...this.runs.values()].filter((r) => !r.exited).map((r) => r.runId);
  }
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function assertRunDir(runDir: string): string {
  if (!SAFE_RUN_DIR.test(runDir) || runDir.includes("..")) {
    throw new Error(`Invalid run directory: ${JSON.stringify(runDir)}`);
  }
  return runDir;
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** The file's bytes from `from` to `to` (the file's end by default). */
function readFromByte(path: string, from: number, to?: number): Buffer {
  if (!existsSync(path)) return Buffer.alloc(0);
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const end = Math.min(size, to ?? size);
    if (end <= from) return Buffer.alloc(0);
    const out = Buffer.alloc(end - from);
    let got = 0;
    while (got < out.length) {
      const n = readSync(fd, out, got, out.length - got, from + got);
      if (n === 0) break;
      got += n;
    }
    return out.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
function signalNumber(signal: NodeJS.Signals): number {
  return SIGNAL_NUMBERS[signal] ?? 15;
}
