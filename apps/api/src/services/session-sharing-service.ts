import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  interactiveSessions,
  localTerminals,
  sessionShares,
  sessionShareMembers,
  agentPods,
} from "../db/schema.js";
import { podIsolationKey } from "./pod-isolation.js";
import { isAuthDisabled } from "./oauth/index.js";

export type SessionKind = "pod" | "local";
export interface SessionActor {
  id: string;
  workspaceId?: string | null;
}
export interface SessionTarget {
  id: string;
  userId: string | null;
  workspaceId: string | null;
}
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function shareTarget(kind: SessionKind, id: string): Promise<SessionTarget | null> {
  const table = kind === "pod" ? interactiveSessions : localTerminals;
  const [row] = await db
    .select({ id: table.id, userId: table.userId, workspaceId: table.workspaceId })
    .from(table)
    .where(eq(table.id, id));
  return row ?? null;
}

async function member(userId: string, workspaceId: string | null): Promise<boolean> {
  if (!workspaceId) return false;
  const { getUserRole } = await import("./workspace-service.js");
  const role = await getUserRole(workspaceId, userId);
  return role === "admin" || role === "member";
}

export async function canJoinSession(
  kind: SessionKind,
  target: SessionTarget,
  actor?: SessionActor,
): Promise<boolean> {
  if (isAuthDisabled()) return true;
  if (!actor || (target.workspaceId ?? null) !== (actor.workspaceId ?? null)) return false;
  if (target.userId === actor.id) return true;
  if (!target.userId) return true;
  if (
    !(await member(actor.id, target.workspaceId)) ||
    !(await member(target.userId, target.workspaceId))
  )
    return false;
  const [grant] = await db
    .select({ id: sessionShares.id })
    .from(sessionShares)
    .innerJoin(sessionShareMembers, eq(sessionShareMembers.shareId, sessionShares.id))
    .where(
      and(
        eq(sessionShares.kind, kind),
        eq(sessionShares.targetId, target.id),
        eq(sessionShares.ownerUserId, target.userId),
        eq(sessionShares.workspaceId, target.workspaceId!),
        eq(sessionShareMembers.userId, actor.id),
        isNull(sessionShares.revokedAt),
        gt(sessionShares.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return !!grant;
}

async function isShareablePod(target: SessionTarget): Promise<boolean> {
  const [row] = await db
    .select({ isolationKey: agentPods.isolationKey })
    .from(interactiveSessions)
    .innerJoin(agentPods, eq(interactiveSessions.podId, agentPods.id))
    .where(eq(interactiveSessions.id, target.id));
  return (
    row?.isolationKey ===
    podIsolationKey({
      workspaceId: target.workspaceId,
      ownerUserId: target.userId,
      isolationPurpose: `session:${target.id}`,
    })
  );
}

export async function createSessionShare(
  kind: SessionKind,
  target: SessionTarget,
  actor: SessionActor,
  hours: number,
) {
  if (
    !target.userId ||
    target.userId !== actor.id ||
    !target.workspaceId ||
    target.workspaceId !== actor.workspaceId ||
    !(await member(actor.id, target.workspaceId))
  ) {
    throw new Error("Only the session owner can share it with their organization");
  }
  if (kind === "pod" && !(await isShareablePod(target))) {
    throw new Error(
      "This session uses a legacy or unavailable pod. Start an isolated session before sharing.",
    );
  }
  const token = randomBytes(32).toString("base64url");
  const [share] = await db
    .insert(sessionShares)
    .values({
      kind,
      targetId: target.id,
      ownerUserId: actor.id,
      workspaceId: target.workspaceId,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + hours * 3600_000),
    })
    .returning();
  return { id: share.id, expiresAt: share.expiresAt, token };
}

export async function redeemSessionShare(token: string, actor: SessionActor) {
  const [share] = await db
    .select()
    .from(sessionShares)
    .where(
      and(
        eq(sessionShares.tokenHash, tokenHash(token)),
        isNull(sessionShares.revokedAt),
        gt(sessionShares.expiresAt, new Date()),
      ),
    );
  if (
    !share ||
    share.workspaceId !== actor.workspaceId ||
    !(await member(actor.id, share.workspaceId)) ||
    !(await member(share.ownerUserId, share.workspaceId))
  )
    return null;
  const target = await shareTarget(share.kind, share.targetId);
  if (!target || target.userId !== share.ownerUserId || target.workspaceId !== share.workspaceId)
    return null;
  if (share.kind === "pod" && !(await isShareablePod(target))) return null;
  await db
    .insert(sessionShareMembers)
    .values({ shareId: share.id, userId: actor.id })
    .onConflictDoNothing();
  return { kind: share.kind, targetId: share.targetId, expiresAt: share.expiresAt };
}

// Single API replica owns live streams; close existing collaborators immediately
// on revocation, and revalidate membership/expiry periodically and before input.
type Socket = {
  close(code?: number, reason?: string): void;
  on(event: "close", cb: () => void): unknown;
};
const collaborators = new Map<string, Set<Socket>>();
const sessionStreams = new Map<string, Set<Socket>>();
export function watchSessionAccess(
  kind: SessionKind,
  target: SessionTarget,
  actor: SessionActor,
  socket: Socket,
) {
  const key = `${kind}:${target.id}`;
  const streams = sessionStreams.get(key) ?? new Set<Socket>();
  streams.add(socket);
  sessionStreams.set(key, streams);
  socket.on("close", () => {
    streams.delete(socket);
    if (!streams.size) sessionStreams.delete(key);
  });
  if (isAuthDisabled()) return async () => true;
  const sockets = collaborators.get(key) ?? new Set<Socket>();
  if (target.userId !== actor.id) {
    sockets.add(socket);
    collaborators.set(key, sockets);
  }
  const check = async () => {
    const allowed = await (async () =>
      (await member(actor.id, target.workspaceId)) &&
      (await canJoinSession(kind, target, actor)))().catch(() => false);
    if (!allowed) socket.close(4403, "Session access expired or was revoked");
    return allowed;
  };
  const timer = setInterval(() => {
    void check();
  }, 10_000);
  timer.unref();
  socket.on("close", () => {
    clearInterval(timer);
    sockets.delete(socket);
    if (!sockets.size) collaborators.delete(key);
  });
  return check;
}

export async function listSessionShares(kind: SessionKind, targetId: string) {
  return db
    .select({
      id: sessionShares.id,
      expiresAt: sessionShares.expiresAt,
      revokedAt: sessionShares.revokedAt,
      createdAt: sessionShares.createdAt,
    })
    .from(sessionShares)
    .where(and(eq(sessionShares.kind, kind), eq(sessionShares.targetId, targetId)));
}

export async function revokeSessionShare(kind: SessionKind, targetId: string, id: string) {
  await db
    .update(sessionShares)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessionShares.id, id),
        eq(sessionShares.kind, kind),
        eq(sessionShares.targetId, targetId),
      ),
    );
  for (const socket of collaborators.get(`${kind}:${targetId}`) ?? [])
    socket.close(4403, "Session sharing revoked");
}

export function closeSessionStreams(kind: SessionKind, id: string) {
  for (const socket of sessionStreams.get(`${kind}:${id}`) ?? [])
    socket.close(4403, "Session ended");
}
