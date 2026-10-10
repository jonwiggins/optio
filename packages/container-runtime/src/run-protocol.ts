/**
 * The run protocol (docs/plans/scale-out.md §1): how Optio starts an agent in
 * a pod so that no API process has to stay attached to it, and how any API
 * process attaches later.
 *
 * Every run has a directory in its pod (`runDir`, the run home) with:
 *
 *   agent.sh        the agent command, as the start script wrote it
 *   supervisor.sh   the supervisor: runs agent.sh detached from the exec
 *   stdin.ndjson    every stdin line the run was given; `__OPTIO_STDIN_EOF__`
 *                   closes the agent's stdin
 *   stdin.pipe      the FIFO the agent reads stdin from
 *   output.ndjson   the agent's stdout, appended as it runs
 *   stderr.log      the agent's stderr
 *   pid             the supervisor's pid (a process-group leader, `setsid`)
 *   exit            the agent's exit code, written when it ends
 *
 * The four operations are short execs:
 *
 *   start    the caller's setup script, then `superviseAgent()`: launch the
 *            supervisor and print `__OPTIO_RUN_STARTED__:<pid>`
 *   attach   `tail -c +<from+1> --pid=<pid> -f output.ndjson`, then
 *            `__OPTIO_RUN_EXIT__:<code>` (or `__OPTIO_RUN_LOST__`) on stderr
 *   deliver  append one line to stdin.ndjson
 *   kill     signal the supervisor's process group
 *
 * The Kubernetes and Docker runtimes run these scripts through `exec`; the
 * fake runtime plays them with local processes and the same files.
 */
import { shellQuote } from "@optio/shared";
import type { ContainerHandle, ExecSession } from "@optio/shared";
import { Readable } from "node:stream";
import type {
  ContainerRuntime,
  RunAttachment,
  RunExit,
  RunSignal,
  RunStartResult,
} from "./types.js";

export const RUN_STARTED_MARKER = "__OPTIO_RUN_STARTED__";
export const RUN_EXIT_MARKER = "__OPTIO_RUN_EXIT__";
export const RUN_LOST_MARKER = "__OPTIO_RUN_LOST__";
/** The stdin line that closes the agent's stdin (how a Claude turn is ended). */
export const STDIN_EOF_SENTINEL = "__OPTIO_STDIN_EOF__";

/** The files of a run directory. */
export const RUN_FILES = {
  agent: "agent.sh",
  supervisor: "supervisor.sh",
  stdin: "stdin.ndjson",
  stdinPipe: "stdin.pipe",
  output: "output.ndjson",
  stderr: "stderr.log",
  pid: "pid",
  exit: "exit",
} as const;

/** The env var the start script reads the run's first stdin lines from. */
export const RUN_STDIN_ENV = "OPTIO_RUN_STDIN";
/** The env var the supervisor reads the run directory from. */
export const RUN_DIR_ENV = "OPTIO_RUN_DIR";
/** Set to `1` for the supervisor to mark the pod's environment warm on success. */
export const RUN_MARK_ENV_READY_ENV = "OPTIO_RUN_MARK_ENV_READY";
/** The env var `deliverStdin`'s script reads the line from. */
const STDIN_LINE_ENV = "OPTIO_STDIN_LINE";

export const RUN_SIGNALS: readonly RunSignal[] = ["TERM", "KILL", "INT", "HUP"];

const SAFE_RUN_DIR = /^\/[A-Za-z0-9_./-]+$/;

function assertRunDir(runDir: string): string {
  if (!SAFE_RUN_DIR.test(runDir) || runDir.includes("..")) {
    throw new Error(`Invalid run directory: ${JSON.stringify(runDir)}`);
  }
  return runDir;
}

/**
 * The supervisor, as a file: launches the agent with its stdin fed from
 * `stdin.ndjson` through a FIFO, waits for it, and records its exit. It is
 * written by the start script with a quoted heredoc, so nothing in it
 * expands at write time.
 */
export const SUPERVISOR_SCRIPT: string = [
  `#!/bin/bash`,
  `d="\$${RUN_DIR_ENV}"`,
  `on_term() { kill -TERM "$agent" 2>/dev/null; wait "$agent" 2>/dev/null; echo 143 > "$d/${RUN_FILES.exit}"; exit 143; }`,
  `trap on_term TERM INT HUP`,
  `bash "$d/${RUN_FILES.agent}" < "$d/${RUN_FILES.stdinPipe}" >> "$d/${RUN_FILES.output}" 2>> "$d/${RUN_FILES.stderr}" &`,
  `agent=$!`,
  // The feeder: every line of stdin.ndjson, as it arrives, until the EOF
  // sentinel, which closes the FIFO and so the agent's stdin. `--pid` ends
  // the tail when the agent is gone, whatever stdin still holds.
  `( tail -n +1 --pid="$agent" -f "$d/${RUN_FILES.stdin}" | while IFS= read -r l; do if [ "$l" = "${STDIN_EOF_SENTINEL}" ]; then break; fi; printf '%s\\n' "$l"; done ) > "$d/${RUN_FILES.stdinPipe}" &`,
  `wait "$agent"`,
  `code=$?`,
  `echo "$code" > "$d/${RUN_FILES.exit}"`,
  `if [ "$code" -eq 0 ] && [ "\${${RUN_MARK_ENV_READY_ENV}:-}" = "1" ]; then touch /home/agent/.optio-env-ready; fi`,
  ``,
].join("\n");

/**
 * Script lines that end a start script: write the agent command and the
 * supervisor into `runDir`, prime stdin from `$OPTIO_RUN_STDIN`, launch the
 * supervisor in its own session (so the exec that started it can go away
 * and so `killRun` can signal the whole tree), and print the started marker.
 * `agentLines` run in the current directory with the current environment.
 */
export function superviseAgent(
  runDir: string,
  agentLines: readonly string[],
  opts: { markEnvReady?: boolean } = {},
): string[] {
  const d = shellQuote(assertRunDir(runDir));
  const agentScript = agentLines.join("\n");
  for (const eof of ["__OPTIO_AGENT_SH__", "__OPTIO_SUPERVISOR_SH__"]) {
    if (agentScript.includes(eof)) {
      throw new Error(`agent command contains the heredoc delimiter ${eof}`);
    }
  }
  return [
    `export ${RUN_DIR_ENV}=${d}`,
    ...(opts.markEnvReady ? [`export ${RUN_MARK_ENV_READY_ENV}=1`] : []),
    `mkdir -p "\$${RUN_DIR_ENV}"`,
    `cat > "\$${RUN_DIR_ENV}/${RUN_FILES.agent}" <<'__OPTIO_AGENT_SH__'`,
    agentScript,
    `__OPTIO_AGENT_SH__`,
    `cat > "\$${RUN_DIR_ENV}/${RUN_FILES.supervisor}" <<'__OPTIO_SUPERVISOR_SH__'`,
    SUPERVISOR_SCRIPT.trimEnd(),
    `__OPTIO_SUPERVISOR_SH__`,
    // A fresh attempt: no exit or pid from a previous one, empty output.
    `rm -f "\$${RUN_DIR_ENV}/${RUN_FILES.exit}" "\$${RUN_DIR_ENV}/${RUN_FILES.pid}" "\$${RUN_DIR_ENV}/${RUN_FILES.stdinPipe}"`,
    `: > "\$${RUN_DIR_ENV}/${RUN_FILES.output}"`,
    `: > "\$${RUN_DIR_ENV}/${RUN_FILES.stderr}"`,
    `printf '%s' "\${${RUN_STDIN_ENV}:-}" > "\$${RUN_DIR_ENV}/${RUN_FILES.stdin}"`,
    `mkfifo "\$${RUN_DIR_ENV}/${RUN_FILES.stdinPipe}"`,
    `setsid bash "\$${RUN_DIR_ENV}/${RUN_FILES.supervisor}" > /dev/null 2>&1 < /dev/null &`,
    `_optio_sup=$!`,
    `echo "$_optio_sup" > "\$${RUN_DIR_ENV}/${RUN_FILES.pid}"`,
    `echo "${RUN_STARTED_MARKER}:$_optio_sup"`,
  ];
}

/**
 * The attach script: the output file from byte `fromByte` on, following it
 * while the supervisor lives, then the exit marker on stderr (stdout stays
 * pure file bytes, so the consumer's offset accounting is exact).
 */
export function attachRunScript(runDir: string, fromByte: number): string {
  const d = shellQuote(assertRunDir(runDir));
  const from = Math.max(0, Math.floor(fromByte));
  return [
    `d=${d}`,
    `pid=$(cat "$d/${RUN_FILES.pid}" 2>/dev/null || true)`,
    `if [ -z "$pid" ] || [ ! -f "$d/${RUN_FILES.output}" ]; then echo "${RUN_LOST_MARKER}" >&2; exit 0; fi`,
    `if kill -0 "$pid" 2>/dev/null; then`,
    `  tail -c +${from + 1} --pid="$pid" -f "$d/${RUN_FILES.output}"`,
    `else`,
    `  tail -c +${from + 1} "$d/${RUN_FILES.output}"`,
    `fi`,
    `for i in $(seq 1 20); do [ -f "$d/${RUN_FILES.exit}" ] && break; sleep 0.5; done`,
    `if [ -f "$d/${RUN_FILES.exit}" ]; then echo "${RUN_EXIT_MARKER}:$(cat "$d/${RUN_FILES.exit}")" >&2; else echo "${RUN_LOST_MARKER}" >&2; fi`,
  ].join("\n");
}

/** The deliver script: one line appended to the run's stdin file. */
export function deliverStdinScript(runDir: string, line: string): string {
  const d = shellQuote(assertRunDir(runDir));
  if (line.includes("\n") || line.includes("\r")) {
    throw new Error("a stdin line must not contain a newline");
  }
  return [
    `export ${STDIN_LINE_ENV}=${shellQuote(line)}`,
    `printf '%s\\n' "\$${STDIN_LINE_ENV}" >> ${d}/${RUN_FILES.stdin}`,
  ].join("\n");
}

/** The kill script: the signal to the supervisor's process group. */
export function killRunScript(runDir: string, signal: RunSignal): string {
  const d = shellQuote(assertRunDir(runDir));
  if (!RUN_SIGNALS.includes(signal)) throw new Error(`Unsupported signal: ${signal}`);
  return [
    `pid=$(cat ${d}/${RUN_FILES.pid} 2>/dev/null || true)`,
    `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then`,
    `  kill -${signal} -- -"$pid" 2>/dev/null || kill -${signal} "$pid" 2>/dev/null || true`,
    `  echo killed`,
    `else`,
    `  echo none`,
    `fi`,
  ].join("\n");
}

/** Reads a whole stream as a string. */
function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    stream.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString();
    });
    stream.on("end", () => resolve(buf));
    stream.on("error", reject);
  });
}

/** Parses `__OPTIO_RUN_EXIT__:<code>` / `__OPTIO_RUN_LOST__` out of a line, or null. */
export function parseRunExitLine(line: string): RunExit | null {
  const trimmed = line.trim();
  if (trimmed === RUN_LOST_MARKER) return { kind: "lost" };
  if (trimmed.startsWith(`${RUN_EXIT_MARKER}:`)) {
    const code = Number.parseInt(trimmed.slice(RUN_EXIT_MARKER.length + 1), 10);
    return { kind: "exited", code: Number.isFinite(code) ? code : 1 };
  }
  return null;
}

/** Parses the started marker out of a start script's output, or null. */
export function parseRunStartedPid(output: string): number | null {
  const m = output.match(new RegExp(`${RUN_STARTED_MARKER}:(\\d+)`));
  return m ? Number.parseInt(m[1], 10) : null;
}

export class RunStartError extends Error {
  constructor(
    message: string,
    public readonly output: string,
  ) {
    super(message);
    this.name = "RunStartError";
  }
}

/** Thrown when a stdin line could not be delivered (the script failed). */
export class RunDeliverError extends Error {
  constructor(
    message: string,
    public readonly output: string,
  ) {
    super(message);
    this.name = "RunDeliverError";
  }
}

/**
 * The exec-based implementation of the protocol, shared by the runtimes
 * that run scripts in a container (Kubernetes, Docker).
 */
export const execRunProtocol = {
  async startRun(
    rt: Pick<ContainerRuntime, "exec">,
    handle: ContainerHandle,
    input: { script: string; initialStdin: string },
  ): Promise<RunStartResult> {
    const script = `export ${RUN_STDIN_ENV}=${shellQuote(input.initialStdin)}\n${input.script}`;
    const session = await rt.exec(handle, ["bash", "-c", script], { tty: false });
    const [stdout, stderr] = await Promise.all([collect(session.stdout), collect(session.stderr)]);
    const pid = parseRunStartedPid(stdout);
    if (pid === null) {
      const output = [stdout, stderr].filter(Boolean).join("\n");
      throw new RunStartError(
        `the run's start script ended without launching the agent:\n${output.trim().split("\n").slice(-20).join("\n")}`,
        output,
      );
    }
    return { pid, output: stdout.replace(new RegExp(`${RUN_STARTED_MARKER}:\\d+\\n?`), "") };
  },

  async attachRun(
    rt: Pick<ContainerRuntime, "exec">,
    handle: ContainerHandle,
    input: { runDir: string; fromByte: number },
  ): Promise<RunAttachment> {
    const session: ExecSession = await rt.exec(
      handle,
      ["bash", "-c", attachRunScript(input.runDir, input.fromByte)],
      { tty: false },
    );
    let detached = false;
    const exit = new Promise<RunExit>((resolve) => {
      let buf = "";
      let settled = false;
      const settle = (value: RunExit) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      session.stderr.on("data", (chunk: Buffer | string) => {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const parsed = parseRunExitLine(line);
          if (parsed) settle(parsed);
        }
      });
      session.stderr.on("end", () => {
        const parsed = parseRunExitLine(buf);
        if (parsed) settle(parsed);
        // A severed exec (the attach was closed, or the connection dropped)
        // ends the streams without a marker: that is "detached", not lost.
        settle({ kind: "detached", reason: detached ? "closed" : "stream-ended" });
      });
      session.stderr.on("error", () => settle({ kind: "detached", reason: "stream-ended" }));
    });
    return {
      output: session.stdout as Readable,
      exit,
      close() {
        detached = true;
        session.close();
      },
    };
  },

  async deliverStdin(
    rt: Pick<ContainerRuntime, "exec">,
    handle: ContainerHandle,
    input: { runDir: string; line: string },
  ): Promise<void> {
    const session = await rt.exec(
      handle,
      ["bash", "-c", `set -e\n${deliverStdinScript(input.runDir, input.line)}`],
      { tty: false },
    );
    const [stdout, stderr] = await Promise.all([collect(session.stdout), collect(session.stderr)]);
    if (stderr.trim()) {
      throw new RunDeliverError(`could not append to the run's stdin: ${stderr.trim()}`, stdout);
    }
  },

  async killRun(
    rt: Pick<ContainerRuntime, "exec">,
    handle: ContainerHandle,
    input: { runDir: string; signal: RunSignal },
  ): Promise<boolean> {
    const session = await rt.exec(
      handle,
      ["bash", "-c", killRunScript(input.runDir, input.signal)],
      { tty: false },
    );
    const stdout = await collect(session.stdout);
    return stdout.includes("killed");
  },
};
