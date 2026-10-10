import { describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import type { ContainerHandle, ExecSession } from "@optio/shared";
import {
  RUN_EXIT_MARKER,
  RUN_FILES,
  RUN_LOST_MARKER,
  RUN_STARTED_MARKER,
  RunDeliverError,
  RunStartError,
  STDIN_EOF_SENTINEL,
  SUPERVISOR_SCRIPT,
  attachRunScript,
  deliverStdinScript,
  execRunProtocol,
  killRunScript,
  parseRunExitLine,
  parseRunStartedPid,
  superviseAgent,
} from "./run-protocol.js";

const RUN_DIR = "/home/agent/optio/runs/0f2e1c1a-1111-4222-8333-444444444444";
const HANDLE: ContainerHandle = { id: "pod-1", name: "pod-1" };

describe("superviseAgent", () => {
  const lines = superviseAgent(RUN_DIR, [
    "export FOO='bar'",
    "claude -p --output-format stream-json",
  ]);
  const script = lines.join("\n");

  it("exports the run directory and writes the agent command verbatim in a quoted heredoc", () => {
    expect(lines[0]).toBe(`export OPTIO_RUN_DIR='${RUN_DIR}'`);
    expect(script).toContain(`cat > "$OPTIO_RUN_DIR/${RUN_FILES.agent}" <<'__OPTIO_AGENT_SH__'`);
    expect(script).toContain(
      "export FOO='bar'\nclaude -p --output-format stream-json\n__OPTIO_AGENT_SH__",
    );
  });

  it("writes the supervisor as a file and launches it in its own session, printing the pid", () => {
    expect(script).toContain(
      `cat > "$OPTIO_RUN_DIR/${RUN_FILES.supervisor}" <<'__OPTIO_SUPERVISOR_SH__'`,
    );
    expect(script).toContain(SUPERVISOR_SCRIPT.trimEnd());
    expect(script).toContain(
      `setsid bash "$OPTIO_RUN_DIR/${RUN_FILES.supervisor}" > /dev/null 2>&1 < /dev/null &`,
    );
    expect(script).toContain(`echo "$_optio_sup" > "$OPTIO_RUN_DIR/${RUN_FILES.pid}"`);
    expect(lines.at(-1)).toBe(`echo "${RUN_STARTED_MARKER}:$_optio_sup"`);
  });

  it("starts a fresh attempt: truncated output, no stale exit or pid, stdin primed from the env", () => {
    expect(script).toContain(
      `rm -f "$OPTIO_RUN_DIR/${RUN_FILES.exit}" "$OPTIO_RUN_DIR/${RUN_FILES.pid}" "$OPTIO_RUN_DIR/${RUN_FILES.stdinPipe}"`,
    );
    expect(script).toContain(`: > "$OPTIO_RUN_DIR/${RUN_FILES.output}"`);
    expect(script).toContain(
      `printf '%s' "\${OPTIO_RUN_STDIN:-}" > "$OPTIO_RUN_DIR/${RUN_FILES.stdin}"`,
    );
    expect(script).toContain(`mkfifo "$OPTIO_RUN_DIR/${RUN_FILES.stdinPipe}"`);
  });

  it("never kills children or removes the run directory on exit, and has no EPIPE watchdog", () => {
    // The only trap is the supervisor's own TERM handler, inside its heredoc.
    const outsideHeredocs = script.replace(/<<'(__OPTIO_\w+__)'\n[\s\S]*?\n\1/g, "");
    expect(outsideHeredocs).not.toContain("trap");
    expect(script).not.toContain(" EXIT");
    expect(script).not.toContain("rm -rf");
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
  it("feeds stdin through a FIFO until the EOF sentinel, waits for the agent, records its exit", () => {
    expect(SUPERVISOR_SCRIPT).toContain(
      `bash "$d/${RUN_FILES.agent}" < "$d/${RUN_FILES.stdinPipe}" >> "$d/${RUN_FILES.output}" 2>> "$d/${RUN_FILES.stderr}" &`,
    );
    expect(SUPERVISOR_SCRIPT).toContain(`tail -n +1 --pid="$agent" -f "$d/${RUN_FILES.stdin}"`);
    expect(SUPERVISOR_SCRIPT).toContain(`if [ "$l" = "${STDIN_EOF_SENTINEL}" ]; then break; fi`);
    expect(SUPERVISOR_SCRIPT).toContain(`wait "$agent"`);
    expect(SUPERVISOR_SCRIPT).toContain(`echo "$code" > "$d/${RUN_FILES.exit}"`);
  });

  it("records 143 when terminated, after passing the signal to the agent", () => {
    expect(SUPERVISOR_SCRIPT).toContain(
      `on_term() { kill -TERM "$agent" 2>/dev/null; wait "$agent" 2>/dev/null; echo 143 > "$d/${RUN_FILES.exit}"; exit 143; }`,
    );
    expect(SUPERVISOR_SCRIPT).toContain("trap on_term TERM INT HUP");
  });
});

describe("attachRunScript", () => {
  it("tails the output file from the byte after the offset while the supervisor lives", () => {
    const s = attachRunScript(RUN_DIR, 1234);
    expect(s).toContain(`d='${RUN_DIR}'`);
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

  it("never goes below byte 1", () => {
    expect(attachRunScript(RUN_DIR, -5)).toContain("tail -c +1 ");
  });
});

describe("deliverStdinScript", () => {
  it("passes the line through the environment, never the script text", () => {
    const line = `{"type":"user","text":"it's $(rm -rf /) \`x\`"}`;
    const s = deliverStdinScript(RUN_DIR, line);
    expect(s).toContain(
      `export OPTIO_STDIN_LINE='{"type":"user","text":"it'\\''s $(rm -rf /) \`x\`"}'`,
    );
    expect(s).toContain(`printf '%s\\n' "$OPTIO_STDIN_LINE" >> '${RUN_DIR}'/${RUN_FILES.stdin}`);
  });

  it("refuses a line with a newline", () => {
    expect(() => deliverStdinScript(RUN_DIR, "a\nb")).toThrow(/newline/);
  });
});

describe("killRunScript", () => {
  it("signals the supervisor's process group, falling back to the pid", () => {
    const s = killRunScript(RUN_DIR, "TERM");
    expect(s).toContain(`pid=$(cat '${RUN_DIR}'/${RUN_FILES.pid} 2>/dev/null || true)`);
    expect(s).toContain(
      `kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true`,
    );
    expect(s).toContain("echo killed");
    expect(s).toContain("echo none");
  });

  it("only knows the four signals", () => {
    expect(() => killRunScript(RUN_DIR, "USR1" as never)).toThrow(/Unsupported signal/);
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

/** A stub exec: records the command, plays scripted stdout/stderr. */
function stubExec(
  play: (
    cmd: string[],
    session: ExecSession & { stdoutW: PassThrough; stderrW: PassThrough },
  ) => void,
) {
  const calls: string[][] = [];
  const rt = {
    async exec(_h: ContainerHandle, command: string[]): Promise<ExecSession> {
      calls.push(command);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new Writable({ write: (_c, _e, cb) => cb() });
      let closed = false;
      const session = {
        stdin,
        stdout,
        stderr,
        stdoutW: stdout,
        stderrW: stderr,
        resize: () => {},
        close: () => {
          if (closed) return;
          closed = true;
          stdout.end();
          stderr.end();
        },
      };
      setImmediate(() => play(command, session));
      return session;
    },
  };
  return { rt, calls };
}

describe("execRunProtocol", () => {
  it("startRun prepends the stdin export, runs the script, and parses the pid out of stdout", async () => {
    const { rt, calls } = stubExec((_cmd, s) => {
      s.stdoutW.end(`[optio] Repo ready\n${RUN_STARTED_MARKER}:777\n`);
      s.stderrW.end();
    });
    const result = await execRunProtocol.startRun(rt, HANDLE, {
      script: "set -e\necho hi",
      initialStdin: `{"type":"user"}\n`,
    });
    expect(result).toEqual({ pid: 777, output: "[optio] Repo ready\n" });
    expect(calls[0][0]).toBe("bash");
    expect(calls[0][1]).toBe("-c");
    expect(calls[0][2]).toBe(`export OPTIO_RUN_STDIN='{"type":"user"}\n'\nset -e\necho hi`);
  });

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

  it("deliverStdin runs the deliver script and fails on any stderr", async () => {
    const ok = stubExec((_cmd, s) => {
      s.stdoutW.end();
      s.stderrW.end();
    });
    await execRunProtocol.deliverStdin(ok.rt, HANDLE, { runDir: RUN_DIR, line: "hello" });
    expect(ok.calls[0][2]).toBe(`set -e\n${deliverStdinScript(RUN_DIR, "hello")}`);

    const bad = stubExec((_cmd, s) => {
      s.stdoutW.end();
      s.stderrW.end("bash: /home/agent/optio/runs/x/stdin.ndjson: No such file or directory\n");
    });
    await expect(
      execRunProtocol.deliverStdin(bad.rt, HANDLE, { runDir: RUN_DIR, line: "hello" }),
    ).rejects.toBeInstanceOf(RunDeliverError);
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
  });
});
