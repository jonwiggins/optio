import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { interactiveSessions, sessionToolApprovals } from "../db/schema.js";
import { createSession } from "./interactive-session-service.js";
import { ensureOptioSession } from "./session-harness-service.js";
import { claimSessionTurn, finishSessionTurn } from "./session-turn-service.js";
import { issueControllerToken, validateControllerToken } from "./controller-auth.js";
import { requestSessionApproval, decideSessionApproval } from "./session-tool-approval.js";
import { upsertSettings } from "./optio-settings-service.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { listenWsApp } from "../test-utils/integration/ws-client.js";
import { controllerMcpRoutes } from "../routes/controller-mcp.js";

const previous = process.env.OPTIO_AUTH_DISABLED;
process.env.OPTIO_AUTH_DISABLED = "true";
afterAll(() => {
  if (previous === undefined) delete process.env.OPTIO_AUTH_DISABLED;
  else process.env.OPTIO_AUTH_DISABLED = previous;
});

async function setup() {
  const workspaceId = (await insertWorkspace()).id;
  const session = await createSession({
    title: "MCP session",
    agentRuntime: "codex",
    workspaceId,
    settings: { controllerAccess: "manage" },
  });
  const claim = await claimSessionTurn(session.id, randomUUID(), "create work");
  if (!claim.accepted) throw new Error(claim.reason);
  const token = await issueControllerToken({
    kind: "session-turn",
    id: claim.turn.id,
    workspaceId,
    ownerUserId: null,
    access: "manage",
  });
  return { session, turn: claim.turn, token, workspaceId };
}

describe("Interactive harness sessions", () => {
  it("creates one ordinary assistant session per owner and workspace, even concurrently", async () => {
    const ws = (await insertWorkspace()).id;
    await upsertSettings(
      { agentRuntime: "gemini", model: "", agentOptions: { geminiApprovalMode: "yolo" } },
      ws,
    );
    const sessions = await Promise.all([
      ensureOptioSession(null, ws),
      ensureOptioSession(null, ws),
    ]);
    expect(sessions[0].id).toBe(sessions[1].id);
    expect(sessions[0]).toMatchObject({
      agentRuntime: "gemini",
      repoUrl: "",
      settings: { controllerAccess: "manage" },
    });
    expect(
      await db.select().from(interactiveSessions).where(eq(interactiveSessions.workspaceId, ws)),
    ).toHaveLength(1);
  });
  it("scopes controller credentials to a live session turn and revokes them on completion", async () => {
    const { session, turn, token } = await setup();
    expect(await validateControllerToken(token)).toMatchObject({
      run: { kind: "session-turn", sessionId: session.id },
      sessionPolicy: { confirmWrites: true },
    });
    await finishSessionTurn(turn.id, true);
    expect(await validateControllerToken(token)).toBeNull();
  });
  it("requires an exact, single-use approval from the right session", async () => {
    const { session, turn } = await setup();
    const pending = requestSessionApproval(session.id, turn.id, "delete_work", {
      id: randomUUID(),
    });
    const rows = async () =>
      db.select().from(sessionToolApprovals).where(eq(sessionToolApprovals.turnId, turn.id));
    let id = "";
    await expect
      .poll(async () => {
        id = (await rows())[0]?.id;
        return id;
      })
      .toBeTruthy();
    expect(await decideSessionApproval(randomUUID(), id, true)).toBe(false);
    expect((await rows())[0].state).toBe("pending");
    expect(await decideSessionApproval(session.id, id, true)).toBe(true);
    expect(await decideSessionApproval(session.id, id, true)).toBe(false);
    expect(await pending).toBe(id);
    expect((await rows())[0].state).toBe("executing");
    await finishSessionTurn(turn.id, true);
  });
  it("executes a real MCP create_work only after approval and returns its work link", async () => {
    const { session, turn, token } = await setup();
    const { app } = await listenWsApp([controllerMcpRoutes]);
    try {
      const call = app.inject({
        method: "POST",
        url: "/api/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "optio_create_work",
            arguments: {
              spec: {
                name: "New Codex conversation",
                when: { type: "manual" },
                where: { runTarget: "cluster" },
                who: { runtime: "codex" },
                what: { prompt: "Help with work" },
                then: "waits-for-me",
              },
            },
          },
        },
      });
      let id = "";
      await expect
        .poll(async () => {
          const [row] = await db
            .select()
            .from(sessionToolApprovals)
            .where(eq(sessionToolApprovals.turnId, turn.id));
          id = row?.id;
          return id;
        })
        .toBeTruthy();
      expect(
        await db
          .select()
          .from(interactiveSessions)
          .where(
            and(
              eq(interactiveSessions.workspaceId, session.workspaceId!),
              eq(interactiveSessions.title, "New Codex conversation"),
            ),
          ),
      ).toHaveLength(0);
      await decideSessionApproval(session.id, id, true);
      const response = await call;
      expect(response.statusCode).toBe(200);
      const result = response.json().result;
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        kind: "pod-session",
        href: expect.stringMatching(/^\/work\//),
      });
    } finally {
      await finishSessionTurn(turn.id, true);
      await app.close();
    }
  });
});

it("keeps named assistant sessions independent while retaining a stable legacy default", async () => {
  const { createOptioSession, getOptioSession } = await import("./session-harness-service.js");
  const { endSession } = await import("./interactive-session-service.js");
  const ws = (await insertWorkspace()).id;
  const [defaultSession, first, second] = await Promise.all([
    ensureOptioSession(null, ws),
    createOptioSession(null, ws, "Planning"),
    createOptioSession(null, ws, "Investigation"),
  ]);
  expect(new Set([defaultSession.id, first.id, second.id]).size).toBe(3);
  expect((await ensureOptioSession(null, ws)).id).toBe(defaultSession.id);
  expect(await getOptioSession(first.id, null, ws)).toMatchObject({ title: "Planning" });
  expect(await getOptioSession(first.id, randomUUID(), ws)).toBeNull();
  expect(await getOptioSession(first.id, null, randomUUID())).toBeNull();
  const [a, b] = await Promise.all([
    claimSessionTurn(first.id, randomUUID(), "Plan"),
    claimSessionTurn(second.id, randomUUID(), "Investigate"),
  ]);
  expect(a.accepted).toBe(true);
  expect(b.accepted).toBe(true);
  if (a.accepted) await finishSessionTurn(a.turn.id, true);
  if (b.accepted) await finishSessionTurn(b.turn.id, true);
  await endSession(first.id);
  expect(await getOptioSession(first.id, null, ws)).toBeNull();
  expect(await getOptioSession(second.id, null, ws)).not.toBeNull();
});
