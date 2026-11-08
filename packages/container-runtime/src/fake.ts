/**
 * FakeContainerRuntime — a deterministic, in-memory ContainerRuntime for the
 * e2e test tier. Selected with OPTIO_RUNTIME=fake. No containers, no cluster:
 * "pods" are Map entries and agent runs are scripted NDJSON responses.
 *
 * How it plays an agent: the task/workflow/persistent-agent workers exec a
 * bash script whose agent line is `claude ... --input-format stream-json
 * --output-format stream-json`, then write the rendered prompt to stdin as a
 * stream-json user message. This runtime never runs the script; it detects
 * agent execs by that flag, reads the prompt off stdin, and answers with the
 * exact NDJSON event stream `parseClaudeEvent` expects: a `system:init` event
 * (carrying the session id), optional content, and a terminal `result` event.
 * Everything downstream — log persistence, cost tracking, state transitions,
 * PR detection, reconciler behavior — is the real production pipeline.
 *
 * The prompt controls the scripted behavior via directives:
 *
 *   (none)               → successful run: init + assistant text + result
 *   [[mock:pr]]          → open a PR for the pod's repo (OPTIO_REPO_URL):
 *                          a Bash `tool_use` running `gh pr create` and its
 *                          `tool_result` carrying the PR URL (what PR
 *                          detection adopts), then a raw `Opened pull
 *                          request: <url>` line — repo tasks reach PR_OPENED
 *   [[mock:pr-mention]]  → assistant text that only *mentions* another PR of
 *                          the repo (`<repo>/pull/9999`), plus a `gh pr view`
 *                          call printing it — must never be adopted
 *   [[mock:fail]]        → result with is_error=true → run fails
 *   [[mock:silent]]      → no events at all → no session id → `no_output`
 *   [[mock:sleep:MS]]    → wait MS before emitting the result (stall testing)
 *   [[mock:hang]]        → emit init, then never finish — reaped only by
 *                          close(), destroy(), or a kill-style utility exec
 *   [[mock:cost:X]]      → report X as total_cost_usd (default 0.0123)
 *   [[mock:env:NAME]]    → also print `env NAME=<value>` as the exec script
 *                          exports it (`<unset>` when it doesn't) — lets e2e
 *                          tests check what a run's agent was given
 *   [[mock:file:PATH]]   → also print `file PATH=<content as a JSON string>`
 *                          for a setup file the exec script would write
 *                          (`"<missing>"` when it carries none at that path);
 *                          a PATH starting with `*` matches a file whose
 *                          path ends with the rest (a per-run home's file)
 *   [[mock:script:TEXT]] → also print `script TEXT=present|absent`, whether
 *                          the exec script contains TEXT (a launch flag, a
 *                          cleanup line)
 *   [[mock:ticks:N:MS]]  → (run protocol only) N assistant text events
 *                          `tick 1`…`tick N`, MS apart (default 100), after
 *                          init — numbered lines a run that changes hands
 *                          mid-way must store exactly once each
 *   [[mock:echo-stdin]]  → (run protocol only) every stdin line delivered
 *                          after the prompt becomes an assistant text event
 *                          `stdin: <text>` — proves a mid-run message
 *                          reached the agent
 *   [[mock:mark:N:TEXT]] → (run protocol only) an assistant text event TEXT
 *                          right after tick N: a line of the test's choosing
 *                          in the middle of a run
 *   [[mock:slow-start:MS]] → (run protocol only) the start takes MS longer
 *                          before the agent launches, as a slow setup in the
 *                          start exec would: a window to cancel a run that
 *                          is still being set up
 *   [[mock:stderr:TEXT]] → (run protocol only) the agent's stderr.log holds
 *                          TEXT; a utility exec reading the tail of a run's
 *                          stderr.log (as the API does for a failed run)
 *                          gets it
 *
 * The run protocol (startRun / attachRun / deliverStdin / killRun,
 * run-protocol.ts) is played by a process of its own: `startRun` writes the
 * run's directory under the runtime's directory and spawns fake-agent.mjs
 * detached, which plays the same tape into `output.ndjson` and writes
 * `exit` when it ends. With `OPTIO_FAKE_RUNTIME_DIR` set (or `dir` given),
 * containers are kept on disk there too, so a second API process — or the
 * one that replaces a killed one — sees the same pods and attaches to the
 * same runs; that is what the scale-out e2e tier kills servers to prove.
 * Every JSON event the agent writes carries a `seq` field.
 *
 * Non-agent execs (worktree cleanup, orphan kills, health probes) return an
 * immediately-ending empty session; kill-style scripts (pkill/kill) also
 * terminate the container's live agent sessions, mirroring orphan cleanup in
 * a real pod. Interactive-session chat execs (`claude -p '<prompt>' ...`)
 * are played from the inline prompt. If no prompt ever arrives, the run
 * fails loudly — silent success would mask broken prompt delivery.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Readable, Writable } from "node:stream";
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
import { RUN_FILES, RUN_SIGNALS, RunStdinClosedError, STDIN_EOF_SENTINEL } from "./run-protocol.js";
import {
  AGENT_EXEC_MARKER,
  COMMAND_RUN_MARKER,
  CURSOR_EXEC_MARKER,
  UNSUPPORTED_AGENT_MARKERS,
  collectDirectiveHaystack,
  directiveArg,
  extractPromptText,
  extractScriptExport,
  noPromptResult,
  planAgentRun,
  planCommandRun,
  type TapeLine,
} from "./fake-tape.mjs";

const FAKE_AGENT_PATH = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ATTACH_POLL_MS = 50;
/** How long after the agent's pid is gone with no exit file an attach reports the run lost. */
const LOST_AFTER_MS = Number(process.env.OPTIO_FAKE_LOST_AFTER_MS ?? 3_000);

/**
 * How long exec waits for a prompt on stdin before failing the run — a
 * missing prompt means the worker's stdin delivery broke, which must surface
 * loudly rather than play a success tape. Overridable for unit tests.
 */
const PROMPT_TIMEOUT_MS = Number(process.env.OPTIO_FAKE_PROMPT_TIMEOUT_MS ?? 10_000);

/** How long `create` takes, so a test can kill a server while it makes a pod. */
const CREATE_DELAY_MS = Number(process.env.OPTIO_FAKE_CREATE_DELAY_MS ?? 0);

interface FakeContainer {
  spec: ContainerSpec;
  createdAt: Date;
}

export interface FakeRuntimeOptions {
  /**
   * Where containers and runs live on disk. Given (or `OPTIO_FAKE_RUNTIME_DIR`
   * set), the runtime is persistent: another instance on the same directory
   * sees the same containers and runs. Otherwise a private temp directory
   * holds the runs and containers stay in memory, as the old tests expect.
   */
  dir?: string;
}

export class FakeContainerRuntime implements ContainerRuntime {
  private containers = new Map<string, FakeContainer>();
  /** Live agent-session closers per container — for kill/destroy emulation. */
  private sessionClosers = new Map<string, Set<() => void>>();
  private prCounter = 0;
  /** Where runs (and, when persistent, containers) live. */
  readonly dir: string;
  /** Whether containers are kept on disk, visible to other instances. */
  readonly persistent: boolean;

  constructor(opts: FakeRuntimeOptions = {}) {
    const dir = opts.dir ?? process.env.OPTIO_FAKE_RUNTIME_DIR;
    this.persistent = Boolean(dir);
    this.dir = dir ?? mkdtempSync(join(tmpdir(), "optio-fake-runtime-"));
    mkdirSync(join(this.dir, "containers"), { recursive: true });
    mkdirSync(join(this.dir, "runs"), { recursive: true });
  }

  private containerFile(id: string): string {
    return join(this.dir, "containers", `${id}.json`);
  }

  private getContainer(id: string): FakeContainer | undefined {
    const inMemory = this.containers.get(id);
    if (inMemory || !this.persistent) return inMemory;
    try {
      const raw = JSON.parse(readFileSync(this.containerFile(id), "utf8")) as {
        spec: ContainerSpec;
        createdAt: string;
      };
      return { spec: raw.spec, createdAt: new Date(raw.createdAt) };
    } catch {
      return undefined;
    }
  }

  async create(spec: ContainerSpec): Promise<ContainerHandle> {
    if (CREATE_DELAY_MS > 0) await new Promise((r) => setTimeout(r, CREATE_DELAY_MS));
    const id = `fake-${randomBytes(6).toString("hex")}`;
    const name = spec.name ?? id;
    const container = { spec, createdAt: new Date() };
    this.containers.set(id, container);
    if (this.persistent) {
      writeFileSync(this.containerFile(id), JSON.stringify(container, null, 2));
    }
    return { id, name };
  }

  async status(handle: ContainerHandle): Promise<ContainerStatus> {
    const c = this.getContainer(handle.id);
    if (!c) return { state: "unknown", reason: "fake container not found" };
    return { state: "running", startedAt: c.createdAt };
  }

  async *logs(_handle: ContainerHandle, _opts?: LogOptions): AsyncIterable<string> {
    return;
  }

  async exec(
    handle: ContainerHandle,
    command: string[],
    _opts?: ExecOptions,
  ): Promise<ExecSession> {
    const script = command.join(" ");
    if (script.includes(COMMAND_RUN_MARKER)) return this.commandSession(script);
    if (!script.includes(AGENT_EXEC_MARKER)) {
      if (UNSUPPORTED_AGENT_MARKERS.some((m) => script.includes(m))) {
        // A non-claude agent invocation would otherwise get an empty utility
        // session and be misclassified downstream — fail loudly instead.
        throw new Error(
          "FakeContainerRuntime only plays claude-code stream-json agents; " +
            "use agentType/agentRuntime claude-code in e2e tests",
        );
      }
      // Utility shell execs. Scripts that kill agent processes (orphan
      // cleanup, stall recovery) must terminate live agent sessions so
      // hanging runs are actually reapable, mirroring the real pod.
      if (/\bpkill\b|\bkill\b/.test(script)) {
        for (const closeSession of this.sessionClosers.get(handle.id) ?? []) closeSession();
        this.killRunsOf(handle.id, "TERM");
      }
      // The tail of a run's stderr (read for a failed run's message).
      const tail = script.match(
        /tail -c (\d+) '\/home\/agent\/optio\/runs\/([^'/]+)\/stderr\.log'/,
      );
      if (tail) {
        let text = "";
        try {
          const all = readFileSync(join(this.runDir(tail[2]), RUN_FILES.stderr));
          text = all.subarray(Math.max(0, all.length - Number(tail[1]))).toString("utf8");
        } catch {
          // no such run, or no stderr
        }
        return this.utilitySession(text);
      }
      return this.utilitySession();
    }
    return this.agentSession(handle.id, script);
  }

  async destroy(handle: ContainerHandle): Promise<void> {
    for (const closeSession of this.sessionClosers.get(handle.id) ?? []) closeSession();
    this.sessionClosers.delete(handle.id);
    this.containers.delete(handle.id);
    this.killRunsOf(handle.id, "KILL");
    if (this.persistent) rmSync(this.containerFile(handle.id), { force: true });
  }

  // ── The run protocol, played by fake-agent.mjs ──────────────────────────

  private runDir(runId: string): string {
    if (!SAFE_RUN_ID.test(runId)) throw new Error(`Invalid run id: ${JSON.stringify(runId)}`);
    return join(this.dir, "runs", runId);
  }

  /**
   * The run's agent pid, when the pid file's process is alive and — on
   * Linux, where /proc says — the one that wrote it (its start time
   * matches; the real supervisor's pid file works the same way). A reused
   * pid after a restart reads as not running.
   */
  private runPid(runDir: string): number | null {
    let pid: number;
    let token: string | undefined;
    try {
      [pid, token] = readFileSync(join(runDir, RUN_FILES.pid), "utf8")
        .trim()
        .split(/\s+/)
        .map((x, i) => (i === 0 ? Number.parseInt(x, 10) : x)) as [number, string | undefined];
    } catch {
      return null;
    }
    if (!Number.isFinite(pid) || !token) return null;
    if (!this.pidAlive(pid)) return null;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (start !== token) return null;
    } catch {
      // No /proc here (macOS): the pid alone has to do.
    }
    return pid;
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Signals every run of a container (a kill-style utility exec, destroy). */
  private killRunsOf(containerId: string, signal: "TERM" | "KILL"): void {
    let runs: string[] = [];
    try {
      runs = readdirSync(join(this.dir, "runs"));
    } catch {
      return;
    }
    for (const runId of runs) {
      const dir = join(this.dir, "runs", runId);
      let owner: string;
      try {
        owner = readFileSync(join(dir, "container"), "utf8").trim();
      } catch {
        continue;
      }
      if (owner !== containerId) continue;
      const pid = this.runPid(dir);
      if (pid !== null && this.pidAlive(pid)) this.signal(pid, signal);
    }
  }

  private signal(pid: number, signal: RunKillInput["signal"]): boolean {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, `SIG${signal}`);
        return true;
      } catch {
        // not a group leader, or already gone: try the next form
      }
    }
    return false;
  }

  async startRun(handle: ContainerHandle, input: RunStartInput): Promise<RunStartResult> {
    const container = this.getContainer(handle.id);
    if (!container) throw new Error(`fake container ${handle.id} not found`);
    const script = input.script;
    let tape: Record<string, unknown>;
    if (script.includes(COMMAND_RUN_MARKER)) {
      tape = { kind: "command", script };
    } else if (!script.includes(AGENT_EXEC_MARKER) && !script.includes(CURSOR_EXEC_MARKER)) {
      throw new Error(
        "FakeContainerRuntime only plays claude-code stream-json agents; " +
          "use agentType/agentRuntime claude-code in e2e tests",
      );
    } else {
      // The prompt: cursor passes it positionally; claude gets it as the
      // first stream-json user message of the run's stdin.
      let initialPrompt: string | null = null;
      if (script.includes(CURSOR_EXEC_MARKER)) {
        initialPrompt =
          extractScriptExport(script, "OPTIO_PROMPT") || (container.spec.env?.OPTIO_PROMPT ?? "");
      } else {
        for (const line of input.initialStdin.split("\n")) {
          const text = extractPromptText(line);
          if (text !== null) {
            initialPrompt = text;
            break;
          }
        }
      }
      tape = {
        kind: "agent",
        script,
        specEnv: container.spec.env ?? {},
        initialPrompt,
        sessionId: randomUUID(),
        promptTimeoutMs: PROMPT_TIMEOUT_MS,
        eofTimeoutMs: Number(process.env.OPTIO_FAKE_EOF_TIMEOUT_MS ?? 60_000),
        // Distinct across processes sharing a directory: no counter to race on.
        prNumber: this.persistent ? randomInt(1, 9000) : ++this.prCounter,
      };
    }

    const dir = this.runDir(input.runId);
    mkdirSync(dir, { recursive: true });
    // A slow setup in the start exec, before the agent launches.
    const haystack =
      tape.kind === "agent"
        ? collectDirectiveHaystack(script, String(tape.initialPrompt ?? ""))
        : "";
    const slowStart = Number(directiveArg(haystack, "slow-start") ?? 0);
    if (slowStart > 0) await new Promise((r) => setTimeout(r, slowStart));
    // Like the real start script: a previous attempt's agent still alive in
    // this directory is stopped first — TERM, then KILL — and one that will
    // not go fails the start with nothing touched: one run directory, one
    // agent. Its files are then moved aside, never truncated in place.
    const previous = this.runPid(dir);
    if (previous !== null) {
      for (const signal of ["TERM", "KILL"] as const) {
        if (!this.pidAlive(previous)) break;
        this.signal(previous, signal);
        const until = Date.now() + 5_000;
        while (this.pidAlive(previous) && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      if (this.pidAlive(previous)) {
        throw new Error(
          `a previous attempt's agent (pid ${previous}) is still running in the run directory and would not stop`,
        );
      }
    }
    const old = `${dir}.prev-${Date.now()}-${randomBytes(3).toString("hex")}`;
    let moved = false;
    for (const f of Object.values(RUN_FILES)) {
      if (!existsSync(join(dir, f))) continue;
      if (!moved) mkdirSync(old, { recursive: true });
      moved = true;
      renameSync(join(dir, f), join(old, f));
    }
    if (moved) setImmediate(() => rmSync(old, { recursive: true, force: true }));
    writeFileSync(join(dir, "container"), handle.id);
    writeFileSync(join(dir, "tape.json"), JSON.stringify(tape, null, 2));
    writeFileSync(join(dir, RUN_FILES.output), "");
    const stderrText = directiveArg(haystack, "stderr");
    writeFileSync(join(dir, RUN_FILES.stderr), stderrText ? `${stderrText}\n` : "");
    writeFileSync(join(dir, RUN_FILES.stdin), input.initialStdin);

    // Detached, in a session of its own, and unreferenced: it outlives us.
    const child = spawn(process.execPath, [FAKE_AGENT_PATH, dir], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    if (!child.pid) throw new Error("could not spawn the fake agent");
    // Like the real supervisor, the agent writes its own pid file once its
    // TERM handler is installed; only then is the run "started".
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(dir, RUN_FILES.pid))) {
      if (Date.now() > deadline || !this.pidAlive(child.pid)) {
        throw new Error("the fake agent did not start");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const pid = this.runPid(dir) ?? child.pid;
    return { pid, output: "[fake] agent started\n" };
  }

  async attachRun(_handle: ContainerHandle, input: RunAttachInput): Promise<RunAttachment> {
    const dir = this.runDir(input.runId);
    const outputPath = join(dir, RUN_FILES.output);
    const exitPath = join(dir, RUN_FILES.exit);
    const output = new Readable({ read() {} });
    let offset = Math.max(0, input.fromByte);
    let closed = false;
    let settle: (exit: RunExit) => void = () => {};
    const exit = new Promise<RunExit>((resolve) => {
      settle = resolve;
    });
    const end = (value: RunExit) => {
      if (closed) return;
      closed = true;
      output.push(null);
      settle(value);
    };

    const pid = this.runPid(dir);
    if (!existsSync(outputPath) || (pid === null && !existsSync(exitPath))) {
      end({ kind: "lost" });
      return { output, exit, close: () => {} };
    }

    let deadSince: number | null = null;
    // The output file as it was at attach, by descriptor (like `tail -f`):
    // a later attempt's start moves it aside and writes a new one, which
    // this attachment never reads.
    let fd: number | null = null;
    try {
      fd = openSync(outputPath, "r");
    } catch {
      fd = null;
    }
    const release = () => {
      if (fd === null) return;
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      fd = null;
    };
    exit.then(release, release);
    const pump = (): boolean => {
      if (fd === null) return false;
      const size = fstatSync(fd).size;
      if (size > offset) {
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        output.push(buf);
        return true;
      }
      return false;
    };
    const tick = () => {
      if (closed) return;
      pump();
      if (existsSync(exitPath)) {
        // The agent writes exit after its last output line: drain, then end.
        pump();
        const code = Number.parseInt(readFileSync(exitPath, "utf8"), 10);
        // A file still being written has no code yet: look again next tick.
        if (Number.isFinite(code)) {
          end({ kind: "exited", code });
          return;
        }
      }
      if (pid === null || !this.pidAlive(pid)) {
        deadSince ??= Date.now();
        if (Date.now() - deadSince > LOST_AFTER_MS) {
          pump();
          end({ kind: "lost" });
          return;
        }
      }
      setTimeout(tick, ATTACH_POLL_MS).unref?.();
    };
    tick();

    return {
      output,
      exit,
      close: () => end({ kind: "detached", reason: "closed" }),
    };
  }

  async deliverStdin(_handle: ContainerHandle, input: RunStdinInput): Promise<void> {
    if (input.line.includes("\n") || input.line.includes("\r")) {
      throw new Error("a stdin line must not contain a newline");
    }
    const dir = this.runDir(input.runId);
    if (!existsSync(dir)) throw new Error(`fake run ${input.runId} not found`);
    // Like the real deliver script: once the sentinel is in, stdin is closed.
    const stdinPath = join(dir, RUN_FILES.stdin);
    const sofar = existsSync(stdinPath) ? readFileSync(stdinPath, "utf8") : "";
    if (sofar.split("\n").includes(STDIN_EOF_SENTINEL)) throw new RunStdinClosedError(input.runDir);
    appendFileSync(stdinPath, `${input.line}\n`);
  }

  async killRun(_handle: ContainerHandle, input: RunKillInput): Promise<boolean> {
    if (!RUN_SIGNALS.includes(input.signal)) throw new Error(`Unsupported signal: ${input.signal}`);
    const dir = this.runDir(input.runId);
    // A run with an exit file is over, whatever its process is still doing
    // in its last milliseconds (the real kill script keys on the pid alone,
    // but a bash supervisor is gone the instant it writes its exit).
    if (existsSync(join(dir, RUN_FILES.exit))) return false;
    const pid = this.runPid(dir);
    if (pid === null || !this.pidAlive(pid)) return false;
    // Only the attempt the caller means.
    if (input.pid !== undefined && pid !== input.pid) return false;
    return this.signal(pid, input.signal);
  }

  /** Test helper: the run directory the fake keeps for a run. */
  runDirectory(runId: string): string {
    return this.runDir(runId);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  /**
   * A Job that runs a shell command (no agent): its output, then the exit
   * status line the real script prints. `[[mock:fail]]` in the command
   * exits 1; `[[mock:silent]]` cuts the stream before any status.
   */
  private commandSession(script: string): ExecSession {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({ write: (_c, _e, cb) => cb() });
    // The command travels in the script itself (`export OPTIO_COMMAND='…'`).
    setImmediate(() => {
      const plan = planCommandRun(script);
      for (const line of plan.lines) stdout.write(`${"raw" in line ? line.raw : ""}\n`);
      if (plan.exitMarker) stdout.write(`__OPTIO_RUN_EXIT__:${plan.exitCode}\n`);
      stdout.end();
      stderr.end();
    });
    return { stdin, stdout, stderr, resize: () => {}, close: () => stdout.end() };
  }

  /** Empty session for non-agent shell execs: ends immediately, exit-ok. */
  private utilitySession(output = ""): ExecSession {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({ write: (_c, _e, cb) => cb() });
    if (output) stdout.end(output);
    else stdout.end();
    stderr.end();
    return {
      stdin,
      stdout,
      stderr,
      resize: () => {},
      close: () => {},
    };
  }

  private agentSession(containerId: string, script: string): ExecSession {
    const spec = this.getContainer(containerId)?.spec;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const sessionId = randomUUID();
    let closed = false;
    let promptHandled = false;
    let stdinBuf = "";
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;

    const emit = (event: Record<string, unknown>) => {
      if (!closed) stdout.write(JSON.stringify(event) + "\n");
    };
    const emitRaw = (line: string) => {
      if (!closed) stdout.write(line + "\n");
    };
    const finish = (exitCode?: number) => {
      if (closed) return;
      if (exitCode !== undefined) {
        if (script.includes("__OPTIO_RUN_EXIT__:")) emitRaw(`__OPTIO_RUN_EXIT__:${exitCode}`);
        if (script.includes("__OPTIO_CHAT_EXIT__:")) emitRaw(`__OPTIO_CHAT_EXIT__:${exitCode}`);
      }
      stdout.end();
      stderr.end();
    };

    const writeLine = (line: TapeLine) => {
      if ("event" in line) emit(line.event);
      else emitRaw(line.raw);
    };
    const run = async (echoPrompt: string) => {
      // Directives may live in the stdin prompt (standalone jobs, persistent
      // agents) or buried in the exec script's task file (repo tasks).
      const plan = planAgentRun({
        script,
        prompt: echoPrompt,
        specEnv: spec?.env ?? {},
        prNumber: ++this.prCounter,
        sessionId,
      });
      if (plan.kind === "silent") {
        finish();
        return;
      }
      emit(plan.init);
      if (plan.hang) {
        return; // stream stays open until close()
      }
      if (plan.sleepMs > 0) {
        await new Promise<void>((r) => {
          sleepTimer = setTimeout(r, plan.sleepMs);
          sleepTimer.unref?.();
        });
        if (closed) return;
      }
      for (const line of plan.lines) writeLine(line);
      finish(plan.exitCode);
    };

    const handlePrompt = (prompt: string) => {
      if (promptHandled) return;
      promptHandled = true;
      clearTimeout(promptTimer);
      void run(prompt);
    };

    // Interactive-session chat execs pass the prompt inline (`claude -p
    // '<prompt>' ...`) instead of over stdin — play it immediately.
    const inlinePrompt = script.match(/\bclaude\s+-p\s+'([^']*)'/);

    // The workers write the prompt right after exec resolves. If none ever
    // arrives, stdin delivery broke — fail the run loudly instead of playing
    // a success tape that would mask the regression.
    const promptTimer = setTimeout(() => {
      if (promptHandled) return;
      promptHandled = true;
      emit(noPromptResult(sessionId, PROMPT_TIMEOUT_MS));
      finish();
    }, PROMPT_TIMEOUT_MS);
    promptTimer.unref?.();

    const stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        stdinBuf += chunk.toString();
        let idx: number;
        while ((idx = stdinBuf.indexOf("\n")) >= 0) {
          const line = stdinBuf.slice(0, idx);
          stdinBuf = stdinBuf.slice(idx + 1);
          const prompt = extractPromptText(line);
          if (prompt !== null) handlePrompt(prompt);
        }
        cb();
      },
    });

    const close = () => {
      if (closed) {
        return;
      }
      clearTimeout(promptTimer);
      if (sleepTimer) clearTimeout(sleepTimer);
      // Mirror the k8s exec contract: a severed session ENDS the streams
      // (consumers see a normal end-of-stream), it does not error them.
      stdout.end();
      stderr.end();
      closed = true;
      this.sessionClosers.get(containerId)?.delete(close);
    };

    let closers = this.sessionClosers.get(containerId);
    if (!closers) {
      closers = new Set();
      this.sessionClosers.set(containerId, closers);
    }
    closers.add(close);

    if (inlinePrompt) handlePrompt(inlinePrompt[1]);
    // Cursor delivers the prompt as a positional env-var reference, not stdin.
    if (script.includes(CURSOR_EXEC_MARKER)) {
      handlePrompt(extractScriptExport(script, "OPTIO_PROMPT") || (spec?.env?.OPTIO_PROMPT ?? ""));
    }

    return {
      stdin,
      stdout,
      stderr,
      resize: () => {},
      close,
    };
  }
}
