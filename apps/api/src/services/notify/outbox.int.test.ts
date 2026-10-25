/**
 * The delivery queue (services/notify/outbox.ts, workers/notify-worker.ts)
 * against real Postgres and Redis, with the real BullMQ worker and a
 * backoff of milliseconds: a relay outage is retried until it passes; tries
 * that run out, or a refusal for good, leave a dead letter a deployment
 * admin retries; a job Redis lost is queued again from its row.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { notifyOutbox, notifySmtpSettings, users, workspaceMembers } from "../../db/schema.js";
import { insertWorkspace } from "../../test-utils/integration/fixtures.js";
import { startNotifyWorker, type NotifyWorkers } from "../../workers/notify-worker.js";
import { notify } from "../notify.js";
import {
  createMemoryChatTransport,
  setChatTransportForTests,
  setPersonalHook,
} from "./chat-hooks.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "./email.js";
import {
  deliver,
  discardDeadLetters,
  listDeadLetters,
  outboxActive,
  outboxCounts,
  processOutboxRow,
  recoverOutbox,
  retryDeadLetters,
} from "./outbox.js";

const uniq = () => randomBytes(4).toString("hex");
const mail = createMemoryEmailTransport();
const chat = createMemoryChatTransport();
let worker: NotifyWorkers | null = null;

async function person(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `${name}-${uniq()}@example.test`,
      displayName: name,
    })
    .returning();
  return row;
}

async function member(name: string) {
  const ws = await insertWorkspace();
  const p = await person(name);
  await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: p.id, role: "member" });
  return { ws, p };
}

async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const rowOf = async (id: string) =>
  (await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, id)))[0] ?? null;

/** The outbox rows for `to`, newest last. */
async function rowsTo(userId: string) {
  return db.select().from(notifyOutbox).where(eq(notifyOutbox.userId, userId));
}

/** A transport that fails the first `n` sends with `error`, then delivers. */
function failFirst(n: number, error: string) {
  let left = n;
  const real = mail.send.bind(mail);
  return {
    async send(...args: Parameters<typeof mail.send>) {
      if (left > 0) {
        left--;
        throw new Error(error);
      }
      return real(...args);
    },
  };
}

beforeAll(() => {
  vi.stubEnv("OPTIO_NOTIFY_RETRY_ATTEMPTS", "3");
  vi.stubEnv("OPTIO_NOTIFY_RETRY_BASE_SECONDS", "0.05");
  vi.stubEnv("OPTIO_NOTIFY_TICK_MS", "3600000");
  setChatTransportForTests(chat);
  worker = startNotifyWorker();
});
afterAll(async () => {
  await worker?.close();
  setEmailTransportForTests(null);
  setChatTransportForTests(null);
});
beforeEach(async () => {
  mail.sent.length = 0;
  mail.failWith(null);
  chat.posts.length = 0;
  chat.failWith(null);
  setEmailTransportForTests(mail);
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "optio@example.test");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
  await db.delete(notifySmtpSettings);
});

describe("the delivery queue", () => {
  it("is on while the worker runs: notify() queues, the worker delivers", async () => {
    expect(outboxActive()).toBe(true);
    const { ws, p } = await member("queued");
    const r = await notify({
      kind: "budget.warning",
      toUserIds: [p.id],
      workspaceId: ws.id,
      subject: "Your key used 80%",
      body: "80 of 100 USD.",
    });
    expect(r.sent).toEqual([p.id]);
    await waitFor("the email", async () => mail.sent.find((m) => m.to[0] === p.email));
    // Delivered rows go.
    await waitFor("the row to go", async () => (await rowsTo(p.id)).length === 0);
  });

  it("retries through a relay outage with backoff, and delivers once", async () => {
    const { ws, p } = await member("outage");
    setEmailTransportForTests(
      failFirst(2, "Could not reach the relay relay.example.test:25 (ECONNREFUSED)"),
    );
    const r = await notify({
      kind: "token.expiring",
      toUserIds: [p.id],
      workspaceId: ws.id,
      subject: "Your GitLab token expires in 7 days",
      body: "Renew it.",
    });
    expect(r.sent).toEqual([p.id]);
    await waitFor("the email after two failures", async () =>
      mail.sent.find((m) => m.to[0] === p.email),
    );
    expect(mail.sent.filter((m) => m.to[0] === p.email)).toHaveLength(1);
    await waitFor("the row to go", async () => (await rowsTo(p.id)).length === 0);
  });

  it("keeps a dead letter when the tries run out; a deployment admin's retry delivers it", async () => {
    const { ws, p } = await member("dead");
    mail.failWith("Could not reach the relay relay.example.test:25 (ETIMEDOUT)");
    await notify({
      kind: "token.invalid",
      toUserIds: [p.id],
      workspaceId: ws.id,
      subject: "Your gateway token was refused",
      body: "Replace it.",
    });
    const [dead] = await waitFor("the dead letter", async () => {
      const rows = await rowsTo(p.id);
      return rows.length && rows[0].status === "dead" ? rows : null;
    });
    expect(dead.attempts).toBe(3);
    expect(dead.lastError).toMatch(/ETIMEDOUT/);
    expect(mail.sent).toHaveLength(0);

    const listed = (await listDeadLetters()).find((d) => d.id === dead.id);
    expect(listed).toMatchObject({
      channel: "email",
      kind: "token.invalid",
      summary: "[Optio] Your gateway token was refused",
      to: p.email,
      attempts: 3,
    });
    expect((await outboxCounts()).dead).toBeGreaterThanOrEqual(1);

    mail.failWith(null);
    expect(await retryDeadLetters([dead.id])).toBe(1);
    await waitFor("the retried email", async () => mail.sent.find((m) => m.to[0] === p.email));
    await waitFor("the row to go", async () => !(await rowOf(dead.id)));
  });

  it("gives up at once when the relay refuses every recipient for good (5xx)", async () => {
    const { ws, p } = await member("refused");
    mail.failWith(
      `The relay refused every recipient: ${"x"}@example.test (550 5.1.1 no such user)`,
    );
    await notify({
      kind: "budget.exceeded",
      toUserIds: [p.id],
      workspaceId: ws.id,
      subject: "Your key used its whole budget",
      body: "100 of 100 USD.",
    });
    const [dead] = await waitFor("the dead letter", async () => {
      const rows = await rowsTo(p.id);
      return rows.length && rows[0].status === "dead" ? rows : null;
    });
    expect(dead.attempts).toBe(1);
    expect(await discardDeadLetters([dead.id])).toBe(1);
    expect(await rowOf(dead.id)).toBeNull();
  });

  it("retries a chat hook that answers 503, and gives up on one that answers 404", async () => {
    const { ws, p } = await member("chatty");
    await setPersonalHook(p.id, {
      url: "https://chat.example.test/hooks/chatty",
      format: "mattermost",
    });
    vi.stubEnv("OPTIO_SMTP_URL", ""); // chat only
    let calls = 0;
    setChatTransportForTests({
      async post(url, body) {
        calls++;
        if (calls === 1) return { status: 503, text: "busy" };
        return chat.post(url, body);
      },
    });
    const r = await notify({
      kind: "user.offboarded",
      toUserIds: [p.id],
      workspaceId: ws.id,
      subject: "Carol can no longer use Optio",
      body: "Their automations were paused.",
    });
    expect(r).toMatchObject({ sent: [p.id], chat: [p.id] });
    const got = await waitFor("the chat post", async () => chat.posts[0]);
    expect(got.url).toBe("https://chat.example.test/hooks/chatty");
    expect(String(got.body.text)).toMatch(/Carol can no longer use Optio/);
    expect(calls).toBe(2);

    setChatTransportForTests(chat);
    chat.failWith(404);
    await notify({
      kind: "user.offboarded",
      toUserIds: [p.id],
      workspaceId: ws.id,
      subject: "Dave can no longer use Optio",
      body: "…",
    });
    const [dead] = await waitFor("the dead chat letter", async () => {
      const rows = (await rowsTo(p.id)).filter((x) => x.status === "dead");
      return rows.length ? rows : null;
    });
    expect(dead).toMatchObject({ channel: "chat", attempts: 1 });
    expect(dead.lastError).toMatch(/HTTP 404/);
    // The URL is never copied into the outbox: the hook is looked up when sent.
    expect(JSON.stringify(dead.payload)).not.toContain("chat.example.test");
    const listed = (await listDeadLetters()).find((d) => d.id === dead.id);
    expect(listed?.to).toBe("chatty's chat hook");
    await discardDeadLetters([dead.id]);
  });

  it("queues again a pending row whose job was lost (a Redis restart)", async () => {
    const { p } = await member("lost");
    const [row] = await db
      .insert(notifyOutbox)
      .values({
        channel: "email",
        kind: "token.expiring",
        userId: p.id,
        summary: "lost",
        payload: { email: { to: [p.email], subject: "[Optio] lost", text: "found again" } },
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning();
    const r = await recoverOutbox();
    expect(r.requeued).toBeGreaterThanOrEqual(1);
    await waitFor("the recovered email", async () =>
      mail.sent.find((m) => m.subject === "[Optio] lost"),
    );
    await waitFor("the row to go", async () => !(await rowOf(row.id)));
  });

  it("drops dead letters past their keeping time", async () => {
    const { p } = await member("old");
    const [row] = await db
      .insert(notifyOutbox)
      .values({
        channel: "email",
        kind: "x",
        userId: p.id,
        summary: "old",
        payload: { email: { to: [p.email], subject: "old", text: "old" } },
        status: "dead",
        deadAt: new Date(Date.now() - 40 * 86_400_000),
      })
      .returning();
    const r = await recoverOutbox();
    expect(r.purged).toBeGreaterThanOrEqual(1);
    expect(await rowOf(row.id)).toBeNull();
  });

  it("delivers nothing, and keeps nothing, for a hook removed while it waited", async () => {
    const { p } = await member("removed");
    const [row] = await db
      .insert(notifyOutbox)
      .values({
        channel: "chat",
        kind: "task.failed",
        userId: p.id,
        summary: "gone",
        payload: {
          target: { userId: p.id },
          message: { type: "notice", subject: "gone", body: "gone" },
        },
      })
      .returning();
    expect(await processOutboxRow(row.id)).toEqual({ outcome: "delivered" });
    expect(chat.posts).toHaveLength(0);
    expect(await rowOf(row.id)).toBeNull();
  });

  it("reports a store failure without throwing", async () => {
    const r = await deliver({
      channel: "email",
      kind: "x",
      // Not a person: the foreign key refuses the row.
      userId: "00000000-0000-0000-0000-000000000000",
      email: { to: ["x@example.test"], subject: "s", text: "t" },
    });
    expect(r.ok).toBe(false);
  });
});
