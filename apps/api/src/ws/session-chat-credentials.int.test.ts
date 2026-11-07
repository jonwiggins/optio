/**
 * The pod session chat must never carry the caller's browser session into the
 * pod. Real Postgres, real cookie authentication, the real chat handler and the
 * fake runtime playing `claude -p`; every script the API execs in the pod is
 * captured and searched for the session token.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { agentPods, interactiveSessions, users, workspaceMembers } from "../db/schema.js";
import { createSession } from "../services/session-service.js";
import { getRuntime } from "../services/container-service.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { listenWsApp, WsTestClient } from "../test-utils/integration/ws-client.js";
import { sessionChatWs } from "./session-chat.js";

vi.hoisted(() => {
  process.env.OPTIO_RUNTIME = "fake";
  process.env.OPTIO_ALLOW_FAKE_RUNTIME = "1";
  process.env.LOG_LEVEL ??= "warn";
});

const saved = {
  auth: process.env.OPTIO_AUTH_DISABLED,
  apiUrl: process.env.OPTIO_API_URL,
};
let app: FastifyInstance;
let wsBase = "";
let browserSession = "";
let chatSessionId = "";
const scripts: string[] = [];

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  process.env.OPTIO_API_URL = "http://optio-api.test";
  const workspace = await insertWorkspace();
  const externalId = `pod-chat-${randomBytes(5).toString("hex")}`;
  const [user] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId,
      email: "pod-chat@example.test",
      displayName: "Pod chat test",
      defaultWorkspaceId: workspace.id,
    })
    .returning();
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: workspace.id, userId: user.id, role: "member" });
  browserSession = (
    await createSession("github", {
      externalId,
      email: "pod-chat@example.test",
      displayName: "Pod chat test",
    })
  ).token;

  const repoUrl = `https://github.com/it-org/pod-chat-${randomBytes(3).toString("hex")}`;
  const [pod] = await db
    .insert(agentPods)
    .values({
      pool: "repo",
      poolKey: repoUrl,
      podName: "pod-chat-pod",
      podId: "pod-chat-pod",
      state: "ready",
    })
    .returning();
  const [session] = await db
    .insert(interactiveSessions)
    .values({
      repoUrl,
      branch: "session/it/credentials",
      podId: pod.id,
      userId: user.id,
      workspaceId: workspace.id,
    })
    .returning();
  chatSessionId = session.id;

  const rt = getRuntime();
  const exec = rt.exec.bind(rt);
  vi.spyOn(rt, "exec").mockImplementation((handle, command, opts) => {
    scripts.push(command.join(" "));
    return exec(handle, command, opts);
  });

  ({ app, wsBase } = await listenWsApp([
    async (app) => {
      // The Node test client cannot set headers: sign in with the browser
      // session cookie the way the web app's socket does.
      app.addHook("onRequest", async (req) => {
        if (req.url.startsWith("/ws/")) req.headers.cookie = `optio_session=${browserSession}`;
      });
      await sessionChatWs(app);
    },
  ]));
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  for (const [key, value] of [
    ["OPTIO_AUTH_DISABLED", saved.auth],
    ["OPTIO_API_URL", saved.apiUrl],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("pod session chat credentials", () => {
  it("never puts the caller's browser session into the pod", async () => {
    const chat = new WsTestClient(`${wsBase}/ws/sessions/${chatSessionId}/chat`);
    try {
      await chat.next((f) => f.type === "status" && f.status === "ready");
      await chat.next((f) => f.type === "history_done");
      chat.send({
        type: "message",
        content: "show env [[mock:env:OPTIO_SESSION_TOKEN]] [[mock:env:OPTIO_API_URL]]",
      });
      await chat.next((f) => f.type === "status" && f.status === "idle", 10_000);
      const text = chat.frames
        .filter((f) => f.type === "chat_event")
        .map((f) => String(f.event.content))
        .join("\n");
      expect(text).toContain("env OPTIO_SESSION_TOKEN=<unset>");
      // The API's address still reaches the agent; only the credential is gone.
      expect(text).toContain("env OPTIO_API_URL=http://optio-api.test");
    } finally {
      await chat.close();
    }
    expect(browserSession.length).toBeGreaterThan(16);
    const chatScripts = scripts.filter((s) => s.includes("claude -p"));
    expect(chatScripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).not.toContain(browserSession);
  });
});
