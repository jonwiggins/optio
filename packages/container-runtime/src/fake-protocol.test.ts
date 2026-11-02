/**
 * The fake runtime's run protocol: a run is a process of its own, written to
 * files under the runtime's directory, so a different runtime instance (and
 * a different API process — the e2e tier proves that one) attaches to it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ContainerHandle, ContainerSpec } from "@optio/shared";
import { FakeContainerRuntime } from "./fake.js";
import { RUN_FILES, RunStdinClosedError, STDIN_EOF_SENTINEL } from "./run-protocol.js";
import type { RunAttachment } from "./types.js";

const AGENT_SCRIPT = [
  "set -e",
  "export OPTIO_REPO_URL='https://github.com/e2e-org/e2e-repo'",
  "claude -p --input-format stream-json --output-format stream-json --verbose",
].join("\n");

const RUN_DIR = "/home/agent/optio/runs";

function userMessage(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function spec(env: Record<string, string> = {}): ContainerSpec {
  return {
    image: "optio-agent:latest",
    command: ["sleep", "infinity"],
    env,
    workDir: "/workspace",
    labels: {},
  };
}

interface Event {
  type?: string;
  subtype?: string;
  seq?: number;
  is_error?: boolean;
  message?: { content?: Array<{ type?: string; text?: string }> };
}

async function drain(attachment: RunAttachment): Promise<{ text: string; events: Event[] }> {
  let text = "";
  for await (const chunk of attachment.output) text += chunk.toString();
  const events: Event[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as Event);
    } catch {
      // raw line
    }
  }
  return { text, events };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let a: FakeContainerRuntime;
let handle: ContainerHandle;
const started: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "optio-fake-protocol-"));
  a = new FakeContainerRuntime({ dir });
  handle = await a.create(spec({ OPTIO_REPO_URL: "https://github.com/e2e-org/e2e-repo" }));
});

afterEach(async () => {
  // Never leave a detached fake agent behind.
  for (const runId of started.splice(0))
    await a.killRun(handle, { runId, runDir: RUN_DIR, signal: "KILL" }).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

async function start(prompt: string, script = AGENT_SCRIPT, rt = a): Promise<string> {
  const runId = randomUUID();
  started.push(runId);
  const result = await rt.startRun(handle, {
    runId,
    runDir: `${RUN_DIR}/${runId}`,
    script,
    initialStdin: `${userMessage(prompt)}\n`,
  });
  expect(result.pid).toBeGreaterThan(0);
  return runId;
}

describe("FakeContainerRuntime run protocol", () => {
  it("a run started by one instance is attached by another on the same directory, with contiguous seq", async () => {
    const runId = await start("hello [[mock:cost:0.5]]");
    const b = new FakeContainerRuntime({ dir });
    expect((await b.status(handle)).state).toBe("running");

    const attachment = await b.attachRun(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      fromByte: 0,
    });
    // The agent waits for stdin to close after its result, like claude.
    await sleep(300);
    await b.deliverStdin(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      line: STDIN_EOF_SENTINEL,
    });
    const { events } = await drain(attachment);
    expect(await attachment.exit).toEqual({ kind: "exited", code: 0 });

    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "result"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[2]).toMatchObject({ subtype: "success", total_cost_usd: 0.5 });
    expect(readFileSync(join(b.runDirectory(runId), RUN_FILES.exit), "utf8").trim()).toBe("0");
    // The agent wrote its own pid file, pid and identity token, once its TERM handler was up.
    expect(readFileSync(join(b.runDirectory(runId), RUN_FILES.pid), "utf8").trim()).toMatch(
      /^\d+ \S+$/,
    );
  });

  it("[[mock:ticks:N:MS]] plays N numbered text events after init, each with its seq", async () => {
    const runId = await start("busy [[mock:ticks:4:20]]");
    const attachment = await a.attachRun(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      fromByte: 0,
    });
    await sleep(400);
    await a.deliverStdin(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      line: STDIN_EOF_SENTINEL,
    });
    const { events } = await drain(attachment);
    const ticks = events
      .map((e) => e.message?.content?.[0]?.text)
      .filter((t): t is string => !!t && t.startsWith("tick "));
    expect(ticks).toEqual(["tick 1", "tick 2", "tick 3", "tick 4"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("a fresh start of the same run stops the previous attempt's agent first", async () => {
    const runId = randomUUID();
    started.push(runId);
    const input = (prompt: string) => ({
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      script: AGENT_SCRIPT,
      initialStdin: `${userMessage(prompt)}\n`,
    });
    const first = await a.startRun(handle, input("first [[mock:hang]]"));
    const second = await a.startRun(handle, input("second"));
    expect(second.pid).not.toBe(first.pid);
    expect(() => process.kill(first.pid, 0)).toThrow();
    await a.deliverStdin(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      line: STDIN_EOF_SENTINEL,
    });
    const attachment = await a.attachRun(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      fromByte: 0,
    });
    const { text } = await drain(attachment);
    expect(await attachment.exit).toEqual({ kind: "exited", code: 0 });
    expect(text).toContain("second");
    expect(text).not.toContain("first [[mock:hang]]");
    // The first attempt's files were moved aside and removed, not reused.
    await sleep(50);
    expect(readdirSync(join(dir, "runs")).filter((f) => f.includes(".prev-"))).toEqual([]);
  });

  it("an attachment keeps reading its own attempt's output, never a later attempt's", async () => {
    const runId = randomUUID();
    started.push(runId);
    const input = (prompt: string) => ({
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      script: AGENT_SCRIPT,
      initialStdin: `${userMessage(prompt)}\n`,
    });
    await a.startRun(handle, input("first [[mock:hang]]"));
    const old = await a.attachRun(handle, { runId, runDir: `${RUN_DIR}/${runId}`, fromByte: 0 });
    await sleep(200);
    await a.startRun(handle, input("second [[mock:ticks:3:10]]"));
    old.close();
    const { text } = await drain(old);
    expect(text).not.toContain("tick 1");
  });

  it("[[mock:mark:N:TEXT]] puts a text event of the test's choosing right after tick N", async () => {
    const runId = await start("marked [[mock:ticks:4:10]] [[mock:mark:2:HERE-IT-IS]]");
    await a.deliverStdin(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      line: STDIN_EOF_SENTINEL,
    });
    const attachment = await a.attachRun(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      fromByte: 0,
    });
    const { events } = await drain(attachment);
    const texts = events.flatMap((e) => e.message?.content?.map((c) => c.text) ?? []);
    expect(texts.slice(0, 5)).toEqual(["tick 1", "tick 2", "HERE-IT-IS", "tick 3", "tick 4"]);
  });

  it("[[mock:slow-start:MS]] holds the start that long before the agent launches", async () => {
    const t0 = Date.now();
    const runId = await start("slow [[mock:slow-start:600]]");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
    await a.deliverStdin(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      line: STDIN_EOF_SENTINEL,
    });
    const attachment = await a.attachRun(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      fromByte: 0,
    });
    await drain(attachment);
    expect(await attachment.exit).toEqual({ kind: "exited", code: 0 });
  });

  it("a line after the EOF sentinel is refused: the agent's stdin is closed", async () => {
    const runId = await start("done soon");
    const runDir = `${RUN_DIR}/${runId}`;
    await a.deliverStdin(handle, { runId, runDir, line: STDIN_EOF_SENTINEL });
    await expect(
      a.deliverStdin(handle, { runId, runDir, line: userMessage("too late") }),
    ).rejects.toBeInstanceOf(RunStdinClosedError);
    expect(readFileSync(join(a.runDirectory(runId), RUN_FILES.stdin), "utf8")).not.toContain(
      "too late",
    );
  });

  it("[[mock:stderr:TEXT]] puts TEXT in the run's stderr, which a stderr-tail exec reads", async () => {
    const runId = await start("noisy [[mock:stderr:claude: something broke]]");
    const session = await a.exec(handle, [
      "bash",
      "-c",
      `if [ -s '${RUN_DIR}/${runId}/stderr.log' ]; then tail -c 8192 '${RUN_DIR}/${runId}/stderr.log'; fi`,
    ]);
    let out = "";
    for await (const chunk of session.stdout as AsyncIterable<Buffer>) out += chunk.toString();
    expect(out).toBe("claude: something broke\n");
  });

  it("a pid-scoped kill signals only that attempt", async () => {
    const runId = await start("hang [[mock:hang]]");
    const runDir = `${RUN_DIR}/${runId}`;
    const pid = Number(
      readFileSync(join(a.runDirectory(runId), RUN_FILES.pid), "utf8").split(" ")[0],
    );
    expect(await a.killRun(handle, { runId, runDir, signal: "TERM", pid: pid + 1 })).toBe(false);
    expect(await a.killRun(handle, { runId, runDir, signal: "TERM", pid })).toBe(true);
  });

  it("re-attaching from the consumed offset yields the rest exactly once", async () => {
    const runId = await start("slow [[mock:sleep:600]]");
    const first = await a.attachRun(handle, { runId, runDir: `${RUN_DIR}/${runId}`, fromByte: 0 });
    let firstText = "";
    first.output.on("data", (c: Buffer) => (firstText += c.toString()));
    await sleep(250);
    first.close();
    expect(await first.exit).toEqual({ kind: "detached", reason: "closed" });
    // Only whole lines count as consumed.
    const consumed = firstText.lastIndexOf("\n") + 1;
    expect(consumed).toBeGreaterThan(0);
    expect(JSON.parse(firstText.slice(0, consumed).trim())).toMatchObject({
      type: "system",
      seq: 1,
    });

    const second = await a.attachRun(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      fromByte: consumed,
    });
    await sleep(800);
    await a.deliverStdin(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      line: STDIN_EOF_SENTINEL,
    });
    const { events } = await drain(second);
    expect(await second.exit).toEqual({ kind: "exited", code: 0 });
    expect(events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("delivers mid-run stdin to the agent, which echoes it with [[mock:echo-stdin]]", async () => {
    const runId = await start("chatty [[mock:echo-stdin]] [[mock:sleep:400]]");
    const attachment = await a.attachRun(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      fromByte: 0,
    });
    await sleep(100);
    await a.deliverStdin(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      line: userMessage("are you there?"),
    });
    await sleep(600);
    await a.deliverStdin(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      line: STDIN_EOF_SENTINEL,
    });
    const { events } = await drain(attachment);
    const texts = events.flatMap((e) => e.message?.content?.map((c) => c.text) ?? []);
    expect(texts).toContain("stdin: are you there?");
    expect(await attachment.exit).toEqual({ kind: "exited", code: 0 });
  });

  it("a failing tape exits 1 after its error result", async () => {
    const runId = await start("boom [[mock:fail]]");
    const attachment = await a.attachRun(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      fromByte: 0,
    });
    await sleep(200);
    await a.deliverStdin(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      line: STDIN_EOF_SENTINEL,
    });
    const { events } = await drain(attachment);
    expect(events.at(-1)).toMatchObject({ type: "result", is_error: true });
    expect(await attachment.exit).toEqual({ kind: "exited", code: 1 });
  });

  it("[[mock:silent]] writes nothing and exits 0", async () => {
    const runId = await start("quiet [[mock:silent]]");
    const attachment = await a.attachRun(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      fromByte: 0,
    });
    const { text } = await drain(attachment);
    expect(text).toBe("");
    expect(await attachment.exit).toEqual({ kind: "exited", code: 0 });
  });

  it("killRun TERM ends a hanging run with exit 143; KILL leaves it lost", async () => {
    const hung = await start("stuck [[mock:hang]]");
    const attachment = await a.attachRun(handle, {
      runId: hung,
      runDir: `${RUN_DIR}/${hung}`,
      fromByte: 0,
    });
    await sleep(200);
    expect(
      await a.killRun(handle, { runId: hung, runDir: `${RUN_DIR}/${hung}`, signal: "TERM" }),
    ).toBe(true);
    await drain(attachment);
    expect(await attachment.exit).toEqual({ kind: "exited", code: 143 });
    expect(
      await a.killRun(handle, { runId: hung, runDir: `${RUN_DIR}/${hung}`, signal: "TERM" }),
    ).toBe(false);

    const killed = await start("stuck again [[mock:hang]]");
    const second = await a.attachRun(handle, {
      runId: killed,
      runDir: `${RUN_DIR}/${killed}`,
      fromByte: 0,
    });
    await sleep(200);
    expect(
      await a.killRun(handle, { runId: killed, runDir: `${RUN_DIR}/${killed}`, signal: "KILL" }),
    ).toBe(true);
    await drain(second);
    expect(await second.exit).toEqual({ kind: "lost" });
    expect(existsSync(join(a.runDirectory(killed), RUN_FILES.exit))).toBe(false);
  }, 15_000);

  it("a kill-style utility exec and destroy reach protocol runs too", async () => {
    const runId = await start("stuck [[mock:hang]]");
    await sleep(150);
    const session = await a.exec(handle, ["bash", "-c", "pkill -TERM -f claude"]);
    session.close();
    await sleep(300);
    expect(await a.killRun(handle, { runId, runDir: `${RUN_DIR}/${runId}`, signal: "TERM" })).toBe(
      false,
    );
    expect(readFileSync(join(a.runDirectory(runId), RUN_FILES.exit), "utf8").trim()).toBe("143");

    const other = await start("stuck [[mock:hang]]");
    await sleep(150);
    await a.destroy(handle);
    await sleep(200);
    expect(
      await a.killRun(handle, { runId: other, runDir: `${RUN_DIR}/${other}`, signal: "TERM" }),
    ).toBe(false);
    expect((await a.status(handle)).state).toBe("unknown");
  });

  it("a command run prints its output and exit status and exits", async () => {
    const script = "export OPTIO_COMMAND='echo hi'\nbash -lc \"$OPTIO_COMMAND\"";
    const runId = randomUUID();
    started.push(runId);
    await a.startRun(handle, { runId, runDir: `${RUN_DIR}/${runId}`, script, initialStdin: "" });
    const attachment = await a.attachRun(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      fromByte: 0,
    });
    const { text } = await drain(attachment);
    expect(text).toContain("fake command output\n[optio:exit] 0");
    expect(await attachment.exit).toEqual({ kind: "exited", code: 0 });
  });

  it("an exit file caught before its code is written is read again, not taken as exit 1", async () => {
    const runId = randomUUID();
    const runDir = join(dir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, RUN_FILES.output), "");
    writeFileSync(join(runDir, RUN_FILES.exit), "");
    const attachment = await a.attachRun(handle, { runId, runDir, fromByte: 0 });
    setTimeout(() => writeFileSync(join(runDir, RUN_FILES.exit), "0\n"), 150);
    expect(await attachment.exit).toEqual({ kind: "exited", code: 0 });
  });

  it("refuses agents it cannot play, bad run ids, and multi-line stdin", async () => {
    await expect(
      a.startRun(handle, {
        runId: randomUUID(),
        runDir: RUN_DIR,
        script: "set -e\n codex exec",
        initialStdin: "",
      }),
    ).rejects.toThrow(/only plays claude-code/);
    await expect(
      a.startRun(handle, {
        runId: "../etc",
        runDir: RUN_DIR,
        script: AGENT_SCRIPT,
        initialStdin: "",
      }),
    ).rejects.toThrow(/Invalid run id/);
    const runId = await start("x");
    await expect(
      a.deliverStdin(handle, { runId, runDir: `${RUN_DIR}/${runId}`, line: "a\nb" }),
    ).rejects.toThrow(/newline/);
    await a.deliverStdin(handle, {
      runId,
      runDir: `${RUN_DIR}/${runId}`,
      line: STDIN_EOF_SENTINEL,
    });
  });

  it("attaching to a run that was never started reports it lost", async () => {
    const attachment = await a.attachRun(handle, {
      runId: randomUUID(),
      runDir: RUN_DIR,
      fromByte: 0,
    });
    const { text } = await drain(attachment);
    expect(text).toBe("");
    expect(await attachment.exit).toEqual({ kind: "lost" });
  });

  it("a non-persistent runtime keeps containers in memory and runs in a private directory", async () => {
    const mem = new FakeContainerRuntime();
    expect(mem.persistent).toBe(false);
    const h = await mem.create(spec());
    expect((await new FakeContainerRuntime({ dir: mem.dir }).status(h)).state).toBe("unknown");
    rmSync(mem.dir, { recursive: true, force: true });
  });
});
