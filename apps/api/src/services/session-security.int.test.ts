import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  users,
  workspaceMembers,
  sessionShares,
  interactiveSessions,
  agentPods,
} from "../db/schema.js";
import { podIsolationKey } from "./pod-isolation.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  canJoinSession,
  createSessionShare,
  redeemSessionShare,
  revokeSessionShare,
  watchSessionAccess,
} from "./session-sharing-service.js";
import {
  claimSessionTurn,
  finishSessionTurn,
  recoverSessionTurns,
} from "./session-turn-service.js";

vi.mock("./oauth/index.js", () => ({ isAuthDisabled: () => false }));

async function insertSession(overrides: Partial<typeof interactiveSessions.$inferInsert> = {}) {
  const [session] = await db
    .insert(interactiveSessions)
    .values({
      repoUrl: "https://github.com/test/repo",
      branch: `session/${randomUUID()}`,
      ...overrides,
    })
    .returning();
  const [pod] = await db
    .insert(agentPods)
    .values({
      pool: "repo",
      poolKey: session.repoUrl,
      workspaceId: session.workspaceId,
      isolationKey: podIsolationKey({
        workspaceId: session.workspaceId,
        ownerUserId: session.userId,
        isolationPurpose: `session:${session.id}`,
      }),
      instanceIndex: 0,
    })
    .returning();
  await db
    .update(interactiveSessions)
    .set({ podId: pod.id })
    .where(eq(interactiveSessions.id, session.id));
  return { ...session, podId: pod.id };
}

async function actor(workspaceId: string, role: "member" | "viewer" = "member") {
  const [user] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: randomUUID(),
      email: `${randomUUID()}@example.com`,
      displayName: "Member",
    })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId, userId: user.id, role });
  return { id: user.id, workspaceId };
}

describe("session collaboration authorization", () => {
  it("refuses links to legacy pods that could contain other users' credentials", async () => {
    const ws = await insertWorkspace(),
      owner = await actor(ws.id);
    const session = await insertSession({ userId: owner.id, workspaceId: ws.id });
    await db.update(agentPods).set({ isolationKey: null }).where(eq(agentPods.id, session.podId));
    await expect(createSessionShare("pod", session, owner, 24)).rejects.toThrow("isolated session");
  });

  it("requires a link, same organization and member role; revoke closes a connected collaborator", async () => {
    const ws = await insertWorkspace();
    const owner = await actor(ws.id),
      colleague = await actor(ws.id),
      viewer = await actor(ws.id, "viewer");
    const outsider = await actor((await insertWorkspace()).id);
    const session = await insertSession({ userId: owner.id, workspaceId: ws.id });
    expect(await canJoinSession("pod", session, colleague)).toBe(false);
    await expect(createSessionShare("pod", session, colleague, 24)).rejects.toThrow("owner");
    const link = await createSessionShare("pod", session, owner, 24);
    const [stored] = await db.select().from(sessionShares).where(eq(sessionShares.id, link.id));
    expect(stored.tokenHash).not.toContain(link.token);
    expect(await redeemSessionShare(link.token, outsider)).toBeNull();
    expect(await redeemSessionShare(link.token, viewer)).toBeNull();
    expect(await redeemSessionShare(link.token, colleague)).toMatchObject({ targetId: session.id });
    expect(await canJoinSession("pod", session, colleague)).toBe(true);
    expect(await canJoinSession("local", session, colleague)).toBe(false);
    const socket = Object.assign(new EventEmitter(), { close: vi.fn() });
    const mayInput = watchSessionAccess("pod", session, colleague, socket);
    await revokeSessionShare("pod", session.id, link.id);
    expect(socket.close).toHaveBeenCalledWith(4403, expect.any(String));
    expect(await mayInput()).toBe(false);
    expect(await redeemSessionShare(link.token, colleague)).toBeNull();
    socket.emit("close");
  });

  it("expiry, membership removal and ownership changes invalidate an existing grant", async () => {
    const ws = await insertWorkspace(),
      owner = await actor(ws.id),
      colleague = await actor(ws.id);
    const session = await insertSession({ userId: owner.id, workspaceId: ws.id });
    const link = await createSessionShare("pod", session, owner, 24);
    await redeemSessionShare(link.token, colleague);
    expect(await canJoinSession("pod", { ...session, userId: randomUUID() }, colleague)).toBe(
      false,
    );
    await db
      .update(sessionShares)
      .set({ expiresAt: new Date(0) })
      .where(eq(sessionShares.id, link.id));
    expect(await canJoinSession("pod", session, colleague)).toBe(false);
    const second = await createSessionShare("pod", session, owner, 24);
    await redeemSessionShare(second.token, colleague);
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, colleague.id));
    expect(await canJoinSession("pod", session, colleague)).toBe(false);
  });
});

describe("durable turn receipts", () => {
  it("admits one simultaneous turn, never repeats a completed request, and rejects changed payloads", async () => {
    const session = await insertSession();
    const requestId = randomUUID();
    const claims = await Promise.all([
      claimSessionTurn(session.id, requestId, "push once"),
      claimSessionTurn(session.id, requestId, "push once"),
    ]);
    expect(claims.filter((c) => c.accepted)).toHaveLength(1);
    expect((await claimSessionTurn(session.id, randomUUID(), "another turn")).accepted).toBe(false);
    const accepted = claims.find((c) => c.accepted)!;
    if (!accepted.accepted) throw new Error("missing claim");
    await finishSessionTurn(accepted.turn.id, true);
    expect((await claimSessionTurn(session.id, requestId, "push once")).accepted).toBe(false);
    expect(await claimSessionTurn(session.id, requestId, "different prompt")).toMatchObject({
      accepted: false,
      reason: expect.stringContaining("different"),
    });
  });
  it("preserves an uncertain receipt across API recovery, requiring a new explicit prompt", async () => {
    const session = await insertSession();
    const requestId = randomUUID();
    expect((await claimSessionTurn(session.id, requestId, "create something")).accepted).toBe(true);
    await recoverSessionTurns();
    expect(await claimSessionTurn(session.id, requestId, "create something")).toMatchObject({
      accepted: false,
      reason: expect.stringContaining("interrupted"),
    });
    expect(
      (await claimSessionTurn(session.id, randomUUID(), "inspect previous result")).accepted,
    ).toBe(true);
  });
});
