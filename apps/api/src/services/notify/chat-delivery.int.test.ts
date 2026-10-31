/**
 * A person's own chat hook (services/notify/chat-hooks.ts, fanout.ts,
 * outbox.ts) against real Postgres: work events and `notify()` reach the
 * hook as its owner chose, only for work they may see; a disabled person's
 * hook gets nothing, whether they were disabled before the post was queued
 * or after; a queued post keeps the message and the first line of a
 * failure, never the hook's URL; refusals retry or go dead within the
 * outbox's bounds.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  notifyChatHooks,
  notifyOutbox,
  notifySmtpSettings,
  users,
  workspaceMembers,
} from "../../db/schema.js";
import { insertTask, insertWorkspace } from "../../test-utils/integration/fixtures.js";
import { notify } from "../notify.js";
import {
  createMemoryChatTransport,
  getPersonalHook,
  hookUrlOf,
  setChatTransportForTests,
  setPersonalHook,
} from "./chat-hooks.js";
import { notifyWorkEvent } from "./dispatch.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "./email.js";
import {
  closeOutboxQueue,
  deliver,
  listDeadLetters,
  processOutboxRow,
  setOutboxActive,
} from "./outbox.js";
import { updateChannelChoices } from "./preferences.js";

const uniq = () => randomBytes(4).toString("hex");
const mail = createMemoryEmailTransport();
const chat = createMemoryChatTransport();

async function person(name: string, emailVerified = true) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `${name}-${uniq()}@example.test`,
      displayName: name,
      emailVerified,
    })
    .returning();
  return row;
}

const hookOf = (name: string) => `https://chat.example.test/hooks/${name}-${uniq()}`;

async function setup() {
  const ws = await insertWorkspace();
  const [owner, other] = await Promise.all(["owner", "other"].map((n) => person(n)));
  await db.insert(workspaceMembers).values([
    { workspaceId: ws.id, userId: owner.id, role: "member" },
    { workspaceId: ws.id, userId: other.id, role: "member" },
  ]);
  const hooks = { owner: hookOf("owner"), other: hookOf("other") };
  await setPersonalHook(owner.id, { url: hooks.owner, format: "mattermost" });
  await setPersonalHook(other.id, { url: hooks.other, format: "mattermost" });
  return { ws, owner, other, hooks };
}

beforeAll(() => {
  setEmailTransportForTests(mail);
  setChatTransportForTests(chat);
});
afterAll(async () => {
  setOutboxActive(false);
  await closeOutboxQueue();
  setEmailTransportForTests(null);
  setChatTransportForTests(null);
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  mail.sent.length = 0;
  chat.posts.length = 0;
  chat.failWith(null);
  setOutboxActive(false);
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "optio@example.test");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
  await db.delete(notifySmtpSettings);
});

describe("a person's own chat hook", () => {
  it("seals the URL, shows only a hint, and keeps it on a save without one", async () => {
    const p = await person("sealed");
    await setPersonalHook(p.id, {
      url: "https://chat.example.test/hooks/abcdefgh1234",
      format: "mattermost",
    });
    const [row] = await db
      .select()
      .from(notifyChatHooks)
      .where(eq(notifyChatHooks.ownerUserId, p.id));
    expect(row.urlHint).toBe("https://chat.example.test/hooks/…1234");
    expect(Buffer.from(row.encryptedUrl).toString("utf8")).not.toContain("abcdefgh1234");
    expect(hookUrlOf(row)).toBe("https://chat.example.test/hooks/abcdefgh1234");
    await setPersonalHook(p.id, { format: "msteams" });
    const kept = (await getPersonalHook(p.id))!;
    expect(kept.format).toBe("msteams");
    expect(hookUrlOf(kept)).toBe("https://chat.example.test/hooks/abcdefgh1234");
  });

  it("can't open a sealed URL under another row's id", async () => {
    const a = await person("a");
    const b = await person("b");
    await setPersonalHook(a.id, { url: hookOf("a"), format: "mattermost" });
    await setPersonalHook(b.id, { url: hookOf("b"), format: "mattermost" });
    const rowA = (await getPersonalHook(a.id))!;
    const rowB = (await getPersonalHook(b.id))!;
    // A ciphertext copied onto another row fails its AAD check.
    expect(() => hookUrlOf({ ...rowB, encryptedUrl: rowA.encryptedUrl })).toThrow();
  });
});

describe("work events on a person's hook", () => {
  it("posts a failed Task to its owner's hook and email, and nobody else's", async () => {
    const s = await setup();
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      createdBy: s.owner.id,
      title: "Fix the login page",
      state: "failed",
      errorMessage: "tests failed\nstderr: TOKEN=abc123",
    });
    const out = await notifyWorkEvent(task.id, "failed");
    expect(out.sent).toEqual([s.owner.id]);
    expect(out.chat).toEqual([s.owner.id]);
    expect(chat.posts.map((p) => p.url)).toEqual([s.hooks.owner]);
    const text = String(chat.posts[0].body.text);
    expect(text).toMatch(/Task failed/);
    expect(text).toContain(`https://optio.example.test/work/${task.id}`);
    expect(text).toContain("tests failed");
    expect(text).not.toContain("TOKEN=abc123");
    expect(mail.sent.map((m) => m.to[0])).toEqual([s.owner.email]);
  });

  it("follows the person's chat choice per event, apart from email", async () => {
    const s = await setup();
    await updateChannelChoices(s.owner.id, { chat: { "task.failed": false } });
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      createdBy: s.owner.id,
      state: "failed",
    });
    const out = await notifyWorkEvent(task.id, "failed");
    expect(out.sent).toEqual([s.owner.id]);
    expect(out.chat).toBeUndefined();
    expect(chat.posts).toEqual([]);
    expect(mail.sent).toHaveLength(1);
  });

  it("reaches someone with a hook but no verified address, by chat only", async () => {
    const ws = await insertWorkspace();
    const p = await person("unverified", false);
    await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: p.id, role: "member" });
    const url = hookOf("unverified");
    await setPersonalHook(p.id, { url, format: "mattermost" });
    const task = await insertTask({
      workspaceId: ws.id,
      ownerUserId: p.id,
      createdBy: p.id,
      state: "failed",
    });
    const out = await notifyWorkEvent(task.id, "failed");
    expect(out.chat).toEqual([p.id]);
    expect(chat.posts.map((x) => x.url)).toEqual([url]);
    expect(mail.sent).toEqual([]);
  });

  it("works with chat alone, no relay set", async () => {
    vi.stubEnv("OPTIO_SMTP_URL", "");
    const s = await setup();
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      createdBy: s.owner.id,
      state: "failed",
    });
    const out = await notifyWorkEvent(task.id, "failed");
    expect(out.chat).toEqual([s.owner.id]);
    expect(mail.sent).toEqual([]);
  });
});

describe("notices on a person's hook", () => {
  it("posts a notice to the addressed member's hook, never to a nonmember's", async () => {
    const s = await setup();
    const outsider = await person("outsider");
    const url = hookOf("outsider");
    await setPersonalHook(outsider.id, { url, format: "mattermost" });
    const res = await notify({
      kind: "user.offboarded",
      toUserIds: [s.owner.id, outsider.id],
      workspaceId: s.ws.id,
      subject: "Someone left",
      body: "Their automations were paused.",
    });
    expect(res.chat).toEqual([s.owner.id]);
    expect(chat.posts.map((p) => p.url)).toEqual([s.hooks.owner]);
  });
});

describe("a disabled person's hook", () => {
  it("is left out when a message is chosen, even a forced one", async () => {
    const s = await setup();
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, s.owner.id));
    const res = await notify({
      kind: "user.offboarded",
      toUserIds: [s.owner.id],
      workspaceId: s.ws.id,
      subject: "s",
      body: "b",
      force: true,
    });
    expect(res.sent).toEqual([]);
    expect(chat.posts).toEqual([]);
  });

  it("gets nothing from a post queued before they were disabled", async () => {
    const s = await setup();
    setOutboxActive(true);
    expect(
      await deliver({
        channel: "chat",
        kind: "task.failed",
        userId: s.owner.id,
        workspaceId: s.ws.id,
        message: { type: "notice", subject: "Queued", body: "Private" },
      }),
    ).toEqual({ ok: true, queued: true });
    const [row] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.userId, s.owner.id));
    // The row holds the message, never the hook's URL.
    expect(JSON.stringify(row.payload)).not.toContain(s.hooks.owner);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, s.owner.id));
    expect(await processOutboxRow(row.id)).toEqual({
      outcome: "dropped",
      error: "the recipient's chat hook is off or gone",
    });
    expect(chat.posts).toEqual([]);
  });

  it("drops a queued post whose hook was removed meanwhile", async () => {
    const s = await setup();
    setOutboxActive(true);
    await deliver({
      channel: "chat",
      kind: "task.failed",
      userId: s.owner.id,
      message: { type: "notice", subject: "Queued", body: "b" },
    });
    const [row] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.userId, s.owner.id));
    await setPersonalHook(s.owner.id, { enabled: false });
    expect((await processOutboxRow(row.id)).outcome).toBe("dropped");
    expect(chat.posts).toEqual([]);
  });
});

describe("refusals and retries", () => {
  it("retries a 5xx and gives up at once on a 4xx, naming whose hook it was", async () => {
    const s = await setup();
    setOutboxActive(true);
    const queue = () =>
      deliver({
        channel: "chat",
        kind: "task.failed",
        userId: s.owner.id,
        message: { type: "notice", subject: `Queued ${uniq()}`, body: "b" },
      });
    await queue();
    let [row] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.userId, s.owner.id));
    chat.failWith(503);
    expect((await processOutboxRow(row.id)).outcome).toBe("retry");
    chat.failWith(404);
    const dead = await processOutboxRow(row.id);
    expect(dead.outcome).toBe("dead");
    expect(dead.error).toMatch(/HTTP 404/);
    [row] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, row.id));
    expect(row).toMatchObject({ status: "dead", attempts: 2 });
    const letters = await listDeadLetters(500);
    expect(letters.find((l) => l.id === row.id)).toMatchObject({
      channel: "chat",
      to: "owner's chat hook",
    });
    // The hook notes its last error for Settings.
    expect((await getPersonalHook(s.owner.id))!.lastError).toMatch(/HTTP 404/);
  });
});
