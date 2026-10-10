/**
 * The protocol scripts, run for real: start a supervisor with bash, attach
 * with `tail --pid`, deliver stdin, close it with the sentinel, read the
 * exit, kill a hanging run. Needs GNU coreutils and util-linux (`setsid`),
 * so it runs on Linux (CI) and skips on macOS, where the Docker check in
 * docs/plans/scale-out.md covers the same ground by hand.
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUN_FILES,
  STDIN_EOF_SENTINEL,
  attachRunScript,
  deliverStdinScript,
  killRunScript,
  superviseAgent,
} from "./run-protocol.js";

function hasGnuTools(): boolean {
  if (process.platform !== "linux") return false;
  const tail = spawnSync("tail", ["--version"], { encoding: "utf8" });
  const setsid = spawnSync("setsid", ["--version"], { encoding: "utf8" });
  return tail.status === 0 && /GNU coreutils/.test(tail.stdout) && setsid.status === 0;
}

const describeLinux = hasGnuTools() ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bash(script: string, env: Record<string, string> = {}): string {
  return execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Runs the attach script, resolving with stdout, stderr once it ends. */
function attach(script: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", () => resolve({ stdout, stderr }));
  });
}

describeLinux("the run protocol scripts under bash", () => {
  it("starts a detached agent, streams its output, feeds stdin until the sentinel, records its exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-proto-"));
    const runDir = join(dir, "run");
    try {
      const agent = [
        "n=0",
        `while IFS= read -r l; do n=$((n+1)); printf '{"echo":%s,"n":%d}\\n' "$l" "$n"; done`,
        `printf '{"done":true,"n":%d}\\n' "$n"`,
        "exit 7",
      ];
      const started = bash(["set -e", ...superviseAgent(runDir, agent)].join("\n"), {
        OPTIO_RUN_STDIN: '{"first":true}\n',
      });
      const pid = Number(started.match(/__OPTIO_RUN_STARTED__:(\d+)/)?.[1]);
      expect(pid).toBeGreaterThan(0);
      expect(readFileSync(join(runDir, RUN_FILES.pid), "utf8").trim()).toBe(String(pid));

      const attached = attach(attachRunScript(runDir, 0));
      await sleep(300);
      bash(`set -e\n${deliverStdinScript(runDir, '{"msg":"second"}')}`);
      await sleep(300);
      bash(`set -e\n${deliverStdinScript(runDir, STDIN_EOF_SENTINEL)}`);
      const { stdout, stderr } = await attached;
      expect(stdout).toBe(
        '{"echo":{"first":true},"n":1}\n{"echo":{"msg":"second"},"n":2}\n{"done":true,"n":2}\n',
      );
      expect(stderr.trim()).toBe("__OPTIO_RUN_EXIT__:7");
      expect(readFileSync(join(runDir, RUN_FILES.exit), "utf8").trim()).toBe("7");

      // A second attach from an offset replays exactly the rest.
      const offset = stdout.indexOf("\n") + 1;
      const again = await attach(attachRunScript(runDir, offset));
      expect(again.stdout).toBe(stdout.slice(offset));
      expect(again.stderr.trim()).toBe("__OPTIO_RUN_EXIT__:7");

      // Nothing of the run is left running.
      await sleep(1500);
      expect(spawnSync("kill", ["-0", String(pid)]).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("kills a hanging run's whole process group and records 143; a SIGKILLed supervisor is lost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-proto-"));
    const runDir = join(dir, "run");
    try {
      const started = bash(
        ["set -e", ...superviseAgent(runDir, ["echo '{\"init\":1}'", "sleep 1000"])].join("\n"),
      );
      const pid = Number(started.match(/__OPTIO_RUN_STARTED__:(\d+)/)?.[1]);
      const attached = attach(attachRunScript(runDir, 0));
      await sleep(300);
      expect(bash(killRunScript(runDir, "TERM")).trim()).toBe("killed");
      const { stdout, stderr } = await attached;
      expect(stdout).toBe('{"init":1}\n');
      expect(stderr.trim()).toBe("__OPTIO_RUN_EXIT__:143");
      expect(bash(killRunScript(runDir, "TERM")).trim()).toBe("none");
      await sleep(200);
      expect(spawnSync("pgrep", ["-f", "sleep 1000"]).status).not.toBe(0);
      expect(spawnSync("kill", ["-0", String(pid)]).status).not.toBe(0);

      rmSync(runDir, { recursive: true, force: true });
      const again = bash(
        ["set -e", ...superviseAgent(runDir, ["echo '{\"init\":1}'", "sleep 1000"])].join("\n"),
      );
      const pid2 = Number(again.match(/__OPTIO_RUN_STARTED__:(\d+)/)?.[1]);
      execFileSync("kill", ["-KILL", "--", `-${pid2}`]);
      await sleep(300);
      const lost = await attach(attachRunScript(runDir, 0));
      expect(lost.stderr.trim()).toBe("__OPTIO_RUN_LOST__");
      expect(existsSync(join(runDir, RUN_FILES.exit))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("a zero exit is recorded as 0 and the marker line keys on it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-proto-"));
    const runDir = join(dir, "run");
    try {
      const started = bash(
        [
          "set -e",
          ...superviseAgent(runDir, ["cat >/dev/null", "exit 0"], { markEnvReady: true }),
        ].join("\n"),
        { OPTIO_RUN_STDIN: `${STDIN_EOF_SENTINEL}\n` },
      );
      expect(started).toContain("__OPTIO_RUN_STARTED__:");
      const { stderr } = await attach(attachRunScript(runDir, 0));
      expect(stderr.trim()).toBe("__OPTIO_RUN_EXIT__:0");
      expect(readFileSync(join(runDir, RUN_FILES.exit), "utf8").trim()).toBe("0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
