/**
 * Session chat cost is the session's running total. Each socket used to start
 * a fresh counter at 0 and write it over the stored cost, so a reconnect (or a
 * second tab) reset what the session had spent. Real Postgres, the real chat
 * handler, and the fake runtime playing `claude -p` turns
 * (`[[mock:cost:X]]` sets the turn's cost).
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { interactiveSessions, repoPods } from "../db/schema.js";
import { listenWsApp, WsTestClient, type WsFrame } from "../test-utils/integration/ws-client.js";
import { listSessionChatEvents } from "../services/interactive-session-service.js";
import { sessionChatWs } from "./session-chat.js";

vi.hoisted(() => {
  // Before container-service / logger load: play turns on the fake runtime.
  process.env.OPTIO_RUNTIME = "fake";
  process.env.OPTIO_ALLOW_FAKE_RUNTIME = "1";
  process.env.LOG_LEVEL ??= "warn";
});

let app: FastifyInstance;
let wsBase = "";
const savedAuthDisabled = process.env.OPTIO_AUTH_DISABLED;

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "true";
  ({ app, wsBase } = await listenWsApp([sessionChatWs]));
});

afterAll(async () => {
  await app?.close();
  if (savedAuthDisabled === undefined) delete process.env.OPTIO_AUTH_DISABLED;
  else process.env.OPTIO_AUTH_DISABLED = savedAuthDisabled;
});

async function seedSession(costUsd: string | null) {
  const repoUrl = `https://github.com/it-org/chat-${randomBytes(3).toString("hex")}`;
  const [pod] = await db
    .insert(repoPods)
    .values({ repoUrl, podName: "chat-pod", podId: "chat-pod", state: "ready" })
    .returning();
  const [session] = await db
    .insert(interactiveSessions)
    .values({ repoUrl, branch: "session/it/cost", podId: pod.id, costUsd })
    .returning();
  return session;
}

const storedCost = async (id: string) =>
  (await db.select().from(interactiveSessions).where(eq(interactiveSessions.id, id)))[0].costUsd;

/** Open the chat; resolves with the socket and its `ready` status frame. */
async function open(sessionId: string): Promise<{ chat: WsTestClient; ready: WsFrame }> {
  const chat = new WsTestClient(`${wsBase}/ws/sessions/${sessionId}/chat`);
  const ready = await chat.next((f) => f.type === "status" && f.status === "ready");
  await chat.next((f) => f.type === "history_done");
  return { chat, ready };
}

/** One prompt costing `cost`; resolves with the cost_update it produced. */
async function turn(chat: WsTestClient, cost: string): Promise<WsFrame> {
  chat.send({ type: "message", content: `do the thing [[mock:cost:${cost}]]` });
  const update = await chat.next((f) => f.type === "cost_update", 10_000);
  await chat.next((f) => f.type === "status" && f.status === "idle", 10_000);
  return update;
}

describe("session chat cost", () => {
  it("continues from the stored total after a reconnect", async () => {
    const session = await seedSession("1.5000");

    const first = await open(session.id);
    expect(first.ready.costUsd).toBe(1.5);
    expect((await turn(first.chat, "0.25")).costUsd).toBeCloseTo(1.75, 6);
    await first.chat.close();
    await vi.waitFor(async () => expect(await storedCost(session.id)).toBe("1.7500"));

    // A new socket reports what the session already cost, and adds to it.
    const second = await open(session.id);
    expect(second.ready.costUsd).toBe(1.75);
    expect((await turn(second.chat, "0.25")).costUsd).toBeCloseTo(2, 6);
    await second.chat.close();
    await vi.waitFor(async () => expect(await storedCost(session.id)).toBe("2.0000"));
  });

  it("adds every connection's turns to the stored total", async () => {
    const session = await seedSession(null);
    // Two tabs on one session: each turn adds, neither overwrites the other.
    const a = await open(session.id);
    const b = await open(session.id);
    await turn(a.chat, "0.25");
    await vi.waitFor(async () => expect(await storedCost(session.id)).toBe("0.2500"));
    await turn(b.chat, "0.5");
    await vi.waitFor(async () => expect(await storedCost(session.id)).toBe("0.7500"));
    await a.chat.close();
    await b.chat.close();
  });
});

describe("session chat history", () => {
  it("stores a turn in the order it streamed, so a replay reads the same", async () => {
    const session = await seedSession(null);
    const { chat } = await open(session.id);
    await turn(chat, "0.01");
    const streamed = chat.frames
      .filter((f) => f.type === "chat_event" && !f.catchUp)
      .map((f) => f.event.content as string);
    await chat.close();

    // The user's prompt first, then the agent's events in streaming order.
    await vi.waitFor(async () =>
      expect(await listSessionChatEvents(session.id)).toHaveLength(streamed.length + 1),
    );
    const stored = (await listSessionChatEvents(session.id)).map((e) => e.content);
    expect(stored).toEqual(["do the thing [[mock:cost:0.01]]", ...streamed]);
  });
});
