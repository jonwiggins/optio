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
 *   pid             `<pid> <starttime>` of the supervisor (a process-group
 *                   leader, `setsid`), written by the supervisor itself once
 *                   its TERM trap is in place; starttime (field 22 of
 *                   /proc/<pid>/stat) tells a live supervisor from a reused
 *                   pid after a pod restart
 *   exit            the agent's exit code, written when it ends
 *
 * The four operations are short execs:
 *
 *   start    the caller's setup script, then `superviseAgent()`: prime stdin
 *            from the exec's own stdin, launch the supervisor, wait for its
 *            pid file, print `__OPTIO_RUN_STARTED__:<pid>`
 *   attach   `tail -c +<from+1> --pid=<pid> -f output.ndjson`, then
 *            `__OPTIO_RUN_EXIT__:<code>` (or `__OPTIO_RUN_LOST__`) on stderr
 *   deliver  `head -c <n> >> stdin.ndjson` from the exec's stdin, then
 *            `__OPTIO_STDIN_DELIVERED__` on stdout — or, once the file holds
 *            the EOF sentinel (the agent's stdin is closed), nothing
 *            appended and `__OPTIO_STDIN_CLOSED__`
 *   kill     signal the supervisor's process group (only a given pid's, when
 *            the caller names the attempt it means)
 *
 * Stdin bytes travel over the exec's stdin, never in the script or its
 * environment (an argv is at most 128 KiB). The pod's pid 1 must reap: the
 * supervisor is reparented to it when the start exec ends (`tini` in the
 * agent image, images/base.Dockerfile).
 *
 * The Kubernetes and Docker runtimes run these scripts through `exec`; the
 * fake runtime plays them with local processes and the same files.
 */
import { shellQuote } from "@optio/shared";
import type { ContainerHandle, ExecSession } from "@optio/shared";
import type { Readable } from "node:stream";
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
export const STDIN_DELIVERED_MARKER = "__OPTIO_STDIN_DELIVERED__";
/** What the deliver script prints instead when the run's stdin is already closed. */
export const STDIN_CLOSED_MARKER = "__OPTIO_STDIN_CLOSED__";
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

/** The env var the supervisor reads the run directory from. */
export const RUN_DIR_ENV = "OPTIO_RUN_DIR";
/** Set to `1` for the supervisor to mark the pod's environment warm on success. */
export const RUN_MARK_ENV_READY_ENV = "OPTIO_RUN_MARK_ENV_READY";
/** How many bytes of the exec's stdin the start script primes `stdin.ndjson` with. */
export const RUN_STDIN_BYTES_ENV = "OPTIO_RUN_STDIN_BYTES";
/** The exec's stdin, saved by the start prelude for the start script to read. */
const STDIN_FD = 3;
/** How long the start script waits for the supervisor's pid file (50 ms polls). */
const START_WAIT_POLLS = 200;
/** How long a fresh start waits for a stale supervisor after TERM, and again after KILL (50 ms polls). */
const STALE_STOP_POLLS = 100;
/** The files of a run directory that belong to one attempt (moved aside by the next). */
const ATTEMPT_FILES = [
  RUN_FILES.agent,
  RUN_FILES.supervisor,
  RUN_FILES.stdin,
  RUN_FILES.stdinPipe,
  RUN_FILES.output,
  RUN_FILES.stderr,
  RUN_FILES.pid,
  `${RUN_FILES.pid}.tmp`,
  RUN_FILES.exit,
] as const;

export const RUN_SIGNALS: readonly RunSignal[] = ["TERM", "KILL", "INT", "HUP"];

const SAFE_RUN_DIR = /^\/[A-Za-z0-9_./-]+$/;

function assertRunDir(runDir: string): string {
  if (!SAFE_RUN_DIR.test(runDir) || runDir.includes("..")) {
    throw new Error(`Invalid run directory: ${JSON.stringify(runDir)}`);
  }
  return runDir;
}

/** The byte offset an attach starts from, as a whole non-negative number. */
export function normalizeFromByte(fromByte: number): number {
  return Number.isFinite(fromByte) ? Math.max(0, Math.floor(fromByte)) : 0;
}

/** A process's start time: field 22 of /proc/<pid>/stat, read past the `(comm)` (which may hold spaces). */
const PROC_STARTTIME = (pid: string) =>
  `sed 's/.*) //' "/proc/${pid}/stat" 2>/dev/null | cut -d' ' -f20`;

/**
 * The shell helper every script that trusts a pid file shares:
 * `optio_run_pid <runDir>` prints the supervisor's pid when the process is
 * alive AND is the one that wrote the file (its start time matches); a dead,
 * absent, or reused pid prints nothing and fails. One helper for attach,
 * kill, and the pooled start guard. `optio_alive <pid>` says whether a
 * process is still there and not a zombie (a zombie answers `kill -0`).
 */
export const RUN_ALIVE_HELPER: readonly string[] = [
  `optio_run_pid() {`,
  `  [ -s "$1/${RUN_FILES.pid}" ] || return 1`,
  `  read -r _optio_pid _optio_start < "$1/${RUN_FILES.pid}" || return 1`,
  `  [ -n "$_optio_pid" ] && [ -n "$_optio_start" ] || return 1`,
  // Never 0 or 1: `kill -- -1` would signal every process in the pod.
  `  [ "$_optio_pid" -gt 1 ] 2>/dev/null || return 1`,
  `  kill -0 "$_optio_pid" 2>/dev/null || return 1`,
  `  [ "$(${PROC_STARTTIME("$_optio_pid")})" = "$_optio_start" ] || return 1`,
  `  printf '%s' "$_optio_pid"`,
  `}`,
  `optio_alive() {`,
  `  kill -0 "$1" 2>/dev/null || return 1`,
  `  [ "$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f1)" != "Z" ]`,
  `}`,
];

/**
 * The supervisor, as a file: launches the agent with its stdin fed from
 * `stdin.ndjson` through a FIFO, writes its pid file once the TERM trap and
 * the agent are in place (so a signal can never arrive before the trap),
 * waits for the agent, and records its exit. Written by the start script
 * with a quoted heredoc, so nothing in it expands at write time.
 */
export const SUPERVISOR_SCRIPT: string = [
  `#!/bin/bash`,
  `d="\$${RUN_DIR_ENV}"`,
  `on_term() { kill -TERM "$agent" 2>/dev/null; wait "$agent" 2>/dev/null; echo 143 > "$d/${RUN_FILES.exit}"; exit 143; }`,
  `trap on_term TERM INT HUP`,
  `bash "$d/${RUN_FILES.agent}" < "$d/${RUN_FILES.stdinPipe}" >> "$d/${RUN_FILES.output}" 2>> "$d/${RUN_FILES.stderr}" &`,
  `agent=$!`,
  // The feeder: every line of stdin.ndjson, as it arrives, until the EOF
  // sentinel. Only the loop holds the FIFO, so `break` closes the agent's
  // stdin at once, whatever the tail is still doing; `--pid` ends the tail
  // when the agent is gone.
  `tail -n +1 --pid="$agent" -f "$d/${RUN_FILES.stdin}" | ( while IFS= read -r l; do if [ "$l" = "${STDIN_EOF_SENTINEL}" ]; then break; fi; printf '%s\\n' "$l"; done > "$d/${RUN_FILES.stdinPipe}" ) &`,
  `printf '%s %s\\n' "$$" "$(${PROC_STARTTIME("$$")})" > "$d/${RUN_FILES.pid}.tmp" && mv "$d/${RUN_FILES.pid}.tmp" "$d/${RUN_FILES.pid}"`,
  `wait "$agent"`,
  `code=$?`,
  `echo "$code" > "$d/${RUN_FILES.exit}"`,
  `if [ "$code" -eq 0 ] && [ "\${${RUN_MARK_ENV_READY_ENV}:-}" = "1" ]; then touch /home/agent/.optio-env-ready; fi`,
  ``,
].join("\n");

/**
 * The lines a runtime puts before a start script: the exec's stdin saved on
 * fd 3 for `superviseAgent()` to prime the run's stdin from (fd 0 then
 * points at /dev/null, so nothing in the setup can eat those bytes), and
 * how many bytes to take.
 */
export function startRunPrelude(stdinBytes: number): string[] {
  if (!Number.isInteger(stdinBytes) || stdinBytes < 0) throw new Error("stdinBytes must be ≥ 0");
  return [`exec ${STDIN_FD}<&0 0</dev/null`, `export ${RUN_STDIN_BYTES_ENV}=${stdinBytes}`];
}

/**
 * Script lines that stop a previous attempt's supervisor still alive in the
 * run directory `D` (its starter went away before recording it): TERM to
 * its process group, up to 5 s for it to go, then KILL and up to 5 s more.
 * One that survives even that fails the start with nothing touched — one
 * run directory, one agent. Needs RUN_ALIVE_HELPER.
 */
function stopStaleSupervisor(D: string): string[] {
  const wait = `for i in $(seq 1 ${STALE_STOP_POLLS}); do optio_alive "$_optio_prev" || break; sleep 0.05; done`;
  return [
    `if _optio_prev=$(optio_run_pid ${D}); then`,
    `  kill -TERM -- -"$_optio_prev" 2>/dev/null || kill -TERM "$_optio_prev" 2>/dev/null || true`,
    `  ${wait}`,
    `  if optio_alive "$_optio_prev"; then`,
    `    kill -KILL -- -"$_optio_prev" 2>/dev/null || kill -KILL "$_optio_prev" 2>/dev/null || true`,
    `    ${wait}`,
    `  fi`,
    `  if optio_alive "$_optio_prev"; then echo "[optio] ERROR: a previous attempt's supervisor (pid $_optio_prev) is still running in the run directory and would not stop" >&2; exit 1; fi`,
    `fi`,
  ];
}

/**
 * Script lines that end a start script: stop a previous attempt's
 * supervisor still running in `runDir`, move that attempt's files aside
 * (never truncated in place: a straggler still writing through an open
 * descriptor writes to the old file, not to this attempt's), write the
 * agent command and the supervisor, prime stdin from the exec's stdin
 * (`startRunPrelude`), launch the supervisor in its own session (so the exec
 * that started it can go away and so `killRun` can signal the whole tree),
 * wait for its pid file, and print the started marker. `agentLines` run in
 * the current directory with the current environment.
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
  const D = `"\$${RUN_DIR_ENV}"`;
  return [
    `export ${RUN_DIR_ENV}=${d}`,
    ...(opts.markEnvReady ? [`export ${RUN_MARK_ENV_READY_ENV}=1`] : []),
    `mkdir -p ${D}`,
    ...RUN_ALIVE_HELPER,
    ...stopStaleSupervisor(D),
    // The previous attempt's files go to a sibling directory, removed in the
    // background (holding none of the start exec's descriptors: its stdin on
    // fd 3, the callers' locks on 7 and 9).
    `_optio_old=""`,
    `for _optio_f in ${ATTEMPT_FILES.join(" ")}; do`,
    `  if [ -e ${D}/"$_optio_f" ]; then`,
    `    if [ -z "$_optio_old" ]; then _optio_old=${D}.prev-$(date +%s)-$$; mkdir -p "$_optio_old"; fi`,
    `    mv -f ${D}/"$_optio_f" "$_optio_old"/`,
    `  fi`,
    `done`,
    `if [ -n "$_optio_old" ]; then ( rm -rf "$_optio_old" ) < /dev/null > /dev/null 2>&1 3<&- 7>&- 9>&- & fi`,
    `cat > ${D}/${RUN_FILES.agent} <<'__OPTIO_AGENT_SH__'`,
    agentScript,
    `__OPTIO_AGENT_SH__`,
    `cat > ${D}/${RUN_FILES.supervisor} <<'__OPTIO_SUPERVISOR_SH__'`,
    SUPERVISOR_SCRIPT.trimEnd(),
    `__OPTIO_SUPERVISOR_SH__`,
    `: > ${D}/${RUN_FILES.output}`,
    `: > ${D}/${RUN_FILES.stderr}`,
    `if [ -n "\${${RUN_STDIN_BYTES_ENV}:-}" ]; then head -c "\$${RUN_STDIN_BYTES_ENV}" <&${STDIN_FD} > ${D}/${RUN_FILES.stdin}; exec ${STDIN_FD}<&-; else : > ${D}/${RUN_FILES.stdin}; fi`,
    `mkfifo ${D}/${RUN_FILES.stdinPipe}`,
    `setsid bash ${D}/${RUN_FILES.supervisor} > /dev/null 2>&1 < /dev/null &`,
    `for i in $(seq 1 ${START_WAIT_POLLS}); do [ -s ${D}/${RUN_FILES.pid} ] && break; sleep 0.05; done`,
    `[ -s ${D}/${RUN_FILES.pid} ] || { echo "[optio] ERROR: the run supervisor did not start" >&2; exit 1; }`,
    `read -r _optio_sup _optio_start < ${D}/${RUN_FILES.pid}`,
    `echo "${RUN_STARTED_MARKER}:$_optio_sup"`,
  ];
}

/**
 * The attach script: the output file from byte `fromByte` on, following it
 * while the supervisor lives, then the exit marker on stderr (stdout stays
 * pure file bytes, so the consumer's offset accounting is exact). A pid file
 * whose process is gone, or belongs to another process now (a pod restart
 * reused the pid), counts as not running.
 */
export function attachRunScript(runDir: string, fromByte: number): string {
  const d = shellQuote(assertRunDir(runDir));
  const from = normalizeFromByte(fromByte);
  return [
    `d=${d}`,
    ...RUN_ALIVE_HELPER,
    `if [ ! -f "$d/${RUN_FILES.output}" ]; then echo "${RUN_LOST_MARKER}" >&2; exit 0; fi`,
    `if pid=$(optio_run_pid "$d"); then`,
    `  tail -c +${from + 1} --pid="$pid" -f "$d/${RUN_FILES.output}"`,
    `else`,
    `  tail -c +${from + 1} "$d/${RUN_FILES.output}"`,
    `fi`,
    `for i in $(seq 1 20); do [ -f "$d/${RUN_FILES.exit}" ] && break; sleep 0.5; done`,
    `if [ -f "$d/${RUN_FILES.exit}" ]; then echo "${RUN_EXIT_MARKER}:$(cat "$d/${RUN_FILES.exit}")" >&2; else echo "${RUN_LOST_MARKER}" >&2; fi`,
  ].join("\n");
}

/**
 * The deliver script: `byteLength` bytes of the exec's stdin appended to the
 * run's stdin file, then the delivered marker on stdout. The bytes never
 * touch the script or its environment. Once the file holds the EOF sentinel
 * the agent's stdin is closed (the feeder stopped there): nothing is
 * appended and the closed marker is printed instead. The check and the
 * append hold the run's stdin lock, so a line and the sentinel never race.
 */
export function deliverStdinScript(runDir: string, byteLength: number): string {
  const d = shellQuote(assertRunDir(runDir));
  if (!Number.isInteger(byteLength) || byteLength < 1) throw new Error("byteLength must be ≥ 1");
  return [
    `d=${d}`,
    `[ -d "$d" ] || { echo "no run directory at $d" >&2; exit 1; }`,
    `exec 8>>"$d/${RUN_FILES.stdin}.lock"`,
    `if command -v flock >/dev/null 2>&1; then flock -x 8; fi`,
    `if grep -qxF '${STDIN_EOF_SENTINEL}' "$d/${RUN_FILES.stdin}" 2>/dev/null; then echo "${STDIN_CLOSED_MARKER}"; exit 0; fi`,
    `head -c ${byteLength} >> "$d/${RUN_FILES.stdin}" && echo "${STDIN_DELIVERED_MARKER}"`,
  ].join("\n");
}

/**
 * The kill script: the signal to the supervisor's process group, when it is
 * the live supervisor — and, with `pid`, only when it is that pid's (the
 * attempt the caller means: a newer attempt in the same directory is never
 * hit).
 */
export function killRunScript(runDir: string, signal: RunSignal, pid?: number): string {
  const d = shellQuote(assertRunDir(runDir));
  if (!RUN_SIGNALS.includes(signal)) throw new Error(`Unsupported signal: ${signal}`);
  if (pid !== undefined && (!Number.isInteger(pid) || pid < 2)) {
    throw new Error(`Invalid pid: ${pid}`);
  }
  return [
    `d=${d}`,
    ...RUN_ALIVE_HELPER,
    pid === undefined
      ? `if pid=$(optio_run_pid "$d"); then`
      : `if pid=$(optio_run_pid "$d") && [ "$pid" = "${pid}" ]; then`,
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

/** Writes `bytes` to the exec's stdin and closes it. */
function feedStdin(session: ExecSession, bytes: Buffer): void {
  try {
    if (bytes.length > 0) session.stdin.write(bytes);
    session.stdin.end();
  } catch {
    // The exec may have ended already; its output says what happened.
  }
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

/**
 * Thrown when a stdin line was refused because the run's stdin is already
 * closed (the EOF sentinel was delivered: the agent finished its turn).
 */
export class RunStdinClosedError extends Error {
  constructor(runDir: string) {
    super(`the run's stdin is closed (${runDir})`);
    this.name = "RunStdinClosedError";
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
    const stdin = Buffer.from(input.initialStdin, "utf8");
    const script = [...startRunPrelude(stdin.length), input.script].join("\n");
    const session = await rt.exec(handle, ["bash", "-c", script], { tty: false });
    const collected = Promise.all([collect(session.stdout), collect(session.stderr)]);
    feedStdin(session, stdin);
    const [stdout, stderr] = await collected;
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
    // The marker, from stderr; or "detached" when stderr ends without one.
    const marker = new Promise<RunExit>((resolve) => {
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
    // The output must be fully delivered before the exit is reported, so a
    // consumer that awaits `exit` has seen every byte. A consumer that
    // closes the attachment abandons the output: that settles at once.
    let outputDone: () => void = () => {};
    const outputEnded = new Promise<void>((resolve) => {
      outputDone = resolve;
      // "end" needs a reader; "finish" is the writer's end (the exec closed
      // its stream), which is what "every byte is in" means here.
      session.stdout.on("end", () => resolve());
      (session.stdout as Readable & { on(ev: "finish", fn: () => void): unknown }).on(
        "finish",
        () => resolve(),
      );
      session.stdout.on("close", () => resolve());
      session.stdout.on("error", () => resolve());
    });
    const exit = Promise.all([marker, outputEnded]).then(([value]) => value);
    return {
      output: session.stdout as Readable,
      exit,
      close() {
        detached = true;
        session.close();
        outputDone();
      },
    };
  },

  async deliverStdin(
    rt: Pick<ContainerRuntime, "exec">,
    handle: ContainerHandle,
    input: { runDir: string; line: string },
  ): Promise<void> {
    if (input.line.includes("\n") || input.line.includes("\r")) {
      throw new Error("a stdin line must not contain a newline");
    }
    const bytes = Buffer.from(`${input.line}\n`, "utf8");
    const session = await rt.exec(
      handle,
      ["bash", "-c", deliverStdinScript(input.runDir, bytes.length)],
      { tty: false },
    );
    const collected = Promise.all([collect(session.stdout), collect(session.stderr)]);
    feedStdin(session, bytes);
    const [stdout, stderr] = await collected;
    if (stdout.includes(STDIN_CLOSED_MARKER)) throw new RunStdinClosedError(input.runDir);
    if (!stdout.includes(STDIN_DELIVERED_MARKER)) {
      const output = [stdout, stderr].filter(Boolean).join("\n");
      throw new RunDeliverError(
        `could not append to the run's stdin: ${output.trim().split("\n").slice(-5).join(" | ") || "no output"}`,
        output,
      );
    }
  },

  async killRun(
    rt: Pick<ContainerRuntime, "exec">,
    handle: ContainerHandle,
    input: { runDir: string; signal: RunSignal; pid?: number },
  ): Promise<boolean> {
    const session = await rt.exec(
      handle,
      ["bash", "-c", killRunScript(input.runDir, input.signal, input.pid)],
      { tty: false },
    );
    const stdout = await collect(session.stdout);
    return stdout.includes("killed");
  },
};
