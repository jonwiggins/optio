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
 *   [[mock:echo-stdin]]  → (run protocol only) every stdin line delivered
 *                          after the prompt becomes an assistant text event
 *                          `stdin: <text>` — proves a mid-run message
 *                          reached the agent
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
import { RUN_FILES, RUN_SIGNALS } from "./run-protocol.js";

const FAKE_AGENT_PATH = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ATTACH_POLL_MS = 50;
/** How long after the agent's pid is gone with no exit file an attach reports the run lost. */
const LOST_AFTER_MS = Number(process.env.OPTIO_FAKE_LOST_AFTER_MS ?? 3_000);

const AGENT_EXEC_MARKER = "--output-format stream-json";
/** A Job's shell command (apps/api/src/services/command-run.ts). */
const COMMAND_RUN_MARKER = 'bash -lc "$OPTIO_COMMAND"';
/** Markers of non-claude agent CLIs the fake cannot play — fail loudly. */
const UNSUPPORTED_AGENT_MARKERS = [" codex ", " copilot ", " gemini ", " opencode ", " openclaw "];
/**
 * Cursor's stream-json events are claude-shaped (system:init / assistant /
 * result), so the fake plays cursor-agent execs with the standard tape. The
 * prompt arrives as a positional `"$OPTIO_PROMPT"` (no stdin priming), set by
 * the exec script's `export OPTIO_PROMPT='...'` line — extract it from there.
 */
const CURSOR_EXEC_MARKER = "cursor-agent ";

/** The value an exec script exports for `name` (`export NAME='…'`), or null. */
function extractScriptExport(script: string, name: string): string | null {
  const m = script.match(new RegExp(`export ${name}='([^']*(?:'\\\\''[^']*)*)'`));
  return m ? m[1].replaceAll("'\\''", "'") : null;
}

/**
 * How long exec waits for a prompt on stdin before failing the run — a
 * missing prompt means the worker's stdin delivery broke, which must surface
 * loudly rather than play a success tape. Overridable for unit tests.
 */
const PROMPT_TIMEOUT_MS = Number(process.env.OPTIO_FAKE_PROMPT_TIMEOUT_MS ?? 10_000);

interface FakeContainer {
  spec: ContainerSpec;
  createdAt: Date;
}

function extractPromptText(line: string): string | null {
  try {
    const msg = JSON.parse(line) as {
      type?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (msg.type !== "user") return null;
    const blocks = msg.message?.content ?? [];
    return blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  } catch {
    return null;
  }
}

function directive(prompt: string, name: string): boolean {
  return prompt.includes(`[[mock:${name}]]`);
}

function directiveArg(prompt: string, name: string): string | null {
  const m = prompt.match(new RegExp(`\\[\\[mock:${name}:([^\\]]+)\\]\\]`));
  return m ? m[1] : null;
}

/**
 * Directives can hide inside the exec script rather than the stdin prompt:
 * for REPO tasks the stdin prompt is the rendered coding template (the raw
 * task prompt only exists in the task FILE, which travels base64-encoded in
 * the script — env blob → OPTIO_SETUP_FILES → file content). Decode base64
 * runs up to two levels deep and search everything.
 */
function collectDirectiveHaystack(script: string, prompt: string): string {
  const parts = [prompt];
  const decodeOnce = (s: string): string | null => {
    try {
      const text = Buffer.from(s, "base64").toString("utf8");
      // Reject binary-looking decodes.
      return /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 200)) ? null : text;
    } catch {
      return null;
    }
  };
  for (const run of script.match(/[A-Za-z0-9+/=]{80,}/g) ?? []) {
    const level1 = decodeOnce(run);
    if (!level1) continue;
    parts.push(level1);
    for (const nested of level1.match(/[A-Za-z0-9+/=]{80,}/g) ?? []) {
      const level2 = decodeOnce(nested);
      if (level2) parts.push(level2);
    }
  }
  return parts.join("\n");
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

  private runPid(runDir: string): number | null {
    try {
      const pid = Number.parseInt(readFileSync(join(runDir, RUN_FILES.pid), "utf8"), 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
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
    for (const f of [RUN_FILES.exit, RUN_FILES.pid]) rmSync(join(dir, f), { force: true });
    writeFileSync(join(dir, "container"), handle.id);
    writeFileSync(join(dir, "tape.json"), JSON.stringify(tape, null, 2));
    writeFileSync(join(dir, RUN_FILES.output), "");
    writeFileSync(join(dir, RUN_FILES.stderr), "");
    writeFileSync(join(dir, RUN_FILES.stdin), input.initialStdin);

    // Detached, in a session of its own, and unreferenced: it outlives us.
    const child = spawn(process.execPath, [FAKE_AGENT_PATH, dir], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    if (!child.pid) throw new Error("could not spawn the fake agent");
    writeFileSync(join(dir, RUN_FILES.pid), `${child.pid}\n`);
    return { pid: child.pid, output: "[fake] agent started\n" };
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
    if (pid === null || !existsSync(outputPath)) {
      end({ kind: "lost" });
      return { output, exit, close: () => {} };
    }

    let deadSince: number | null = null;
    const pump = (): boolean => {
      let fd: number;
      try {
        fd = openSync(outputPath, "r");
      } catch {
        return false;
      }
      try {
        const size = fstatSync(fd).size;
        if (size > offset) {
          const buf = Buffer.alloc(size - offset);
          readSync(fd, buf, 0, buf.length, offset);
          offset = size;
          output.push(buf);
          return true;
        }
        return false;
      } finally {
        closeSync(fd);
      }
    };
    const tick = () => {
      if (closed) return;
      pump();
      if (existsSync(exitPath)) {
        // The agent writes exit after its last output line: drain, then end.
        pump();
        const code = Number.parseInt(readFileSync(exitPath, "utf8"), 10);
        end({ kind: "exited", code: Number.isFinite(code) ? code : 1 });
        return;
      }
      if (!this.pidAlive(pid)) {
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
    appendFileSync(join(dir, RUN_FILES.stdin), `${input.line}\n`);
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
      if (!directive(script, "silent")) {
        stdout.write("[optio] Running command...\n");
        stdout.write("fake command output\n");
        stdout.write(`[optio:exit] ${directive(script, "fail") ? 1 : 0}\n`);
        if (script.includes("__OPTIO_RUN_EXIT__:"))
          stdout.write(`__OPTIO_RUN_EXIT__:${directive(script, "fail") ? 1 : 0}\n`);
      }
      stdout.end();
      stderr.end();
    });
    return { stdin, stdout, stderr, resize: () => {}, close: () => stdout.end() };
  }

  /** Empty session for non-agent shell execs: ends immediately, exit-ok. */
  private utilitySession(): ExecSession {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({ write: (_c, _e, cb) => cb() });
    stdout.end();
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

    const run = async (echoPrompt: string) => {
      // Directives may live in the stdin prompt (standalone jobs, persistent
      // agents) or buried in the exec script's task file (repo tasks).
      const prompt = collectDirectiveHaystack(script, echoPrompt);
      if (directive(prompt, "silent")) {
        finish();
        return;
      }

      emit({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        model: "fake-model",
        tools: [],
      });

      if (directive(prompt, "hang")) {
        return; // stream stays open until close()
      }

      const sleepMs = Number(directiveArg(prompt, "sleep") ?? 0);
      if (sleepMs > 0) {
        await new Promise<void>((r) => {
          sleepTimer = setTimeout(r, sleepMs);
          sleepTimer.unref?.();
        });
        if (closed) return;
      }

      emit({
        type: "assistant",
        session_id: sessionId,
        message: {
          model: "fake-model",
          usage: { input_tokens: 100, output_tokens: 25 },
          content: [{ type: "text", text: `Mock agent handled: ${echoPrompt.slice(0, 120)}` }],
        },
      });

      for (const m of prompt.matchAll(/\[\[mock:env:([A-Z0-9_]+)\]\]/g)) {
        const value = extractScriptExport(script, m[1]) ?? spec?.env?.[m[1]] ?? "<unset>";
        emitRaw(`env ${m[1]}=${value}`);
      }

      // [[mock:file:PATH]] → print a setup file the exec script would write
      // (`OPTIO_SETUP_FILES`), as `file PATH=<content>`; `<missing>` when the
      // script carries no such file.
      for (const m of prompt.matchAll(/\[\[mock:file:([^\]]+)\]\]/g)) {
        const blob =
          extractScriptExport(script, "OPTIO_SETUP_FILES") ?? spec?.env?.OPTIO_SETUP_FILES;
        let content = "<missing>";
        if (blob) {
          try {
            const files = JSON.parse(Buffer.from(blob, "base64").toString("utf8")) as Array<{
              path: string;
              content?: string;
              contentBase64?: string;
            }>;
            const want = m[1];
            const f = files.find((x) =>
              want.startsWith("*") ? x.path.endsWith(want.slice(1)) : x.path === want,
            );
            if (f) {
              content = f.contentBase64
                ? Buffer.from(f.contentBase64, "base64").toString("utf8")
                : (f.content ?? "");
            }
          } catch {
            content = "<undecodable>";
          }
        }
        // One line: the content as a JSON string literal (log lines are split on newlines).
        emitRaw(`file ${m[1]}=${JSON.stringify(content)}`);
      }

      // [[mock:script:TEXT]] → whether the exec script carries TEXT — outside
      // the prompt's own export line, which carries the directive itself.
      const scriptSansPrompt = script.replace(/export OPTIO_PROMPT='[^']*(?:'\\''[^']*)*'/, "");
      for (const m of prompt.matchAll(/\[\[mock:script:([^\]]+)\]\]/g)) {
        emitRaw(`script ${m[1]}=${scriptSansPrompt.includes(m[1]) ? "present" : "absent"}`);
      }

      const repoUrl = (spec?.env?.OPTIO_REPO_URL ?? "https://github.com/mock/repo").replace(
        /\.git$/,
        "",
      );
      const toolCall = (id: string, command: string, output: string) => {
        emit({
          type: "assistant",
          session_id: sessionId,
          message: {
            model: "fake-model",
            content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
          },
        });
        emit({
          type: "user",
          session_id: sessionId,
          message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] },
        });
      };

      if (directive(prompt, "pr-mention")) {
        const mentioned = `${repoUrl}/pull/9999`;
        emit({
          type: "assistant",
          session_id: sessionId,
          message: {
            model: "fake-model",
            content: [{ type: "text", text: `This is similar to ${mentioned} (see #9999).` }],
          },
        });
        toolCall(`toolu_view_${randomUUID().slice(0, 8)}`, "gh pr view 9999", `url: ${mentioned}`);
      }

      if (directive(prompt, "pr")) {
        this.prCounter += 1;
        const prUrl = `${repoUrl}/pull/${this.prCounter}`;
        toolCall(
          `toolu_create_${randomUUID().slice(0, 8)}`,
          "git push -u origin HEAD && gh pr create --fill",
          `${prUrl}\n`,
        );
        emitRaw(`Opened pull request: ${prUrl}`);
      }

      const isError = directive(prompt, "fail");
      const cost = Number(directiveArg(prompt, "cost") ?? 0.0123);
      emit({
        type: "result",
        subtype: isError ? "error_during_execution" : "success",
        is_error: isError,
        result: isError ? "Mock agent failure" : "Mock agent success",
        total_cost_usd: cost,
        num_turns: 1,
        duration_ms: 5,
        session_id: sessionId,
      });
      finish(isError ? 1 : 0);
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
      emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: `FakeContainerRuntime: no prompt arrived on stdin within ${PROMPT_TIMEOUT_MS}ms — prompt delivery is broken`,
        total_cost_usd: 0,
        num_turns: 0,
        duration_ms: PROMPT_TIMEOUT_MS,
        session_id: sessionId,
      });
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
