import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import type { ContainerHandle, ExecSession } from "@optio/shared";
import {
  RUN_ALIVE_HELPER,
  RUN_EXIT_MARKER,
  RUN_FILES,
  RUN_LOST_MARKER,
  RUN_STARTED_MARKER,
  RUN_STDIN_BYTES_ENV,
  RunDeliverError,
  RunStartError,
  RunStdinClosedError,
  STDIN_CLOSED_MARKER,
  STDIN_DELIVERED_MARKER,
  STDIN_EOF_SENTINEL,
  SUPERVISOR_SCRIPT,
  attachRunScript,
  deliverStdinScript,
  execRunProtocol,
  killRunScript,
  normalizeFromByte,
  parseRunExitLine,
  parseRunStartedPid,
  startRunBootstrap,
  startRunPayload,
  startRunPrelude,
  superviseAgent,
} from "./run-protocol.js";

const RUN_DIR = "/home/agent/optio/runs/0f2e1c1a-1111-4222-8333-444444444444";
const HANDLE: ContainerHandle = { id: "pod-1", name: "pod-1" };
/** The real-shell tests need a `head -c` that reads exactly its count from a pipe (GNU, as in the agent image). */
const GNU_HEAD = (() => {
  try {
    return execFileSync("head", ["--version"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .includes("GNU");
  } catch {
    return false;
  }
})();
const STARTTIME = `sed 's/.*) //' "/proc/$_optio_pid/stat" 2>/dev/null | cut -d' ' -f20`;

describe("the pid helper", () => {
  const helper = RUN_ALIVE_HELPER.join("\n");

  it("trusts a pid only when the live process's start time matches the file's", () => {
    expect(helper).toContain(`read -r _optio_pid _optio_start < "$1/${RUN_FILES.pid}" || return 1`);
    expect(helper).toContain('[ -n "$_optio_pid" ] && [ -n "$_optio_start" ] || return 1');
    expect(helper).toContain('kill -0 "$_optio_pid" 2>/dev/null || return 1');
    // Never pid 0 or 1: `kill -- -1` would signal the whole pod.
    expect(helper).toContain('[ "$_optio_pid" -gt 1 ] 2>/dev/null || return 1');
    expect(helper).toContain(`[ "$(${STARTTIME})" = "$_optio_start" ] || return 1`);
    expect(helper).toContain(`printf '%s' "$_optio_pid"`);
  });

  it("reads the start time past the (comm), which may hold spaces", () => {
    // field 22 of /proc/<pid>/stat is field 20 once `pid (comm) ` is gone
    expect(STARTTIME).toContain("sed 's/.*) //'");
    expect(STARTTIME).toContain("cut -d' ' -f20");
  });
});

describe("startRunPrelude", () => {
  it("saves the exec's stdin on fd 3, points fd 0 at /dev/null, and says how many bytes to take", () => {
    expect(startRunPrelude(300_000)).toEqual([
      "exec 3<&0 0</dev/null",
      "export OPTIO_RUN_STDIN_BYTES=300000",
    ]);
    expect(() => startRunPrelude(-1)).toThrow();
    expect(() => startRunPrelude(1.5)).toThrow();
  });
});

describe("superviseAgent", () => {
  const lines = superviseAgent(RUN_DIR, [
    "export FOO='bar'",
    "claude -p --output-format stream-json",
  ]);
  const script = lines.join("\n");

  it("exports the run directory and writes the agent command verbatim in a quoted heredoc", () => {
    expect(lines[0]).toBe(`export OPTIO_RUN_DIR='${RUN_DIR}'`);
    expect(script).toContain(`cat > "$OPTIO_RUN_DIR"/${RUN_FILES.agent} <<'__OPTIO_AGENT_SH__'`);
    expect(script).toContain(
      "export FOO='bar'\nclaude -p --output-format stream-json\n__OPTIO_AGENT_SH__",
    );
  });

  it("writes the supervisor as a file and launches it in its own session", () => {
    expect(script).toContain(
      `cat > "$OPTIO_RUN_DIR"/${RUN_FILES.supervisor} <<'__OPTIO_SUPERVISOR_SH__'`,
    );
    expect(script).toContain(SUPERVISOR_SCRIPT.trimEnd());
    expect(script).toContain(
      `setsid bash "$OPTIO_RUN_DIR"/${RUN_FILES.supervisor} > /dev/null 2>&1 < /dev/null &`,
    );
  });

  it("waits for the supervisor's own pid file before reporting the run started", () => {
    expect(script).toContain(
      `for i in $(seq 1 200); do [ -s "$OPTIO_RUN_DIR"/${RUN_FILES.pid} ] && break; sleep 0.05; done`,
    );
    expect(script).toContain(
      `[ -s "$OPTIO_RUN_DIR"/${RUN_FILES.pid} ] || { echo "[optio] ERROR: the run supervisor did not start" >&2; exit 1; }`,
    );
    expect(script).toContain(`read -r _optio_sup _optio_start < "$OPTIO_RUN_DIR"/${RUN_FILES.pid}`);
    expect(lines.at(-1)).toBe(`echo "${RUN_STARTED_MARKER}:$_optio_sup"`);
    // The start script itself never writes the pid file.
    expect(script).not.toContain(`> "$OPTIO_RUN_DIR"/${RUN_FILES.pid}`);
  });

  it("primes stdin from the exec's stdin (fd 3), never from the script or env", () => {
    expect(script).toContain(
      `if [ -n "\${OPTIO_RUN_STDIN_BYTES:-}" ]; then head -c "$OPTIO_RUN_STDIN_BYTES" <&3 > "$OPTIO_RUN_DIR"/${RUN_FILES.stdin}; exec 3<&-; else : > "$OPTIO_RUN_DIR"/${RUN_FILES.stdin}; fi`,
    );
    expect(script).not.toContain("OPTIO_RUN_STDIN=");
  });

  it("stops a stale supervisor first: TERM, up to 5 s, KILL, up to 5 s, else fails with nothing touched", () => {
    const stop = script.indexOf(`if _optio_prev=$(optio_run_pid "$OPTIO_RUN_DIR"); then`);
    expect(stop).toBeGreaterThan(0);
    const term = script.indexOf(`kill -TERM -- -"$_optio_prev"`, stop);
    const kill = script.indexOf(`kill -KILL -- -"$_optio_prev"`, stop);
    const fail = script.indexOf("would not stop", stop);
    expect(term).toBeGreaterThan(stop);
    expect(kill).toBeGreaterThan(term);
    expect(fail).toBeGreaterThan(kill);
    expect(script.slice(fail, script.indexOf("\n", fail))).toContain("exit 1");
    expect(
      script.match(
        /for i in \$\(seq 1 100\); do optio_alive "\$_optio_prev" \|\| break; sleep 0.05; done/g,
      ),
    ).toHaveLength(2);
    // A zombie answers `kill -0`; it is not alive.
    expect(RUN_ALIVE_HELPER.join("\n")).toContain(`cut -d' ' -f1)" != "Z" ]`);
    // Nothing of the run directory is written before the stale supervisor is gone.
    for (const file of [RUN_FILES.agent, RUN_FILES.supervisor, RUN_FILES.output, RUN_FILES.stdin]) {
      expect(script.indexOf(`> "$OPTIO_RUN_DIR"/${file}`)).toBeGreaterThan(fail);
    }
  });

  it("moves the previous attempt's files aside, never truncating them in place, and starts fresh ones", () => {
    const move = script.indexOf(`mv -f "$OPTIO_RUN_DIR"/"$_optio_f" "$_optio_old"/`);
    expect(move).toBeGreaterThan(0);
    expect(script).toContain(`_optio_old="$OPTIO_RUN_DIR".prev-$(date +%s)-$$`);
    for (const file of [
      RUN_FILES.output,
      RUN_FILES.stderr,
      RUN_FILES.stdin,
      RUN_FILES.pid,
      RUN_FILES.exit,
      RUN_FILES.stdinPipe,
    ]) {
      expect(script).toMatch(new RegExp(`for _optio_f in [^;]*\\b${file.replace(".", "\\.")}\\b`));
    }
    // Removed in the background, holding none of the start exec's descriptors.
    expect(script).toContain(
      `if [ -n "$_optio_old" ]; then ( rm -rf "$_optio_old" ) < /dev/null > /dev/null 2>&1 3<&- 7>&- 9>&- & fi`,
    );
    expect(script.indexOf(`: > "$OPTIO_RUN_DIR"/${RUN_FILES.output}`)).toBeGreaterThan(move);
    expect(script).not.toContain(`rm -f "$OPTIO_RUN_DIR"/${RUN_FILES.exit}`);
    expect(script).toContain(`mkfifo "$OPTIO_RUN_DIR"/${RUN_FILES.stdinPipe}`);
  });

  it("never kills children or removes the run directory on exit, and has no EPIPE watchdog", () => {
    // The only trap is the supervisor's own TERM handler, inside its heredoc.
    const outsideHeredocs = script.replace(/<<'(__OPTIO_\w+__)'\n[\s\S]*?\n\1/g, "");
    expect(outsideHeredocs).not.toContain("trap");
    expect(script).not.toContain(" EXIT");
    // The only removal is the previous attempt's moved-aside files.
    expect(script.match(/rm -rf/g)).toEqual(["rm -rf"]);
    expect(script).not.toContain('rm -rf "$OPTIO_RUN_DIR"');
    expect(script).not.toContain("kill -TERM $_optio_main_pid");
    expect(script).not.toContain("printf '\\n'");
  });

  it("marks the environment warm only when asked", () => {
    expect(script).not.toContain("OPTIO_RUN_MARK_ENV_READY=1");
    expect(superviseAgent(RUN_DIR, ["true"], { markEnvReady: true }).join("\n")).toContain(
      "export OPTIO_RUN_MARK_ENV_READY=1",
    );
  });

  it("rejects a run directory outside the safe shape and an agent command holding the heredoc delimiter", () => {
    expect(() => superviseAgent("/home/agent/../etc", ["true"])).toThrow(/Invalid run directory/);
    expect(() => superviseAgent("relative/dir", ["true"])).toThrow(/Invalid run directory/);
    expect(() => superviseAgent(RUN_DIR, ["echo __OPTIO_AGENT_SH__"])).toThrow(/heredoc/);
  });
});

describe("the supervisor", () => {
  it("installs its TERM trap and launches the agent before writing its pid file", () => {
    const trapAt = SUPERVISOR_SCRIPT.indexOf("trap on_term TERM INT HUP");
    const agentAt = SUPERVISOR_SCRIPT.indexOf(`bash "$d/${RUN_FILES.agent}"`);
    const pidAt = SUPERVISOR_SCRIPT.indexOf(`> "$d/${RUN_FILES.pid}.tmp"`);
    expect(trapAt).toBeGreaterThan(0);
    expect(agentAt).toBeGreaterThan(trapAt);
    expect(pidAt).toBeGreaterThan(agentAt);
    expect(SUPERVISOR_SCRIPT).toContain(
      `printf '%s %s\\n' "$$" "$(sed 's/.*) //' "/proc/$$/stat" 2>/dev/null | cut -d' ' -f20)" > "$d/${RUN_FILES.pid}.tmp" && mv "$d/${RUN_FILES.pid}.tmp" "$d/${RUN_FILES.pid}"`,
    );
  });

  it("feeds stdin through a FIFO that only the loop holds, so the sentinel closes it at once", () => {
    expect(SUPERVISOR_SCRIPT).toContain(
      `bash "$d/${RUN_FILES.agent}" < "$d/${RUN_FILES.stdinPipe}" >> "$d/${RUN_FILES.output}" 2>> "$d/${RUN_FILES.stderr}" &`,
    );
    expect(SUPERVISOR_SCRIPT).toContain(
      `tail -n +1 --pid="$agent" -f "$d/${RUN_FILES.stdin}" | ( while IFS= read -r l; do if [ "$l" = "${STDIN_EOF_SENTINEL}" ]; then break; fi; printf '%s\\n' "$l"; done > "$d/${RUN_FILES.stdinPipe}" ) &`,
    );
    expect(SUPERVISOR_SCRIPT).toContain(`wait "$agent"`);
    expect(SUPERVISOR_SCRIPT).toContain(`echo "$code" > "$d/${RUN_FILES.exit}"`);
  });

  it("records 143 when terminated, after passing the signal to the agent", () => {
    expect(SUPERVISOR_SCRIPT).toContain(
      `on_term() { kill -TERM "$agent" 2>/dev/null; wait "$agent" 2>/dev/null; echo 143 > "$d/${RUN_FILES.exit}"; exit 143; }`,
    );
  });
});

describe("attachRunScript", () => {
  it("tails the output file from the byte after the offset while the live supervisor runs", () => {
    const s = attachRunScript(RUN_DIR, 1234);
    expect(s).toContain(`d='${RUN_DIR}'`);
    expect(s).toContain(RUN_ALIVE_HELPER.join("\n"));
    expect(s).toContain(`if pid=$(optio_run_pid "$d"); then`);
    expect(s).toContain(`tail -c +1235 --pid="$pid" -f "$d/${RUN_FILES.output}"`);
    expect(s).toContain(`tail -c +1235 "$d/${RUN_FILES.output}"`);
  });

  it("reports the exit code, or a lost run, on stderr only", () => {
    const s = attachRunScript(RUN_DIR, 0);
    expect(s).toContain("tail -c +1 ");
    expect(s).toContain(`echo "${RUN_EXIT_MARKER}:$(cat "$d/${RUN_FILES.exit}")" >&2`);
    expect(s).toContain(`echo "${RUN_LOST_MARKER}" >&2`);
    expect(s.match(new RegExp(RUN_LOST_MARKER, "g"))).toHaveLength(2);
  });

  it("normalizes the offset", () => {
    expect(normalizeFromByte(-5)).toBe(0);
    expect(normalizeFromByte(7.9)).toBe(7);
    expect(normalizeFromByte(Number.NaN)).toBe(0);
    expect(normalizeFromByte(Number.POSITIVE_INFINITY)).toBe(0);
    expect(attachRunScript(RUN_DIR, Number.NaN)).toContain("tail -c +1 ");
  });
});

describe("deliverStdinScript", () => {
  it("appends exactly the given bytes from the exec's stdin and prints the delivered marker", () => {
    const s = deliverStdinScript(RUN_DIR, 42);
    expect(s).toContain(`d='${RUN_DIR}'`);
    expect(s).toContain(`[ -d "$d" ] || { echo "no run directory at $d" >&2; exit 1; }`);
    expect(s).toContain(
      `head -c 42 >> "$d/${RUN_FILES.stdin}" && echo "${STDIN_DELIVERED_MARKER}"`,
    );
    expect(s).not.toContain("OPTIO_STDIN_LINE");
  });

  it("refuses once the run's stdin holds the EOF sentinel, under the stdin lock", () => {
    const s = deliverStdinScript(RUN_DIR, 42);
    const lock = s.indexOf("flock -x 8");
    const check = s.indexOf(`grep -qxF '${STDIN_EOF_SENTINEL}' "$d/${RUN_FILES.stdin}"`);
    const append = s.indexOf("head -c 42");
    expect(lock).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(lock);
    expect(append).toBeGreaterThan(check);
    expect(s).toContain(`then echo "${STDIN_CLOSED_MARKER}"; exit 0; fi`);
  });

  it("refuses a byte count below one", () => {
    expect(() => deliverStdinScript(RUN_DIR, 0)).toThrow(/byteLength/);
    expect(() => deliverStdinScript(RUN_DIR, 2.5)).toThrow(/byteLength/);
  });
});

describe("killRunScript", () => {
  it("signals the live supervisor's process group, falling back to the pid", () => {
    const s = killRunScript(RUN_DIR, "TERM");
    expect(s).toContain(RUN_ALIVE_HELPER.join("\n"));
    expect(s).toContain(`if pid=$(optio_run_pid "$d"); then`);
    expect(s).toContain(
      `kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true`,
    );
    expect(s).toContain("echo killed");
    expect(s).toContain("echo none");
  });

  it("only knows the four signals", () => {
    expect(() => killRunScript(RUN_DIR, "USR1" as never)).toThrow(/Unsupported signal/);
  });

  it("with a pid, signals only that attempt's supervisor", () => {
    const s = killRunScript(RUN_DIR, "TERM", 4242);
    expect(s).toContain(`if pid=$(optio_run_pid "$d") && [ "$pid" = "4242" ]; then`);
    expect(() => killRunScript(RUN_DIR, "TERM", 1)).toThrow(/Invalid pid/);
    expect(() => killRunScript(RUN_DIR, "TERM", 2.5)).toThrow(/Invalid pid/);
  });
});

describe("markers", () => {
  it("parses exit and lost lines", () => {
    expect(parseRunExitLine(`${RUN_EXIT_MARKER}:0`)).toEqual({ kind: "exited", code: 0 });
    expect(parseRunExitLine(`  ${RUN_EXIT_MARKER}:143 \n`)).toEqual({ kind: "exited", code: 143 });
    expect(parseRunExitLine(`${RUN_EXIT_MARKER}:x`)).toEqual({ kind: "exited", code: 1 });
    expect(parseRunExitLine(RUN_LOST_MARKER)).toEqual({ kind: "lost" });
    expect(parseRunExitLine("tail: warning")).toBeNull();
  });

  it("parses the started pid", () => {
    expect(parseRunStartedPid(`[optio] Repo ready\n${RUN_STARTED_MARKER}:4242\n`)).toBe(4242);
    expect(parseRunStartedPid("[optio] ERROR: repo not ready")).toBeNull();
  });
});

type StubSession = ExecSession & {
  stdoutW: PassThrough;
  stderrW: PassThrough;
  stdinData: Buffer[];
};

/** A stub exec: records the command and what was written to stdin, plays scripted output. */
function stubExec(play: (cmd: string[], session: StubSession) => void) {
  const calls: string[][] = [];
  const sessions: StubSession[] = [];
  const rt = {
    async exec(_h: ContainerHandle, command: string[]): Promise<ExecSession> {
      calls.push(command);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdinData: Buffer[] = [];
      let stdinEnded = false;
      const stdin = new Writable({
        write: (c: Buffer, _e, cb) => {
          stdinData.push(Buffer.from(c));
          cb();
        },
        final: (cb) => {
          stdinEnded = true;
          cb();
        },
      });
      let closed = false;
      const session: StubSession = {
        stdin,
        stdout,
        stderr,
        stdoutW: stdout,
        stderrW: stderr,
        stdinData,
        resize: () => {},
        close: () => {
          if (closed) return;
          closed = true;
          stdout.end();
          stderr.end();
        },
      };
      Object.defineProperty(session, "stdinEnded", { get: () => stdinEnded });
      sessions.push(session);
      setImmediate(() => play(command, session));
      return session;
    },
  };
  return { rt, calls, sessions };
}

describe("execRunProtocol", () => {
  it("startRun sends the script and the initial stdin over the exec's stdin, never in the argv, and parses the pid", async () => {
    const { rt, calls, sessions } = stubExec((_cmd, s) => {
      // The script reads stdin before printing: play after a tick.
      setTimeout(() => {
        s.stdoutW.end(`[optio] Repo ready\n${RUN_STARTED_MARKER}:777\n`);
        s.stderrW.end();
      }, 10);
    });
    const initialStdin = `{"type":"user","text":"héllo"}\n`; // 2 bytes for é
    // Far past the 128 KiB one argument may be (setup files and the prompt travel in the script).
    const script = `set -e\necho hï\n${"# padding\n".repeat(40_000)}echo done`;
    const result = await execRunProtocol.startRun(rt, HANDLE, { script, initialStdin });
    expect(result).toEqual({ pid: 777, output: "[optio] Repo ready\n" });
    const bytes = Buffer.byteLength(initialStdin, "utf8");
    expect(bytes).toBe(initialStdin.length + 1);
    const payload = startRunPayload(script, bytes);
    expect(payload).toContain(`${startRunPrelude(bytes).join("\n")}\n${script}\n`);
    expect(calls[0]).toEqual(["bash", "-c", startRunBootstrap(Buffer.byteLength(payload, "utf8"))]);
    expect(calls[0][2].length).toBeLessThan(1024);
    expect(calls[0][2]).not.toContain("padding");
    expect(calls[0][2]).not.toContain("héllo");
    expect(Buffer.concat(sessions[0].stdinData).toString("utf8")).toBe(payload + initialStdin);
    expect((sessions[0] as unknown as { stdinEnded: boolean }).stdinEnded).toBe(true);
  });

  it.skipIf(!GNU_HEAD)(
    "startRun runs a start script larger than one argument may be, and hands it its stdin",
    async () => {
      const rt = {
        async exec(_h: ContainerHandle, command: string[]): Promise<ExecSession> {
          // E2BIG ("argument list too long") rejects here, as it does in a pod.
          const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
          await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
          });
          return {
            stdin: child.stdin,
            stdout: child.stdout,
            stderr: child.stderr,
            resize: () => {},
            close: () => void child.kill(),
          };
        },
      };
      const initialStdin = `{"type":"user","text":"héllo"}\n`;
      const script = [
        `cat > /dev/null <<'__SETUP_FILE__'`,
        "x".repeat(99).concat("\n").repeat(3_000).trimEnd(), // 300 KiB of setup file
        `__SETUP_FILE__`,
        `[ -z "\${_optio_start_script+set}" ] || echo "the script is still in a variable"`,
        `printf 'stdin=%s\n' "$(head -c "$${RUN_STDIN_BYTES_ENV}" <&3)"`,
        `echo "${RUN_STARTED_MARKER}:4242"`,
      ].join("\n");
      expect(Buffer.byteLength(script)).toBeGreaterThan(256 * 1024);
      const result = await execRunProtocol.startRun(rt, HANDLE, { script, initialStdin });
      expect(result).toEqual({ pid: 4242, output: `stdin=${initialStdin}` });
    },
  );

  it.skipIf(!GNU_HEAD)(
    "startRun runs nothing of a start script that arrived incomplete",
    async () => {
      const out = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
        (resolve, reject) => {
          const payload = startRunPayload("echo ran", 0);
          const bytes = Buffer.byteLength(payload, "utf8");
          const child = spawn("bash", ["-c", startRunBootstrap(bytes)]);
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
          child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
          child.once("error", reject);
          child.once("close", (code) => resolve({ stdout, stderr, code }));
          child.stdin.end(payload.slice(0, payload.indexOf("echo ran") + 6));
        },
      );
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("start script arrived incomplete");
      expect(out.code).toBe(1);
    },
  );

  it("startRun fails with the script's output when no pid was printed", async () => {
    const { rt } = stubExec((_cmd, s) => {
      s.stdoutW.end("[optio] Waiting for repo to be ready...\n[optio] ERROR: repo not ready\n");
      s.stderrW.end("bash: line 3: git: not found\n");
    });
    await expect(
      execRunProtocol.startRun(rt, HANDLE, { script: "exit 1", initialStdin: "" }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RunStartError);
      expect((err as Error).message).toContain("ended without launching the agent");
      expect((err as Error).message).toContain("repo not ready");
      expect((err as RunStartError).output).toContain("git: not found");
      return true;
    });
  });

  it("attachRun streams stdout as the output and resolves the exit from the stderr marker", async () => {
    const { rt, calls } = stubExec((_cmd, s) => {
      s.stdoutW.write('{"seq":1}\n');
      s.stdoutW.write('{"seq":2}\n');
      s.stderrW.write("tail: a warning\n");
      s.stderrW.write(`${RUN_EXIT_MARKER}:3\n`);
      s.stdoutW.end();
      s.stderrW.end();
    });
    const attachment = await execRunProtocol.attachRun(rt, HANDLE, {
      runDir: RUN_DIR,
      fromByte: 10,
    });
    let out = "";
    for await (const chunk of attachment.output) out += chunk.toString();
    expect(out).toBe('{"seq":1}\n{"seq":2}\n');
    expect(await attachment.exit).toEqual({ kind: "exited", code: 3 });
    expect(calls[0][2]).toBe(attachRunScript(RUN_DIR, 10));
  });

  it("attachRun's exit settles only once the output has fully ended, however early the marker came", async () => {
    const { rt } = stubExec((_cmd, s) => {
      // The marker first; stdout keeps flowing for a while.
      s.stderrW.end(`${RUN_EXIT_MARKER}:0\n`);
      s.stdoutW.write("early\n");
      setTimeout(() => {
        s.stdoutW.write("late\n");
        s.stdoutW.end();
      }, 60);
    });
    const attachment = await execRunProtocol.attachRun(rt, HANDLE, {
      runDir: RUN_DIR,
      fromByte: 0,
    });
    let seen = "";
    attachment.output.on("data", (c: Buffer) => (seen += c.toString()));
    const exit = await attachment.exit;
    expect(exit).toEqual({ kind: "exited", code: 0 });
    expect(seen).toBe("early\nlate\n");
  });

  it("attachRun resolves lost from the marker and detached when the exec drops without one", async () => {
    const lost = stubExec((_cmd, s) => {
      s.stderrW.end(`${RUN_LOST_MARKER}\n`);
      s.stdoutW.end();
    });
    expect(
      await (
        await execRunProtocol.attachRun(lost.rt, HANDLE, { runDir: RUN_DIR, fromByte: 0 })
      ).exit,
    ).toEqual({ kind: "lost" });

    const dropped = stubExec((_cmd, s) => {
      s.stdoutW.write("partial");
      s.stdoutW.end();
      s.stderrW.end();
    });
    expect(
      await (
        await execRunProtocol.attachRun(dropped.rt, HANDLE, { runDir: RUN_DIR, fromByte: 0 })
      ).exit,
    ).toEqual({ kind: "detached", reason: "stream-ended" });

    const closedByUs = stubExec(() => {});
    const attachment = await execRunProtocol.attachRun(closedByUs.rt, HANDLE, {
      runDir: RUN_DIR,
      fromByte: 0,
    });
    attachment.close();
    expect(await attachment.exit).toEqual({ kind: "detached", reason: "closed" });
  });

  it("deliverStdin feeds the line over stdin and judges by the delivered marker on stdout", async () => {
    const ok = stubExec((_cmd, s) => {
      setTimeout(() => {
        s.stdoutW.end(`${STDIN_DELIVERED_MARKER}\n`);
        s.stderrW.end("some stderr noise\n");
      }, 10);
    });
    const line = `{"type":"user","text":"ünïcode"}`;
    await execRunProtocol.deliverStdin(ok.rt, HANDLE, { runDir: RUN_DIR, line });
    const bytes = Buffer.byteLength(`${line}\n`, "utf8");
    expect(ok.calls[0][2]).toBe(deliverStdinScript(RUN_DIR, bytes));
    expect(ok.calls[0][2]).not.toContain("ünïcode");
    expect(Buffer.concat(ok.sessions[0].stdinData).toString("utf8")).toBe(`${line}\n`);

    const bad = stubExec((_cmd, s) => {
      s.stdoutW.end();
      s.stderrW.end("no run directory at /home/agent/optio/runs/x\n");
    });
    await expect(
      execRunProtocol.deliverStdin(bad.rt, HANDLE, { runDir: RUN_DIR, line: "hello" }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RunDeliverError);
      expect((err as Error).message).toContain("no run directory");
      return true;
    });
    await expect(
      execRunProtocol.deliverStdin(bad.rt, HANDLE, { runDir: RUN_DIR, line: "a\nb" }),
    ).rejects.toThrow(/newline/);

    const closed = stubExec((_cmd, s) => {
      s.stdoutW.end(`${STDIN_CLOSED_MARKER}\n`);
      s.stderrW.end();
    });
    await expect(
      execRunProtocol.deliverStdin(closed.rt, HANDLE, { runDir: RUN_DIR, line: "late" }),
    ).rejects.toBeInstanceOf(RunStdinClosedError);
  });

  it("killRun reports whether anything was signalled", async () => {
    const killed = stubExec((_cmd, s) => {
      s.stdoutW.end("killed\n");
      s.stderrW.end();
    });
    expect(
      await execRunProtocol.killRun(killed.rt, HANDLE, { runDir: RUN_DIR, signal: "TERM" }),
    ).toBe(true);
    expect(killed.calls[0][2]).toBe(killRunScript(RUN_DIR, "TERM"));
    const none = stubExec((_cmd, s) => {
      s.stdoutW.end("none\n");
      s.stderrW.end();
    });
    expect(
      await execRunProtocol.killRun(none.rt, HANDLE, { runDir: RUN_DIR, signal: "KILL" }),
    ).toBe(false);
    await execRunProtocol.killRun(none.rt, HANDLE, { runDir: RUN_DIR, signal: "TERM", pid: 77 });
    expect(none.calls[1][2]).toBe(killRunScript(RUN_DIR, "TERM", 77));
  });
});
