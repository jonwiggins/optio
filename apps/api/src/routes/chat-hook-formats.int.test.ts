/**
 * A person's chat hook and a team's channel of each chat service, through
 * the routes (routes/notify-delivery.ts), real Postgres and real HTTP to the
 * fake incoming webhooks (test-utils/fake-chat.ts): a URL only one service
 * uses picks its format when none is chosen, any other URL needs a choice,
 * and what Optio posts is taken by the service it was saved for.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { CHAT_FORMAT_IDS } from "@optio/shared";
import { db } from "../db/client.js";
import { teams, workspaceMembers } from "../db/schema.js";
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

describe("a team's channel, of any chat service", () => {
  it("is set to Google Chat by its URL and its test arrives as a card", async () => {
    const admin = await signedIn("admin");
    const [t] = await db
      .insert(teams)
      .values({ workspaceId, name: `Team ${uniq()}`, slug: `team-${uniq()}` })
      .returning();
    const saved = await app.inject({
      method: "PUT",
      url: `/api/teams/${t.id}/chat-channel`,
      headers: admin.headers,
      payload: { url: chat.urlFor("googlechat"), events: ["task.failed"] },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().channel).toMatchObject({ format: "googlechat", events: ["task.failed"] });

    const test = await app.inject({
      method: "POST",
      url: `/api/teams/${t.id}/chat-channel/test`,
      headers: admin.headers,
      payload: {},
    });
    expect(test.json()).toMatchObject({ ok: true, status: 200 });
    const [post] = chat.postsTo("googlechat");
    expect(post.body).toMatchObject({
      cardsV2: [{ card: { header: { title: "Optio can post here" } } }],
    });
    expect(post.query).toMatchObject({ key: "k-1", token: "t-1" });
  });
});
