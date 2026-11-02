/**
 * Log redaction against a real Postgres and Redis: a run whose agent prints
 * the secret Optio injected into it stores and streams the masked line, an
 * instance that attaches to the run later (a fresh module graph, nothing
 * cached) masks it too from the sealed copy in Redis, and a system line
 * about the run is masked the same way.
 */
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { TaskState } from "@optio/shared";
import type { ContainerRuntime, RunAttachment } from "@optio/container-runtime";
import { db } from "../db/client.js";
import { taskLogs } from "../db/schema.js";
import { insertTask } from "../test-utils/integration/fixtures.js";

vi.mock("./container-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./container-service.js")>();
  return { ...actual, getRuntime: () => ({ killRun: async () => true }) };
});

// Built at run time, so secret scanners don't flag the fixtures.
const TOKEN = ["glpat", "Zx9Yw8Vu7Ts6Rq5Po4Nm"].join("-");
const AWS_KEY_ID = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const POD = "00000000-0000-4000-8000-000000000001";

/** A runtime whose attach plays `text` and exits 0. */
function runtimePlaying(text: string): ContainerRuntime {
  return {
    attachRun: async (): Promise<RunAttachment> => {
      const output = Readable.from([Buffer.from(text, "utf8")]);
      const ended = new Promise<void>((r) => output.on("end", r));
      return {
        output,
        exit: ended.then(() => ({ kind: "exited", code: 0 }) as const),
        close: () => output.destroy(),
      };
    },
    deliverStdin: async () => {},
  } as unknown as ContainerRuntime;
}

/** A fresh module graph: what another API process would be. */
async function bootInstance() {
  vi.resetModules();
  return {
    att: await import("./run-attachment.js"),
    redaction: await import("./log-redaction.js"),
    tasks: await import("./task-service.js"),
  };
}
type Instance = Awaited<ReturnType<typeof bootInstance>>;

async function startedRun() {
  return insertTask({
    state: TaskState.RUNNING,
    execState: "started",
    execPid: 4242,
    lastPodId: POD,
    attachedBy: "gone-instance:000000/0000",
    attachLeaseUntil: new Date(Date.now() - 5_000),
  });
}

/** Claims the run on `inst` and streams the agent output `text` through the real stores. */
async function stream(inst: Instance, taskId: string, text: string) {
  const ref = { kind: "work-run" as const, id: taskId };
  const claim = await inst.att.claimAttachment(ref);
  if (!claim) throw new Error("claim lost");
  const hold = inst.att.startHold(ref, claim.token, {
    phase: "streaming",
    agent: { podId: POD, pid: 4242 },
  });
  try {
    const published: string[] = [];
    await inst.att.streamRun({
      runtime: runtimePlaying(text),
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: `/home/agent/optio/runs/${taskId}`,
      hold,
      consumedBytes: claim.consumedBytes,
      parse: (line) => {
        const e = JSON.parse(line) as { text: string; command?: string };
        return {
          entries: [
            {
              type: "text",
              content: e.text,
              ...(e.command ? { metadata: { input: { command: e.command } } } : {}),
            } as never,
          ],
        };
      },
      publish: async (row) => {
        published.push(row.content);
        await inst.tasks.publishTaskLogRow(taskId, row);
      },
    });
    return published;
  } finally {
    await inst.att.closeAttachment(hold);
  }
}

async function storedLogs(taskId: string) {
  return db
    .select({ content: taskLogs.content, metadata: taskLogs.metadata })
    .from(taskLogs)
    .where(eq(taskLogs.taskId, taskId))
    .orderBy(taskLogs.timestamp, taskLogs.id);
}

/** The live frames on the task's channel while `fn` runs. */
async function liveFrames(taskId: string, fn: () => Promise<unknown>): Promise<string[]> {
  const sub = new Redis(process.env.REDIS_URL!);
  const frames: string[] = [];
  sub.on("message", (_channel, message) => frames.push(message));
  await sub.subscribe(`optio:task:${taskId}`);
  try {
    await fn();
    // Pub/sub is asynchronous: wait for the frames to land.
    for (let i = 0; i < 50 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await sub.quit();
  }
  return frames;
}

const line = (e: Record<string, string>) => JSON.stringify(e) + "\n";

beforeEach(() => {
  process.env.OPTIO_LOG_REDACT_SECRETS = "true";
  delete process.env.OPTIO_LOG_REDACT_PATTERNS;
});
afterEach(() => {
  delete process.env.OPTIO_LOG_REDACT_SECRETS;
  delete process.env.OPTIO_LOG_REDACT_PATTERNS;
});

describe("log redaction, real Postgres and Redis", () => {
  it("a run that prints its injected secret stores and streams the masked line", async () => {
    const inst = await bootInstance();
    const run = await startedRun();
    await inst.redaction.registerRunSecrets(
      run.id,
      inst.redaction.runSecretValues({ GITLAB_TOKEN: TOKEN, OPTIO_PROMPT: "fix the build" }),
    );

    const output =
      line({ text: `$ env\nGITLAB_TOKEN=${TOKEN}`, command: `echo ${TOKEN}` }) +
      line({ text: "all 12 tests passed" });
    let published: string[] = [];
    const frames = await liveFrames(run.id, async () => {
      published = await stream(inst, run.id, output);
    });

    // One batch: one timestamp, so the stored order between the two is not fixed.
    const stored = await storedLogs(run.id);
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(
      expect.arrayContaining([
        {
          content: "$ env\nGITLAB_TOKEN=[redacted:GITLAB_TOKEN]",
          metadata: { input: { command: "echo [redacted:GITLAB_TOKEN]" } },
        },
        { content: "all 12 tests passed", metadata: null },
      ]),
    );
    expect(published).toEqual([
      "$ env\nGITLAB_TOKEN=[redacted:GITLAB_TOKEN]",
      "all 12 tests passed",
    ]);
    expect(frames).toHaveLength(2);
    for (const frame of frames) expect(frame).not.toContain(TOKEN);
    expect(JSON.parse(frames[0])).toMatchObject({
      type: "task:log",
      content: "$ env\nGITLAB_TOKEN=[redacted:GITLAB_TOKEN]",
    });
  });

  it("an instance that attaches later masks the run's secret from the sealed copy", async () => {
    const starter = await bootInstance();
    const run = await startedRun();
    await starter.redaction.registerRunSecrets(run.id, new Map([[TOKEN, "GITLAB_TOKEN"]]));

    // Another process: nothing in memory, only Redis.
    const other = await bootInstance();
    await stream(
      other,
      run.id,
      line({ text: `git remote -v: https://oauth2:${TOKEN}@host/r.git` }),
    );

    expect((await storedLogs(run.id)).map((r) => r.content)).toEqual([
      "git remote -v: https://oauth2:[redacted:GITLAB_TOKEN]@host/r.git",
    ]);
  });

  it("a system line about the run is masked too", async () => {
    const inst = await bootInstance();
    const run = await startedRun();
    await inst.redaction.registerRunSecrets(run.id, new Map([[TOKEN, "GITLAB_TOKEN"]]));

    await inst.tasks.appendTaskLog(run.id, `push failed: fatal: https://oauth2:${TOKEN}@host`);

    expect((await storedLogs(run.id)).map((r) => r.content)).toEqual([
      "push failed: fatal: https://oauth2:[redacted:GITLAB_TOKEN]@host",
    ]);
  });

  it("token shapes are masked with patterns on, and left alone by default", async () => {
    const inst = await bootInstance();
    const plain = await startedRun();
    await inst.tasks.appendTaskLog(plain.id, `key ${AWS_KEY_ID}`);
    expect((await storedLogs(plain.id)).map((r) => r.content)).toEqual([`key ${AWS_KEY_ID}`]);

    process.env.OPTIO_LOG_REDACT_PATTERNS = "true";
    const masked = await startedRun();
    await inst.tasks.appendTaskLog(masked.id, `key ${AWS_KEY_ID}`);
    expect((await storedLogs(masked.id)).map((r) => r.content)).toEqual([
      "key [redacted:aws-access-key]",
    ]);
  });

  it("with OPTIO_LOG_REDACT_SECRETS=false the line is stored as printed", async () => {
    process.env.OPTIO_LOG_REDACT_SECRETS = "false";
    const inst = await bootInstance();
    const run = await startedRun();
    await inst.redaction.registerRunSecrets(run.id, new Map([[TOKEN, "GITLAB_TOKEN"]]));
    await stream(inst, run.id, line({ text: `GITLAB_TOKEN=${TOKEN}` }));
    expect((await storedLogs(run.id)).map((r) => r.content)).toEqual([`GITLAB_TOKEN=${TOKEN}`]);
  });
});
