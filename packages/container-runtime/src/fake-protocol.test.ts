/**
 * The fake runtime's run protocol: a run is a process of its own, written to
 * files under the runtime's directory, so a different runtime instance (and
 * a different API process — the e2e tier proves that one) attaches to it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ContainerHandle, ContainerSpec } from "@optio/shared";
import { FakeContainerRuntime } from "./fake.js";
import { RUN_FILES, STDIN_EOF_SENTINEL } from "./run-protocol.js";
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
