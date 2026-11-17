/** Real PAT/session authentication and HTTP tool authorization; provider is simulated. */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { users, workspaceMembers } from "../db/schema.js";
import { createApiKey } from "../services/api-key-service.js";
import { createSession } from "../services/session-service.js";
import { storeSecret } from "../services/secret-service.js";
import authPlugin from "../plugins/auth.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { listenWsApp, WsTestClient } from "../test-utils/integration/ws-client.js";
import { optioSessionRoutes } from "../routes/optio-sessions.js";
import { optioChatWs } from "./optio-chat.js";

vi.mock("../services/agent-options-service.js", () => ({
  resolveLiveModelId: vi.fn().mockResolvedValue("test-model"),
}));
let app: FastifyInstance;
let wsBase: string;
let userId: string;
let workspaceId: string;
let otherWorkspaceId: string;
let forbiddenWorkspaceId: string;
let pat: string;
let session: string;
const observed: Array<{ userId?: string; workspaceId?: string | null }> = [];
const savedAuth = process.env.OPTIO_AUTH_DISABLED;

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  workspaceId = (await insertWorkspace()).id;
  otherWorkspaceId = (await insertWorkspace()).id;
  forbiddenWorkspaceId = (await insertWorkspace()).id;
  const externalId = `assistant-${randomBytes(5).toString("hex")}`;
  const [user] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId,
      email: "assistant@example.test",
      displayName: "Assistant test",
      defaultWorkspaceId: workspaceId,
    })
    .returning();
  userId = user.id;
  await db.insert(workspaceMembers).values([
    { workspaceId, userId, role: "member" },
    { workspaceId: otherWorkspaceId, userId, role: "member" },
  ]);
  pat = (await createApiKey(userId, "assistant integration")).token;
  session = (
    await createSession("github", {
      externalId,
      email: "assistant@example.test",
      displayName: "Assistant test",
    })
  ).token;
  await storeSecret("CLAUDE_AUTH_MODE", "api-key");
  await storeSecret("ANTHROPIC_API_KEY", "test-user-key", "user", undefined, userId);
  ({ app, wsBase } = await listenWsApp([
    async (app) => {
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      // Node's browser-compatible test client cannot attach headers. Inject test
      // header values before the real WebSocket auth handler receives the request.
      app.addHook("onRequest", async (req) => {
        if (!req.url.startsWith("/ws/")) return;
        const mode = new URL(req.url, "http://test").searchParams;
        if (mode.get("workspace")) req.headers["x-workspace-id"] = mode.get("workspace")!;
        if (mode.get("session"))
          req.headers.cookie = `optio_session=${session}; optio_workspace=${otherWorkspaceId}`;
      });
      await app.register(authPlugin);
      app.get("/api/work", async (req) => {
        observed.push({ userId: req.user?.id, workspaceId: req.user?.workspaceId });
        return { items: [] };
      });
      await optioChatWs(app);
      await optioSessionRoutes(app);
    },
  ]));
});
afterEach(() => {
  vi.unstubAllGlobals();
  observed.length = 0;
});
afterAll(async () => {
  await app?.close();
  if (savedAuth === undefined) delete process.env.OPTIO_AUTH_DISABLED;
  else process.env.OPTIO_AUTH_DISABLED = savedAuth;
});

describe("Optio authenticated sessions", () => {
  it.each(["pat", "session"])(
    "uses %s to open a private session in the selected workspace",
    async (mode) => {
      const path = mode === "pat" ? `?workspace=${otherWorkspaceId}` : "?session=1";
      const client = new WsTestClient(
        `${wsBase}/ws/optio/chat${path}`,
        mode === "pat" ? { token: pat } : {},
      );
      try {
        const frame = await client.next((f) => f.type === "history");
        const { getSession } = await import("../services/interactive-session-service.js");
        expect(await getSession(frame.sessionId)).toMatchObject({
          userId,
          workspaceId: otherWorkspaceId,
          assistant: true,
          agentRuntime: "claude-code",
        });
      } finally {
        await client.close();
      }
    },
  );
  it("rejects a foreign workspace before opening a session", async () => {
    const client = new WsTestClient(`${wsBase}/ws/optio/chat?workspace=${forbiddenWorkspaceId}`, {
      token: pat,
    });
    expect((await client.closed).code).toBe(4403);
  });
});

it("rejects another owner's, another workspace's, ended and ordinary sessions by explicit id", async () => {
  const { createOptioSession } = await import("../services/session-harness-service.js");
  const { createSession: createWorkSession, endSession } =
    await import("../services/interactive-session-service.js");
  const { randomUUID } = await import("node:crypto");
  const mine = await createOptioSession(userId, workspaceId, "Mine");
  const foreign = await createOptioSession(randomUUID(), workspaceId, "Other owner");
  const wrongWorkspace = await createOptioSession(userId, otherWorkspaceId, "Other workspace");
  const ordinary = await createWorkSession({ userId, workspaceId, agentRuntime: "codex" });
  const ended = await createOptioSession(userId, workspaceId, "Ended");
  await endSession(ended.id);
  for (const id of [foreign.id, wrongWorkspace.id, ordinary.id, ended.id, "invalid"]) {
    const client = new WsTestClient(`${wsBase}/ws/optio/chat?sessionId=${id}`, { token: pat });
    expect((await client.closed).code).toBe(4404);
  }
  const client = new WsTestClient(`${wsBase}/ws/optio/chat?sessionId=${mine.id}`, { token: pat });
  try {
    expect((await client.next((f) => f.type === "history")).sessionId).toBe(mine.id);
  } finally {
    await client.close();
  }
});

it("lists and edits only the authenticated owner's assistant sessions", async () => {
  const { createOptioSession } = await import("../services/session-harness-service.js");
  const { randomUUID } = await import("node:crypto");
  const foreign = await createOptioSession(randomUUID(), workspaceId, "Private conversation");
  const headers = { authorization: `Bearer ${pat}` };
  const response = await app.inject({ method: "GET", url: "/api/optio/sessions", headers });
  expect(response.statusCode).toBe(200);
  expect(response.json().sessions.some((s: { id: string }) => s.id === foreign.id)).toBe(false);
  for (const method of ["PATCH", "DELETE"] as const) {
    const res = await app.inject({
      method,
      url: `/api/optio/sessions/${foreign.id}`,
      headers,
      ...(method === "PATCH" ? { payload: { title: "Changed" } } : {}),
    });
    expect(res.statusCode).toBe(404);
  }
});
