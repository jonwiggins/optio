/**
 * A person's own chat hook of each chat service, through the routes
 * (routes/notify-delivery.ts), real Postgres and real HTTP to the fake
 * incoming webhooks (test-utils/fake-chat.ts): a URL only one service uses
 * picks its format when none is chosen, any other URL needs a choice, what
 * Optio posts is taken by the service it was saved for, the URL is sealed
 * and never returned, the outbound guard decides where a post may go, and
 * saving is in the action log.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { and, eq } from "drizzle-orm";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { CHAT_FORMAT_IDS } from "@optio/shared";
import { db } from "../db/client.js";
import { notifyChatHooks, optioActions, workspaceMembers } from "../db/schema.js";
import authPlugin from "../plugins/auth.js";
import { createSession } from "../services/session-service.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { startFakeChat, type FakeChat } from "../test-utils/fake-chat.js";
import { setOutboundDefaults } from "../utils/outbound-url.js";
import {
  ChatHookError,
  getPersonalHook,
  postToHook,
  setChatTransportForTests,
  setPersonalHook,
} from "../services/notify/chat-hooks.js";
import { notifyDeliveryRoutes } from "./notify-delivery.js";

let app: FastifyInstance;
let workspaceId: string;
let chat: FakeChat;
let restoreOutbound: () => void;
const uniq = () => randomBytes(4).toString("hex");

async function signedIn(role: "viewer" | "member" | "admin") {
  const externalId = `cf-${uniq()}`;
  const { token, user } = await createSession("oidc", {
    externalId,
    email: `${externalId}@example.com`,
    displayName: externalId,
  });
  await db.insert(workspaceMembers).values({ workspaceId, userId: user.id, role });
  return {
    userId: user.id,
    headers: { authorization: `Bearer ${token}`, "x-workspace-id": workspaceId },
  };
}

beforeAll(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  setChatTransportForTests(null);
  chat = await startFakeChat();
  restoreOutbound = setOutboundDefaults({ fetchImpl: chat.fetch, resolveHost: chat.resolveHost });
  workspaceId = (await insertWorkspace()).id;
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin);
  await app.register(notifyDeliveryRoutes);
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  restoreOutbound?.();
  await chat?.close();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  chat.posts.length = 0;
  vi.stubEnv("PUBLIC_URL", "https://optio.example.com");
});

describe("a person's own hook, of any chat service", () => {
  it("offers every chat format", async () => {
    const me = await signedIn("viewer");
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications/chat-hook",
      headers: me.headers,
    });
    expect(res.json()).toEqual({ hook: null, formats: [...CHAT_FORMAT_IDS] });
  });

  it("takes a Discord URL without a choice, and its test arrives as an embed", async () => {
    const me = await signedIn("viewer");
    const saved = await app.inject({
      method: "PUT",
      url: "/api/notifications/chat-hook",
      headers: me.headers,
      payload: { url: chat.urlFor("discord") },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().hook).toMatchObject({ format: "discord", enabled: true });

    const test = await app.inject({
      method: "POST",
      url: "/api/notifications/chat-hook/test",
      headers: me.headers,
      payload: {},
    });
    expect(test.json()).toMatchObject({ ok: true, status: 204 });
    const [post] = chat.postsTo("discord");
    expect(post.body).toMatchObject({
      embeds: [{ title: "Optio can post here" }],
      allowed_mentions: { parse: [] },
    });
  });

  it("tests a URL it can't place in the chat chosen for it, else the saved hook's, else refuses", async () => {
    const me = await signedIn("member");
    const test = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/notifications/chat-hook/test",
        headers: me.headers,
        payload,
      });
    // A self-hosted server's /hooks/<id>: no service of its own.
    const url = chat.urlFor("mattermost");

    const unplaced = await test({ url });
    expect(unplaced.statusCode).toBe(400);
    expect(unplaced.json().error).toMatch(/Choose the chat/);
    expect(chat.posts).toHaveLength(0);

    const chosen = await test({ url, format: "mattermost" });
    expect(chosen.json()).toMatchObject({ ok: true, status: 200 });
    expect(chat.postsTo("mattermost")).toHaveLength(1);

    await setPersonalHook(me.userId, { url: chat.urlFor("rocketchat"), format: "rocketchat" });
    const bySaved = await test({ url: `https://chat.example.com/hooks/${uniq()}/${uniq()}` });
    expect(bySaved.json()).toMatchObject({ ok: true, status: 200 });
    expect(chat.postsTo("rocketchat")).toHaveLength(1);
  });

  it("needs a choice for a URL any server could have, and posts in the format chosen", async () => {
    const me = await signedIn("member");
    const url = `https://chat.example.com/hooks/${uniq()}/${uniq()}`;
    const unplaced = await app.inject({
      method: "PUT",
      url: "/api/notifications/chat-hook",
      headers: me.headers,
      payload: { url },
    });
    expect(unplaced.statusCode).toBe(400);
    expect(unplaced.json().error).toMatch(/Choose the chat/);
    expect(await getPersonalHook(me.userId)).toBeNull();

    const saved = await app.inject({
      method: "PUT",
      url: "/api/notifications/chat-hook",
      headers: me.headers,
      payload: { url, format: "rocketchat" },
    });
    expect(saved.json().hook.format).toBe("rocketchat");
    const row = (await getPersonalHook(me.userId))!;
    const result = await postToHook(row, {
      type: "work",
      event: "task.failed",
      data: { taskId: "t-1", taskTitle: "Fix @all", errorMessage: "boom" },
    });
    expect(result).toMatchObject({ ok: true });
    expect(chat.postsTo("rocketchat")[0].body).toMatchObject({ text: "*Task failed*" });
    expect((await getPersonalHook(me.userId))!.lastSentAt).not.toBeNull();
  });

  it("refuses a format outside the list", async () => {
    const me = await signedIn("member");
    const res = await app.inject({
      method: "PUT",
      url: "/api/notifications/chat-hook",
      headers: me.headers,
      payload: { url: chat.urlFor("webex"), format: "irc" },
    });
    expect(res.statusCode).toBe(400);
    expect(await getPersonalHook(me.userId)).toBeNull();
  });

  it("follows a new URL to its service, and keeps the format for one it can't place", async () => {
    const me = await signedIn("member");
    await setPersonalHook(me.userId, { url: chat.urlFor("mattermost"), format: "mattermost" });
    await setPersonalHook(me.userId, { url: chat.urlFor("webex") });
    expect((await getPersonalHook(me.userId))!.format).toBe("webex");
    await setPersonalHook(me.userId, { url: `https://chat.example.com/hooks/${uniq()}` });
    expect((await getPersonalHook(me.userId))!.format).toBe("webex");
    await expect(
      setPersonalHook((await signedIn("member")).userId, {
        url: "https://chat.example.com/hooks/x",
      }),
    ).rejects.toBeInstanceOf(ChatHookError);
  });
});

describe("a hook's URL is a credential", () => {
  it("is sealed at rest and never returned, only its hint", async () => {
    const me = await signedIn("viewer");
    const url = chat.urlFor("discord");
    const saved = await app.inject({
      method: "PUT",
      url: "/api/notifications/chat-hook",
      headers: me.headers,
      payload: { url },
    });
    expect(saved.body).not.toContain("tok-EN_abc");
    expect(saved.json().hook.urlHint).toMatch(/^https:\/\/discord\.com\/api\/…/);
    const read = await app.inject({
      method: "GET",
      url: "/api/notifications/chat-hook",
      headers: me.headers,
    });
    expect(read.body).not.toContain("tok-EN_abc");
    const [row] = await db
      .select()
      .from(notifyChatHooks)
      .where(eq(notifyChatHooks.ownerUserId, me.userId));
    expect(Buffer.from(row.encryptedUrl).toString("latin1")).not.toContain("tok-EN_abc");
    expect(row.urlHint).not.toContain("tok-EN_abc");
  });

  it("records saving and removing it in the action log, with a plain-http URL marked", async () => {
    const me = await signedIn("member");
    const url = `http://chat.example.com/hooks/${uniq()}`;
    const saved = await app.inject({
      method: "PUT",
      url: "/api/notifications/chat-hook",
      headers: me.headers,
      payload: { url, format: "mattermost" },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await app.inject({
      method: "DELETE",
      url: "/api/notifications/chat-hook",
      headers: me.headers,
    });
    const actions = await db
      .select()
      .from(optioActions)
      .where(and(eq(optioActions.userId, me.userId)));
    const set = actions.find((a) => a.action === "notify.chat_hook.set");
    expect(set?.result).toMatchObject({ plaintextHttp: true });
    expect(JSON.stringify(set)).not.toContain(url);
    expect(actions.some((a) => a.action === "notify.chat_hook.delete")).toBe(true);
  });
});

describe("the outbound guard decides where a post may go", () => {
  it("refuses a hook whose host resolves to a private address, without connecting", async () => {
    const me = await signedIn("viewer");
    const restore = setOutboundDefaults({
      policy: { allowPrivate: false, allowedHosts: [], allowAll: false },
      resolveHost: async () => [{ address: "10.1.2.3", family: 4 }],
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/notifications/chat-hook/test",
        headers: me.headers,
        payload: { url: `https://internal.example.com/hooks/${uniq()}`, format: "mattermost" },
      });
      expect(res.json()).toEqual({
        ok: false,
        error: "The deployment's outbound policy does not allow this host",
        permanent: true,
      });
      expect(chat.posts).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("tells the caller only that the hook could not be reached, never how", async () => {
    const me = await signedIn("viewer");
    const restore = setOutboundDefaults({
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 93.184.216.34:8443 (TLS: self-signed)");
      },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/notifications/chat-hook/test",
        headers: me.headers,
        payload: { url: chat.urlFor("discord") },
      });
      expect(res.json()).toEqual({
        ok: false,
        error: "Optio could not reach the hook",
        permanent: false,
      });
      expect(res.body).not.toMatch(/ECONNREFUSED|8443|self-signed/);
    } finally {
      restore();
    }
  });

  it("never follows a redirect", async () => {
    const me = await signedIn("viewer");
    const seen: string[] = [];
    const restore = setOutboundDefaults({
      fetchImpl: async (url) => {
        seen.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest" },
        });
      },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/notifications/chat-hook/test",
        headers: me.headers,
        payload: { url: chat.urlFor("discord") },
      });
      expect(res.json()).toMatchObject({ ok: false });
      expect(seen).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("allows ten tests a minute", async () => {
    const me = await signedIn("viewer");
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/notifications/chat-hook/test",
        headers: me.headers,
        payload: { url: chat.urlFor("webex") },
      });
      codes.push(res.statusCode);
    }
    // Earlier tests in this file used some of the minute's ten.
    expect(codes.filter((c) => c !== 429).length).toBeLessThanOrEqual(10);
    expect(codes.at(-1)).toBe(429);
  });
});
