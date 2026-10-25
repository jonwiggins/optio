/**
 * The routes of routes/notify-delivery.ts through the real auth plugin and
 * real sessions, against real Postgres: a person's own chat hook (viewers
 * too), a team's channel (its admins and workspace admins only; another
 * workspace's team is a 404), the digest's "send me one now", and the
 * undelivered notifications (deployment admins only). Every refusal is
 * checked to have changed nothing.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  notifyChatHooks,
  notifyOutbox,
  notifySmtpSettings,
  optioActions,
  teamMembers,
  teams,
  users,
  workspaceMembers,
} from "../db/schema.js";
import authPlugin from "../plugins/auth.js";
import { createSession } from "../services/session-service.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  createMemoryChatTransport,
  getTeamChannel,
  hookUrlOf,
  setChatTransportForTests,
  setTeamChannel,
} from "../services/notify/chat-hooks.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "../services/notify/email.js";
import { notifyRoutes } from "./notify.js";
import { notifyDeliveryRoutes } from "./notify-delivery.js";

// These tests run with teams on (off by default).
vi.hoisted(() => {
  process.env.OPTIO_TEAMS_ENABLED = "true";
});

let app: FastifyInstance;
let workspaceId: string;
const mail = createMemoryEmailTransport();
const chat = createMemoryChatTransport();
const uniq = () => randomBytes(4).toString("hex");

async function signedIn(role: "viewer" | "member" | "admin", wsId = workspaceId) {
  const externalId = `nd-${uniq()}`;
  const { token, user } = await createSession("oidc", {
    externalId,
    email: `${externalId}@example.test`,
    displayName: externalId,
  });
  await db.insert(workspaceMembers).values({ workspaceId: wsId, userId: user.id, role });
  return {
    userId: user.id,
    email: `${externalId}@example.test`,
    headers: { authorization: `Bearer ${token}`, "x-workspace-id": wsId },
  };
}

/** The person's audit entries once `expected` are all written (auditing doesn't block the reply). */
async function auditOf(userId: string, expected: Array<Record<string, unknown>>) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const rows = await db
      .select({ action: optioActions.action, workspaceId: optioActions.workspaceId })
      .from(optioActions)
      .where(eq(optioActions.userId, userId));
    const all = expected.every((e) =>
      rows.some((r) => Object.entries(e).every(([k, v]) => r[k as keyof typeof r] === v)),
    );
    if (all || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function team(wsId = workspaceId) {
  const [row] = await db
    .insert(teams)
    .values({ workspaceId: wsId, name: `Team ${uniq()}`, slug: `team-${uniq()}` })
    .returning();
  return row;
}

beforeAll(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  setEmailTransportForTests(mail);
  setChatTransportForTests(chat);
  workspaceId = (await insertWorkspace()).id;
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(notifyRoutes);
  await app.register(notifyDeliveryRoutes);
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  setEmailTransportForTests(null);
  setChatTransportForTests(null);
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  mail.sent.length = 0;
  chat.posts.length = 0;
  chat.failWith(null);
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "optio@example.test");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
  await db.delete(notifySmtpSettings);
});

describe("my own chat hook", () => {
  it("a viewer sets, tests, reads (a hint only) and removes their own hook", async () => {
    const viewer = await signedIn("viewer");
    const url = "https://chat.example.test/hooks/viewer-own-9f3c";
    const saved = await app.inject({
      method: "PUT",
      url: "/api/notifications/chat-hook",
      headers: viewer.headers,
      payload: { url, format: "mattermost" },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().hook).toMatchObject({
      format: "mattermost",
      urlHint: "https://chat.example.test/hooks/…9f3c",
      enabled: true,
    });
    expect(saved.body).not.toContain("viewer-own");

    const test = await app.inject({
      method: "POST",
      url: "/api/notifications/chat-hook/test",
      headers: viewer.headers,
      payload: {},
    });
    expect(test.json()).toMatchObject({ ok: true, status: 200 });
    expect(chat.posts[0].url).toBe(url);
    expect(String(chat.posts[0].body.text)).toMatch(/Optio can post here/);

    const channels = await app.inject({
      method: "GET",
      url: "/api/notifications/channels",
      headers: viewer.headers,
    });
    expect(channels.json().chat.hook.urlHint).toBe("https://chat.example.test/hooks/…9f3c");
    expect(channels.json().choices.chat["task.failed"]).toBe(true);

    const choice = await app.inject({
      method: "PUT",
      url: "/api/notifications/channels",
      headers: viewer.headers,
      payload: { chat: { "task.failed": false } },
    });
    expect(choice.json().choices.chat["task.failed"]).toBe(false);

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/notifications/chat-hook",
      headers: viewer.headers,
    });
    expect(removed.json()).toEqual({ hook: null, removed: true });
    const audit = await auditOf(viewer.userId, [
      { action: "notify.chat_hook.set" },
      { action: "notify.chat_hook.delete" },
    ]);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["notify.chat_hook.set", "notify.chat_hook.delete"]),
    );
  });

  it("refuses a URL that isn't one, saving nothing", async () => {
    const member = await signedIn("member");
    for (const bad of [
      "chat.example.test/hooks/x",
      "ftp://chat.example.test/x",
      "https://u:p@chat/x",
    ]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/notifications/chat-hook",
        headers: member.headers,
        payload: { url: bad, format: "mattermost" },
      });
      expect(res.statusCode, bad).toBe(400);
    }
    const rows = await db
      .select()
      .from(notifyChatHooks)
      .where(eq(notifyChatHooks.ownerUserId, member.userId));
    expect(rows).toHaveLength(0);
  });

  it("tells a viewer a refusal's status, never the text the far side answered", async () => {
    const viewer = await signedIn("viewer");
    // Any host the outbound policy allows can be a hook; what it answers stays out.
    const page = "<html>internal admin page: db-password=hunter2</html>";
    setChatTransportForTests({ post: async () => ({ status: 403, text: page }) });
    try {
      const unsaved = await app.inject({
        method: "POST",
        url: "/api/notifications/chat-hook/test",
        headers: viewer.headers,
        payload: { url: "https://intranet.example.test/admin", format: "mattermost" },
      });
      expect(unsaved.statusCode).toBe(200);
      expect(unsaved.json()).toMatchObject({ ok: false, status: 403 });
      expect(unsaved.json().error).toMatch(/^The chat answered HTTP 403: it refused the hook/);
      expect(unsaved.body).not.toContain("hunter2");

      await app.inject({
        method: "PUT",
        url: "/api/notifications/chat-hook",
        headers: viewer.headers,
        payload: { url: "https://intranet.example.test/admin", format: "mattermost" },
      });
      const saved = await app.inject({
        method: "POST",
        url: "/api/notifications/chat-hook/test",
        headers: viewer.headers,
        payload: {},
      });
      expect(saved.json()).toMatchObject({ ok: false, status: 403 });
      expect(saved.body).not.toContain("hunter2");
      // The hook's last error, shown under Settings, says the same.
      const got = await app.inject({
        method: "GET",
        url: "/api/notifications/chat-hook",
        headers: viewer.headers,
      });
      expect(got.json().hook.lastError).toMatch(/HTTP 403/);
      expect(got.body).not.toContain("hunter2");
    } finally {
      setChatTransportForTests(chat);
    }
  });
});

describe("a team's channel", () => {
  it("its admin sets it; a plain member and a viewer are refused and change nothing", async () => {
    const t = await team();
    const lead = await signedIn("member");
    const plain = await signedIn("member");
    const viewer = await signedIn("viewer");
    await db.insert(teamMembers).values([
      { teamId: t.id, userId: lead.userId, role: "admin" },
      { teamId: t.id, userId: plain.userId, role: "member" },
      { teamId: t.id, userId: viewer.userId, role: "member" },
    ]);
    const url = `/api/teams/${t.id}/chat-channel`;
    const body = {
      url: "https://chat.example.test/hooks/platform-1111",
      format: "msteams",
      events: ["task.failed", "budget.warning", "not.a.kind"],
    };

    // Refused before anything exists: nothing is created.
    for (const who of [plain, viewer]) {
      const res = await app.inject({ method: "PUT", url, headers: who.headers, payload: body });
      expect(res.statusCode).toBe(403);
    }
    expect(await getTeamChannel(t.id)).toBeNull();

    const saved = await app.inject({ method: "PUT", url, headers: lead.headers, payload: body });
    expect(saved.statusCode, saved.body).toBe(200);
    // Kinds a team channel can't take are dropped.
    expect(saved.json().channel).toMatchObject({
      format: "msteams",
      events: ["task.failed", "budget.warning"],
      urlHint: "https://chat.example.test/hooks/…1111",
    });
    const before = (await getTeamChannel(t.id))!;
    expect(before.ownerUserId).toBe(lead.userId);

    // Refused once it exists: changed, removed, tested or read by a plain member — nothing changes.
    const attempts = [
      {
        method: "PUT",
        payload: { url: "https://evil.example.test/hooks/x", format: "mattermost" },
      },
      { method: "DELETE" },
      { method: "GET" },
    ] as const;
    for (const a of attempts) {
      const res = await app.inject({
        method: a.method,
        url,
        headers: plain.headers,
        ...("payload" in a ? { payload: a.payload } : {}),
      });
      expect(res.statusCode, a.method).toBe(403);
    }
    const test = await app.inject({
      method: "POST",
      url: `${url}/test`,
      headers: plain.headers,
      payload: { url: "https://evil.example.test/hooks/x" },
    });
    expect(test.statusCode).toBe(403);
    expect(chat.posts).toHaveLength(0);
    const after = (await getTeamChannel(t.id))!;
    expect(hookUrlOf(after)).toBe("https://chat.example.test/hooks/platform-1111");
    expect(after.format).toBe("msteams");
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

    // The admin's test posts a card to the saved channel.
    const ok = await app.inject({
      method: "POST",
      url: `${url}/test`,
      headers: lead.headers,
      payload: {},
    });
    expect(ok.json()).toMatchObject({ ok: true });
    expect(chat.posts[0].url).toBe("https://chat.example.test/hooks/platform-1111");
    expect(chat.posts[0].body.type).toBe("message");

    const audit = await auditOf(lead.userId, [{ action: "team.chat_channel.set", workspaceId }]);
    expect(audit).toContainEqual({ action: "team.chat_channel.set", workspaceId });
  });

  it("a workspace admin may set any team's channel; another workspace's team is a 404", async () => {
    const t = await team();
    const admin = await signedIn("admin");
    const res = await app.inject({
      method: "PUT",
      url: `/api/teams/${t.id}/chat-channel`,
      headers: admin.headers,
      payload: { url: "https://chat.example.test/hooks/ws-admin", format: "mattermost" },
    });
    expect(res.statusCode, res.body).toBe(200);

    const elsewhere = await insertWorkspace();
    const foreign = await team(elsewhere.id);
    await setTeamChannel(foreign, admin.userId, {
      url: "https://chat.example.test/hooks/foreign",
      format: "mattermost",
    });
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const r = await app.inject({
        method,
        url: `/api/teams/${foreign.id}/chat-channel`,
        headers: admin.headers,
        ...(method === "PUT"
          ? { payload: { url: "https://chat.example.test/hooks/hijack", format: "msteams" } }
          : {}),
      });
      expect(r.statusCode, method).toBe(404);
    }
    const kept = (await getTeamChannel(foreign.id))!;
    expect(hookUrlOf(kept)).toBe("https://chat.example.test/hooks/foreign");
    expect(kept.format).toBe("mattermost");
  });
});

describe("undelivered notifications", () => {
  async function deadLetter() {
    const [row] = await db
      .insert(notifyOutbox)
      .values({
        channel: "email",
        kind: "token.expiring",
        summary: "[Optio] Your token expires",
        payload: { email: { to: ["someone@example.test"], subject: "[Optio] s", text: "t" } },
        status: "dead",
        attempts: 10,
        lastError: "Could not reach the relay (ETIMEDOUT)",
        deadAt: new Date(),
      })
      .returning();
    return row;
  }

  it("refuses everyone but a deployment admin, and changes nothing", async () => {
    const dead = await deadLetter();
    const workspaceAdmin = await signedIn("admin");
    const member = await signedIn("member");
    for (const who of [workspaceAdmin, member]) {
      const get = await app.inject({
        method: "GET",
        url: "/api/notifications/outbox",
        headers: who.headers,
      });
      expect(get.statusCode).toBe(403);
      for (const action of ["retry", "discard"]) {
        const res = await app.inject({
          method: "POST",
          url: `/api/notifications/outbox/${action}`,
          headers: who.headers,
          payload: { ids: [dead.id] },
        });
        expect(res.statusCode, action).toBe(403);
        expect(res.json().error).toMatch(/Only a deployment admin/);
      }
    }
    const [still] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, dead.id));
    expect(still).toMatchObject({ status: "dead", attempts: 10 });
    expect(mail.sent).toHaveLength(0);
  });

  it("lets a deployment admin list, retry and discard them, recorded deployment-wide", async () => {
    const one = await deadLetter();
    const two = await deadLetter();
    const admin = await signedIn("member");
    await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, admin.userId));

    const list = await app.inject({
      method: "GET",
      url: "/api/notifications/outbox",
      headers: admin.headers,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().dead).toBeGreaterThanOrEqual(2);
    expect(list.json().retry).toEqual({ attempts: 10, baseSeconds: 30, deadLetterDays: 30 });
    expect(list.json().items.find((i: { id: string }) => i.id === one.id)).toMatchObject({
      to: "someone@example.test",
      attempts: 10,
      lastError: expect.stringMatching(/ETIMEDOUT/),
    });

    // No worker in this process: the retry tries at once, through the memory relay.
    const retried = await app.inject({
      method: "POST",
      url: "/api/notifications/outbox/retry",
      headers: admin.headers,
      payload: { ids: [one.id] },
    });
    expect(retried.json().retried).toBe(1);
    expect(mail.sent.map((m) => m.to[0])).toEqual(["someone@example.test"]);
    expect(await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, one.id))).toEqual([]);

    const discarded = await app.inject({
      method: "POST",
      url: "/api/notifications/outbox/discard",
      headers: admin.headers,
      payload: { ids: [two.id] },
    });
    expect(discarded.json().discarded).toBe(1);

    const audit = await auditOf(admin.userId, [
      { action: "notify.outbox.retry", workspaceId: null },
      { action: "notify.outbox.discard", workspaceId: null },
    ]);
    expect(audit).toEqual(
      expect.arrayContaining([
        { action: "notify.outbox.retry", workspaceId: null },
        { action: "notify.outbox.discard", workspaceId: null },
      ]),
    );
  });
});

describe("my digest, now", () => {
  it("sends what waits for me by email, and says when there is nothing", async () => {
    const me = await signedIn("member");
    const empty = await app.inject({
      method: "POST",
      url: "/api/notifications/digest/test",
      headers: me.headers,
    });
    expect(empty.json()).toMatchObject({ ok: true, via: ["email"], empty: true });
    expect(mail.sent[0].text).toMatch(/Nothing waits for you/);

    mail.sent.length = 0;
    await insertTask({
      workspaceId,
      ownerUserId: me.userId,
      createdBy: me.userId,
      title: "Add the export button",
      state: "pr_opened",
    });
    const full = await app.inject({
      method: "POST",
      url: "/api/notifications/digest/test",
      headers: me.headers,
    });
    expect(full.json()).toMatchObject({
      ok: true,
      via: ["email"],
      empty: false,
      counts: { waiting: 1, failed: 0, merged: 0 },
    });
    expect(mail.sent[0].to).toEqual([me.email]);
    expect(mail.sent[0].subject).toMatch(/^\[Optio\] Your digest for .*: 1 waiting for you$/);
    expect(mail.sent[0].text).toContain("Add the export button");
  });
});
