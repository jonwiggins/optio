/**
 * Every WebSocket route with auth ENABLED, against real Postgres + Redis:
 *
 *   - frames a client sends the moment its socket opens, before the server
 *     has authenticated it, are processed, in order (the daemon's `hello`,
 *     a viewer's first keystrokes, a chat prompt, a terminal resize);
 *   - a session-chat prompt sent right after `ready`, while the server is
 *     still replaying history, is processed too (both auth modes);
 *   - a client that leaves while the server is still authenticating it
 *     releases its connection slot and never gets a Redis subscriber, an
 *     exec, or Optio chat's one-conversation-per-user slot.
 *
 * The race is made deterministic with table locks: holding ACCESS EXCLUSIVE
 * on `api_keys` blocks authenticateWs's PAT lookup exactly like a slow
 * database, so every frame provably arrives before the handler could have
 * attached a listener. Before the fix (listeners attached after the awaits)
 * each of these frames was silently dropped.
 */
import { randomBytes } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ContainerRuntime } from "@optio/container-runtime";
import { db } from "../db/client.js";
import {
  interactiveSessions,
  localHosts,
  localTerminals,
  persistentAgents,
  prReviews,
  repoPods,
  sessionChatEvents,
  taskEvents,
  taskLogs,
  users,
  workspaceMembers,
} from "../db/schema.js";
import { createApiKey } from "../services/api-key-service.js";
import {
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import {
  listenWsApp,
  WsTestClient,
  type WsFrame as Frame,
} from "../test-utils/integration/ws-client.js";
import { _getConnectionCounts } from "./ws-limits.js";
import { eventsWs } from "./events.js";
import { logStreamWs } from "./log-stream.js";
import { workflowRunLogStreamWs } from "./workflow-run-log-stream.js";
import { prReviewLogStreamWs } from "./pr-review-log-stream.js";
import { persistentAgentStreamWs } from "./persistent-agent-stream.js";
import { localDaemonWs } from "./local-daemon.js";
import { localTerminalStreamWs } from "./local-terminal-stream.js";
import { sessionChatWs } from "./session-chat.js";
import { sessionTerminalWs } from "./session-terminal.js";
import { optioChatWs } from "./optio-chat.js";

// ─── Instrumentation ─────────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => {
  // Before logger.ts is imported: keep the handlers' info logs out of the run.
  process.env.LOG_LEVEL ??= "warn";
  return {
    subscribers: { created: 0, disconnected: 0 },
    shells: [] as Array<{ events: string[]; closed: boolean }>,
  };
});

// Count Redis subscribers so a leaked one (created, never disconnected) shows.
vi.mock("../services/event-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/event-bus.js")>();
  return {
    ...actual,
    createSubscriber: () => {
      hoisted.subscribers.created++;
      const sub = actual.createSubscriber();
      const disconnect = sub.disconnect.bind(sub);
      sub.disconnect = (...args: Parameters<typeof sub.disconnect>) => {
        hoisted.subscribers.disconnected++;
        return disconnect(...args);
      };
      return sub;
    },
  };
});

// Session chat execs play `claude -p` on the fake runtime; session terminal
// execs (tty) get a shell that records its stdin and resizes and stays open.
vi.mock("../services/container-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/container-service.js")>();
  const { FakeContainerRuntime } = await import("@optio/container-runtime");
  const fake = new FakeContainerRuntime();
  const runtime = {
    exec: async (...args: Parameters<ContainerRuntime["exec"]>) => {
      if (!args[2]?.tty) return fake.exec(...args);
      const shell = { events: [] as string[], closed: false };
      hoisted.shells.push(shell);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return {
        stdin: new Writable({
          write(chunk: Buffer, _enc, cb) {
            shell.events.push(`stdin:${chunk.toString()}`);
            cb();
          },
        }),
        stdout,
        stderr,
        resize: (cols: number, rows: number) => shell.events.push(`resize:${cols}x${rows}`),
        close: () => {
          shell.closed = true;
          stdout.end();
          stderr.end();
        },
      };
    },
  };
  return { ...actual, getRuntime: () => runtime };
});

// ─── Harness ─────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let wsBase = "";
let token = "";
let userId = "";
let workspaceId = "";
let redis: Redis;
const savedAuthDisabled = process.env.OPTIO_AUTH_DISABLED;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | Promise<T>, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

const openConnections = () => [..._getConnectionCounts().values()].reduce((a, b) => a + b, 0);

/**
 * Hold ACCESS EXCLUSIVE on a table until release(): every query touching it
 * (authenticateWs's PAT lookup on `api_keys`, the chat history replay on
 * `session_chat_events`) blocks meanwhile.
 */
async function lockTable(table: "api_keys" | "session_chat_events") {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let acquired!: () => void;
  const isAcquired = new Promise<void>((r) => (acquired = r));
  const tx = sql.begin(async (t) => {
    await t.unsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    acquired();
    await released;
  });
  await isAcquired;
  return {
    release: async () => {
      release();
      await tx;
      await sql.end();
    },
  };
}

/** A client of this file's app, authenticated with the test PAT unless `auth: false`. */
class Client extends WsTestClient {
  constructor(path: string, opts: { auth?: boolean; onOpen?: (c: Client) => void } = {}) {
    super(`${wsBase}${path}`, {
      token: opts.auth === false ? undefined : token,
      onOpen: opts.onOpen as ((c: WsTestClient) => void) | undefined,
    });
  }
}

/** The daemon side of a paired machine: a Client that remembers frame order. */
async function connectDaemon(hostId: string, terminalIds: string[]): Promise<Client> {
  const daemon = new Client("/ws/local/daemon", {
    onOpen: (c) => {
      c.send({
        type: "hello",
        hostId,
        daemonVersion: "0.0.0-it",
        dirs: [{ path: "/tmp/it" }],
        terminals: terminalIds.map((terminalId) => ({ terminalId, running: true })),
        claudeCredentials: false,
      });
      c.send({ type: "ping" });
    },
  });
  await daemon.next((f) => f.type === "pong");
  return daemon;
}

async function seedLocal() {
  const [host] = await db
    .insert(localHosts)
    .values({
      userId,
      workspaceId,
      name: "it laptop",
      hostname: `it-${randomBytes(3).toString("hex")}`,
      platform: "darwin",
      dirs: [{ path: "/tmp/it" }],
    })
    .returning();
  const [terminal] = await db
    .insert(localTerminals)
    .values({
      hostId: host.id,
      userId,
      workspaceId,
      title: "it shell",
      dir: "/tmp/it",
      spec: { kind: "shell" },
      state: "running",
      startedAt: new Date(),
    })
    .returning();
  return { host, terminal };
}

async function seedSession(opts: { userId: string | null; history?: string[] }) {
  const repoUrl = `https://github.com/it-org/ws-${randomBytes(3).toString("hex")}`;
  const [pod] = await db
    .insert(repoPods)
    .values({ repoUrl, workspaceId, podName: "it-pod", podId: "it-pod", state: "ready" })
    .returning();
  const [session] = await db
    .insert(interactiveSessions)
    .values({
      repoUrl,
      userId: opts.userId,
      workspaceId: opts.userId ? workspaceId : null,
      branch: "session/it/1",
      worktreePath: "/workspace/sessions/it",
      podId: pod.id,
    })
    .returning();
  for (const content of opts.history ?? []) {
    await db.insert(sessionChatEvents).values({ sessionId: session.id, content, logType: "text" });
  }
  return session;
}

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";

  const ws = await insertWorkspace();
  workspaceId = ws.id;
  const [user] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `ws-it-${randomBytes(4).toString("hex")}`,
      email: "ws@early.it",
      displayName: "WS early",
      defaultWorkspaceId: ws.id,
    })
    .returning();
  userId = user.id;
  await db.insert(workspaceMembers).values({ workspaceId, userId, role: "member" });
  token = (await createApiKey(userId, "ws early frames")).token;

  ({ app, wsBase } = await listenWsApp([
    eventsWs,
    logStreamWs,
    workflowRunLogStreamWs,
    prReviewLogStreamWs,
    persistentAgentStreamWs,
    localDaemonWs,
    localTerminalStreamWs,
    sessionChatWs,
    sessionTerminalWs,
    optioChatWs,
  ]));
  redis = new Redis(process.env.REDIS_URL!);
});

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  if (savedAuthDisabled === undefined) delete process.env.OPTIO_AUTH_DISABLED;
  else process.env.OPTIO_AUTH_DISABLED = savedAuthDisabled;
});

// ─── Frames sent before auth completes ───────────────────────────────────────

describe("frames sent the instant the socket opens (auth enabled)", () => {
  it("local daemon: hello and ping are handled once the PAT lookup finishes", async () => {
    const { host, terminal } = await seedLocal();
    const lock = await lockTable("api_keys");
    const daemon = new Client("/ws/local/daemon", {
      onOpen: (c) => {
        c.send({
          type: "hello",
          hostId: host.id,
          daemonVersion: "0.0.0-it",
          dirs: [{ path: "/tmp/it" }],
          terminals: [{ terminalId: terminal.id, running: true }],
          claudeCredentials: false,
        });
        c.send({ type: "ping" });
      },
    });
    await daemon.opened;
    await sleep(150);
    expect(daemon.frames).toEqual([]); // still authenticating: nothing handled yet

    await lock.release();
    await daemon.next((f) => f.type === "pong");
    const [row] = await db.select().from(localHosts).where(eq(localHosts.id, host.id));
    expect(row.state).toBe("online");
    await daemon.close();
  });

  it("local terminal stream: the first resize and keystrokes reach the daemon, after attach", async () => {
    const { host, terminal } = await seedLocal();
    const daemon = await connectDaemon(host.id, [terminal.id]);

    const lock = await lockTable("api_keys");
    const viewer = new Client(`/ws/local/terminals/${terminal.id}/stream`, {
      onOpen: (c) => {
        c.send({ type: "resize", cols: 132, rows: 40 });
        c.send({ type: "input", data: "echo early\r" });
      },
    });
    await viewer.opened;
    await sleep(150);
    await lock.release();

    await viewer.next((f) => f.type === "status" && f.state === "running");
    const attach = await daemon.next((f) => f.type === "attach");
    const resize = await daemon.next((f) => f.type === "resize");
    const input = await daemon.next((f) => f.type === "input");
    expect(attach.terminalId).toBe(terminal.id);
    expect(resize).toMatchObject({ terminalId: terminal.id, cols: 132, rows: 40 });
    expect(Buffer.from(input.dataB64, "base64").toString()).toBe("echo early\r");

    await viewer.close();
    await daemon.close();
  });

  it("optio chat: a prompt sent on open is answered", async () => {
    const lock = await lockTable("api_keys");
    const chat = new Client("/ws/optio/chat", {
      onOpen: (c) => c.send({ type: "message", content: "list my tasks" }),
    });
    await chat.opened;
    await sleep(150);
    expect(chat.frames).toEqual([]);
    await lock.release();

    await chat.next((f) => f.type === "status" && f.status === "ready");
    await chat.next((f) => f.type === "status" && f.status === "thinking");
    // No Anthropic credentials in this database: the prompt was processed and
    // refused, which is all this test needs to see (no network call).
    const error = await chat.next((f) => f.type === "error");
    expect(error.message).toMatch(/No Anthropic credentials configured/);
    await chat.close();
  });

  it("session terminal: the first resize and keystrokes reach the shell, in order", async () => {
    const session = await seedSession({ userId });
    const lock = await lockTable("api_keys");
    const shellsBefore = hoisted.shells.length;
    const term = new Client(`/ws/sessions/${session.id}/terminal`, {
      onOpen: (c) => {
        c.send({ type: "resize", cols: 120, rows: 36 });
        c.ws.send("ls -la\n");
      },
    });
    await term.opened;
    await sleep(150);
    await lock.release();

    const shell = await waitFor(() => hoisted.shells[shellsBefore], "the session shell");
    await waitFor(() => shell.events.length >= 2, "early frames at the shell");
    expect(shell.events).toEqual(["resize:120x36", "stdin:ls -la\n"]);
    await term.close();
    await waitFor(() => shell.closed, "shell closed with the socket");
  });

  it("session chat: a prompt sent on open runs after the history replay", async () => {
    const session = await seedSession({ userId, history: ["earlier reply", "another reply"] });
    const lock = await lockTable("api_keys");
    const chat = new Client(`/ws/sessions/${session.id}/chat`, {
      onOpen: (c) => c.send({ type: "message", content: "what changed?" }),
    });
    await chat.opened;
    await sleep(150);
    await lock.release();

    await chat.next((f) => f.type === "status" && f.status === "ready");
    const replayed = [
      await chat.next((f) => f.type === "chat_event"),
      await chat.next((f) => f.type === "chat_event"),
    ];
    expect(replayed.map((f) => [f.catchUp, f.event.content])).toEqual([
      [true, "earlier reply"],
      [true, "another reply"],
    ]);
    expect(await chat.next((f) => f.type === "history_done")).toEqual({
      type: "history_done",
      count: 2,
    });
    await chat.next((f) => f.type === "status" && f.status === "thinking");
    const live = await chat.next((f) => f.type === "chat_event");
    expect(live.catchUp).toBeUndefined();
    await chat.next((f) => f.type === "status" && f.status === "idle");
    await chat.close();
  });
});

// ─── Session chat: a prompt right after `ready`, during the replay ───────────

describe("session chat prompt sent right after ready", () => {
  for (const mode of ["auth enabled", "auth disabled"] as const) {
    it(`is handled after the replay, not dropped (${mode})`, async () => {
      if (mode === "auth disabled") process.env.OPTIO_AUTH_DISABLED = "true";
      try {
        const session = await seedSession({
          // Auth-disabled dev has no user rows (the dev user owns legacy sessions).
          userId: mode === "auth enabled" ? userId : null,
          history: ["history row"],
        });
        // Block the replay so the prompt provably lands in the middle of it.
        const lock = await lockTable("session_chat_events");
        const chat = new Client(`/ws/sessions/${session.id}/chat`, {
          auth: mode === "auth enabled",
        });
        const ready = await chat.next((f) => f.type === "status" && f.status === "ready");
        expect(ready.model).toBeTruthy();
        chat.send({ type: "message", content: "hello right after ready" });
        await sleep(150);
        expect(chat.frames.map((f) => f.type)).toEqual(["status"]); // replay still blocked
        await lock.release();

        expect((await chat.next((f) => f.type === "history_done")).count).toBe(1);
        await chat.next((f) => f.type === "status" && f.status === "thinking");
        await chat.next((f) => f.type === "chat_event" && !f.catchUp);
        await chat.next((f) => f.type === "status" && f.status === "idle");
        await chat.close();

        // The prompt is persisted (fire-and-forget) after the replay read the
        // history, so it is stored once and was not part of this replay.
        const prompts = async () =>
          (
            await db
              .select()
              .from(sessionChatEvents)
              .where(eq(sessionChatEvents.sessionId, session.id))
          ).filter((r) => r.content === "hello right after ready");
        await waitFor(async () => (await prompts()).length > 0, "the persisted prompt");
        expect(await prompts()).toHaveLength(1);
      } finally {
        process.env.OPTIO_AUTH_DISABLED = "false";
      }
    });
  }
});

// ─── A client that leaves during auth ────────────────────────────────────────

describe("a client that leaves while it is being authenticated", () => {
  const streams: Array<{ name: string; path: () => Promise<string>; publish: () => void }> = [];

  beforeAll(async () => {
    const task = await insertTask({ workspaceId, title: "ws it task", state: "running" });
    await db.insert(taskEvents).values({
      taskId: task.id,
      fromState: "queued",
      toState: "running",
      trigger: "it",
    });
    await db.insert(taskLogs).values({ taskId: task.id, content: "catch-up log line" });
    const workflow = await insertWorkflow({ workspaceId, name: "ws it job" });
    const run = await insertWorkflowRun(workflow.id, { state: "running" });
    const [review] = await db
      .insert(prReviews)
      .values({
        workspaceId,
        prUrl: "https://github.com/it-org/ws/pull/1",
        prNumber: 1,
        repoOwner: "it-org",
        repoName: "ws",
        repoUrl: "https://github.com/it-org/ws",
        headSha: "abc123",
      })
      .returning();
    const [agent] = await db
      .insert(persistentAgents)
      .values({ workspaceId, slug: "ws-it", name: "ws it", initialPrompt: "wait" })
      .returning();

    const pub = (channel: string, event: Frame) => () =>
      void redis.publish(channel, JSON.stringify(event));
    streams.push(
      {
        name: "events",
        path: async () => "/ws/events",
        publish: pub("optio:events", { type: "task:state_changed", taskId: task.id }),
      },
      {
        name: "task logs",
        path: async () => `/ws/logs/${task.id}`,
        publish: pub(`optio:task:${task.id}`, { type: "task:log", taskId: task.id }),
      },
      {
        name: "workflow run logs",
        path: async () => `/ws/workflow-runs/${run.id}/logs`,
        publish: pub(`optio:workflow-run:${run.id}`, {
          type: "workflow_run:log",
          workflowRunId: run.id,
        }),
      },
      {
        name: "pr review logs",
        path: async () => `/ws/pr-reviews/${review.id}/logs`,
        publish: pub(`optio:pr-review:${review.id}`, {
          type: "pr_review:state_changed",
          prReviewId: review.id,
        }),
      },
      {
        name: "persistent agent events",
        path: async () => `/ws/persistent-agents/${agent.id}/events`,
        publish: pub(`optio:persistent-agent:${agent.id}`, {
          type: "persistent_agent:state_changed",
          agentId: agent.id,
        }),
      },
    );
  });

  it("read-only streams still authenticate, catch up, and stream live events", async () => {
    for (const stream of streams) {
      const client = new Client(await stream.path());
      await client.opened;
      const live = client.next((f) => !f.catchUp, 5_000);
      // Publish until the (asynchronous) Redis subscription picks it up.
      const timer = setInterval(stream.publish, 50);
      try {
        await live;
      } finally {
        clearInterval(timer);
      }
      await client.close();
    }
    await waitFor(() => openConnections() === 0, "every slot released");
    await waitFor(
      () => hoisted.subscribers.disconnected === hoisted.subscribers.created,
      "every subscriber disconnected",
    );
  });

  it("read-only streams: the slot is released and no subscriber is created", async () => {
    for (const stream of streams) {
      const created = hoisted.subscribers.created;
      const lock = await lockTable("api_keys");
      const client = new Client(await stream.path(), { onOpen: (c) => c.ws.close() });
      await client.closed;
      // Released while authentication is still blocked.
      await waitFor(() => openConnections() === 0, `${stream.name}: slot released`);
      await lock.release();
      await sleep(200); // the handler resumes after auth; it must stop there
      expect(hoisted.subscribers.created, stream.name).toBe(created);
      expect(openConnections(), stream.name).toBe(0);
    }
  });

  it("optio chat: the one-conversation slot is not taken by the departed client", async () => {
    const lock = await lockTable("api_keys");
    const gone = new Client("/ws/optio/chat", { onOpen: (c) => c.ws.close() });
    await gone.closed;
    await lock.release();
    await sleep(200);

    const next = new Client("/ws/optio/chat");
    const first = await next.next((f) => f.type === "status" || f.type === "error");
    expect(first).toMatchObject({ type: "status", status: "ready" });
    await next.close();
    await waitFor(() => openConnections() === 0, "slots released");
  });

  it("session terminal: no shell is left running for the departed client", async () => {
    const session = await seedSession({ userId });
    const shellsBefore = hoisted.shells.length;
    const lock = await lockTable("api_keys");
    const gone = new Client(`/ws/sessions/${session.id}/terminal`, {
      onOpen: (c) => c.ws.close(),
    });
    await gone.closed;
    await lock.release();
    await sleep(200);
    // Either no shell was started, or the one that was is closed.
    expect(hoisted.shells.slice(shellsBefore).every((s) => s.closed)).toBe(true);
    await waitFor(() => openConnections() === 0, "slots released");
  });
});
