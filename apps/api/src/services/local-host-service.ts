import { and, eq, isNull, lt } from "drizzle-orm";
import { normalizeRepoUrl, LOCAL_HOST_OFFLINE_AFTER_MS, type LocalHostDir } from "@optio/shared";
import { db } from "../db/client.js";
import { localHosts } from "../db/schema.js";
import { logger } from "../logger.js";
import { publishLocalChanged } from "./event-bus.js";
import { isAuthDisabled } from "./oauth/index.js";

export type LocalHostRow = typeof localHosts.$inferSelect;

/** Content-free nudge so the cockpit / issues page refresh host online state. */
async function notifyHostChanged(host: {
  id: string;
  userId: string | null;
  state: "online" | "offline";
  name: string;
}): Promise<void> {
  await publishLocalChanged({ terminalId: null, hostId: host.id, userId: host.userId }).catch(
    (err) => logger.warn({ err, hostId: host.id }, "local: failed to publish host change"),
  );
  // iOS: Watch phase + one-shot "laptop unreachable" alert (no-op unless APNs is configured).
  import("./glance-service.js")
    .then(({ onLocalHostChanged }) => onLocalHostChanged(host))
    .catch((err) => logger.warn({ err, hostId: host.id }, "local: glance host hook failed"));
}

const HOST_CHANGE_COLUMNS = {
  id: localHosts.id,
  userId: localHosts.userId,
  state: localHosts.state,
  name: localHosts.name,
};

/** Ownership scope: rows with null userId belong to the auth-disabled dev user. */
function ownedBy(userId: string | null | undefined) {
  return userId ? eq(localHosts.userId, userId) : isNull(localHosts.userId);
}

/**
 * True when `userId` may act on `host`. Null-owner rows only exist in
 * auth-disabled dev installs; they're reachable exactly when auth is disabled
 * (one implicit user) — never by an arbitrary authenticated user in a
 * production install that was previously run without auth.
 */
export function canAccessHost(host: LocalHostRow, userId: string | null | undefined): boolean {
  if (host.userId) return host.userId === (userId ?? null);
  return isAuthDisabled();
}

export interface RegisterHostInput {
  userId: string | null;
  workspaceId: string | null;
  name?: string;
  hostname: string;
  platform: string;
  arch?: string;
  daemonVersion?: string;
  dirs: LocalHostDir[];
}

/** Daemon pairing: upsert by (userId, hostname). */
export async function registerHost(input: RegisterHostInput): Promise<LocalHostRow> {
  const dirs = sanitizeDirs(input.dirs);
  const [existing] = await db
    .select()
    .from(localHosts)
    .where(and(ownedBy(input.userId), eq(localHosts.hostname, input.hostname)));

  if (existing) {
    const [updated] = await db
      .update(localHosts)
      .set({
        name: input.name ?? existing.name,
        platform: input.platform,
        arch: input.arch ?? existing.arch,
        daemonVersion: input.daemonVersion ?? existing.daemonVersion,
        dirs,
        workspaceId: input.workspaceId ?? existing.workspaceId,
        updatedAt: new Date(),
      })
      .where(eq(localHosts.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(localHosts)
    .values({
      userId: input.userId,
      workspaceId: input.workspaceId,
      name: input.name ?? input.hostname,
      hostname: input.hostname,
      platform: input.platform,
      arch: input.arch,
      daemonVersion: input.daemonVersion,
      dirs,
    })
    .returning();
  return created;
}

export async function getHost(id: string): Promise<LocalHostRow | null> {
  const [row] = await db.select().from(localHosts).where(eq(localHosts.id, id));
  return row ?? null;
}

export async function listHosts(userId: string | null | undefined): Promise<LocalHostRow[]> {
  return db.select().from(localHosts).where(ownedBy(userId));
}

export async function deleteHost(id: string): Promise<boolean> {
  const deleted = await db.delete(localHosts).where(eq(localHosts.id, id)).returning();
  return deleted.length > 0;
}

export async function markHostOnline(
  id: string,
  updates: { dirs?: LocalHostDir[]; daemonVersion?: string },
): Promise<void> {
  const [row] = await db
    .update(localHosts)
    .set({
      state: "online",
      lastSeenAt: new Date(),
      updatedAt: new Date(),
      ...(updates.dirs ? { dirs: sanitizeDirs(updates.dirs) } : {}),
      ...(updates.daemonVersion ? { daemonVersion: updates.daemonVersion } : {}),
    })
    .where(eq(localHosts.id, id))
    .returning(HOST_CHANGE_COLUMNS);
  if (row) await notifyHostChanged(row);
}

export async function markHostOffline(id: string): Promise<void> {
  const [row] = await db
    .update(localHosts)
    .set({ state: "offline", updatedAt: new Date() })
    .where(eq(localHosts.id, id))
    .returning(HOST_CHANGE_COLUMNS);
  if (row) await notifyHostChanged(row);
}

/** Heartbeat from the daemon ping loop. */
export async function touchHost(id: string): Promise<void> {
  await db
    .update(localHosts)
    .set({ lastSeenAt: new Date(), state: "online", updatedAt: new Date() })
    .where(eq(localHosts.id, id));
}

/** Mark hosts offline whose daemon stopped pinging. Returns affected ids. */
export async function sweepStaleHosts(): Promise<string[]> {
  const cutoff = new Date(Date.now() - LOCAL_HOST_OFFLINE_AFTER_MS);
  const stale = await db
    .update(localHosts)
    .set({ state: "offline", updatedAt: new Date() })
    .where(and(eq(localHosts.state, "online"), lt(localHosts.lastSeenAt, cutoff)))
    .returning(HOST_CHANGE_COLUMNS);
  if (stale.length > 0) {
    logger.info({ hostIds: stale.map((h) => h.id) }, "local: marked stale hosts offline");
    for (const row of stale) await notifyHostChanged(row);
  }
  return stale.map((h) => h.id);
}

/** The user's most recently seen online host, for blueprints without a pinned host. */
export async function pickOnlineHost(
  userId: string | null | undefined,
): Promise<LocalHostRow | null> {
  const rows = await db
    .select()
    .from(localHosts)
    .where(and(ownedBy(userId), eq(localHosts.state, "online")));
  rows.sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0));
  return rows[0] ?? null;
}

/**
 * A requested working dir is allowed when it equals an allowlisted dir or is
 * nested under one. Pure string check on absolute paths — the server never
 * sees the host's filesystem. `..` segments are rejected outright.
 */
export function isDirAllowed(host: LocalHostRow, dir: string): boolean {
  const requested = stripTrailingSlash(dir);
  if (!requested.startsWith("/") || requested.split("/").includes("..")) return false;
  return (host.dirs ?? []).some((d) => {
    const allowed = stripTrailingSlash(d.path);
    return requested === allowed || requested.startsWith(`${allowed}/`);
  });
}

/** Find the allowlisted dir whose detected git remote matches `repoUrl`. */
export function findHostDirForRepo(host: LocalHostRow, repoUrl: string): string | null {
  const target = normalizeRepoUrl(repoUrl);
  for (const d of host.dirs ?? []) {
    if (d.repoUrl && normalizeRepoUrl(d.repoUrl) === target) return d.path;
  }
  return null;
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function sanitizeDirs(dirs: LocalHostDir[]): LocalHostDir[] {
  return (dirs ?? [])
    .filter((d) => typeof d.path === "string" && d.path.startsWith("/"))
    .slice(0, 200)
    .map((d) => ({
      path: stripTrailingSlash(d.path),
      ...(d.repoUrl ? { repoUrl: d.repoUrl } : {}),
    }));
}
