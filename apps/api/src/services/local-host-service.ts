import { and, eq, isNull, lt } from "drizzle-orm";
import {
  normalizeRepoUrl,
  LOCAL_HOST_OFFLINE_AFTER_MS,
  type AgentLimitWindow,
  type LocalHostAgentLimits,
  type LocalHostDir,
} from "@optio/shared";
import { db } from "../db/client.js";
import {
  localBlueprints,
  localHosts,
  localTerminals,
  taskConfigs,
  tasks,
  workflows,
} from "../db/schema.js";
import { logger } from "../logger.js";
import { publishLocalChanged } from "./event-bus.js";
import * as relay from "./local-relay.js";
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
  // iOS + Android: Watch phase + one-shot "laptop unreachable" alert (no-op unless APNs or FCM is configured).
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
  /** The id this server gave the daemon last time (it keeps one per server). */
  hostId?: string;
}

/**
 * Daemon pairing. The machine is the row whose id its daemon was given last
 * time, so a laptop keeps its terminals, automations, and resumable
 * sessions when its hostname changes (macOS renames itself as it moves
 * between networks); failing that, the caller's row with this hostname;
 * failing that, a new row.
 */
export async function registerHost(input: RegisterHostInput): Promise<LocalHostRow> {
  const dirs = sanitizeDirs(input.dirs);
  const [byName] = await db
    .select()
    .from(localHosts)
    .where(and(ownedBy(input.userId), eq(localHosts.hostname, input.hostname)));

  let existing: LocalHostRow | undefined = byName;
  let hostname = input.hostname;
  if (input.hostId && input.hostId !== byName?.id) {
    const [claimed] = await db
      .select()
      .from(localHosts)
      .where(and(ownedBy(input.userId), eq(localHosts.id, input.hostId)));
    if (claimed) {
      if (byName && relay.isHostOnline(byName.id)) {
        // Another of the caller's computers is connected under this name
        // right now: keep the two apart, and this one keeps its old name.
        hostname = claimed.hostname;
      } else if (byName) {
        // The row this machine got under this name before daemons sent their
        // id (it has since been renamed and back): fold it in.
        await mergeHosts(byName.id, claimed.id);
      }
      existing = claimed;
    }
  }

  if (existing) {
    const renamed = existing.hostname !== hostname;
    const [updated] = await db
      .update(localHosts)
      .set({
        hostname,
        // A name that was only ever the hostname follows it; one someone
        // chose stays.
        name:
          input.name ?? (renamed && existing.name === existing.hostname ? hostname : existing.name),
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

export interface HostMergeResult {
  terminals: number;
  automations: number;
  /** Tasks, scheduled Tasks, and Jobs whose run location named the machine. */
  runLocations: number;
}

/**
 * Fold `sourceId` into `targetId`: one computer that was registered twice
 * (its hostname changed under a daemon that didn't send its id yet).
 * Everything that names the source moves to the target — terminals,
 * automations, and Task / scheduled Task / Job run locations — and the
 * source row goes. Terminals parked for the source are the target's to
 * start: its daemon's next hello flushes them, or the caller does.
 */
export async function mergeHosts(sourceId: string, targetId: string): Promise<HostMergeResult> {
  if (sourceId === targetId) throw new Error("Can't merge a machine into itself");
  const result = await db.transaction(async (tx) => {
    const terminals = await tx
      .update(localTerminals)
      .set({ hostId: targetId })
      .where(eq(localTerminals.hostId, sourceId))
      .returning({ id: localTerminals.id });
    const automations = await tx
      .update(localBlueprints)
      .set({ hostId: targetId, updatedAt: new Date() })
      .where(eq(localBlueprints.hostId, sourceId))
      .returning({ id: localBlueprints.id });
    const movedTasks = await tx
      .update(tasks)
      .set({ localHostId: targetId })
      .where(eq(tasks.localHostId, sourceId))
      .returning({ id: tasks.id });
    const movedConfigs = await tx
      .update(taskConfigs)
      .set({ localHostId: targetId })
      .where(eq(taskConfigs.localHostId, sourceId))
      .returning({ id: taskConfigs.id });
    const movedJobs = await tx
      .update(workflows)
      .set({ localHostId: targetId })
      .where(eq(workflows.localHostId, sourceId))
      .returning({ id: workflows.id });
    const [source] = await tx
      .delete(localHosts)
      .where(eq(localHosts.id, sourceId))
      .returning({ userId: localHosts.userId });
    return {
      userId: source?.userId ?? null,
      moved: {
        terminals: terminals.length,
        automations: automations.length,
        runLocations: movedTasks.length + movedConfigs.length + movedJobs.length,
      },
    };
  });
  logger.info({ sourceId, targetId, ...result.moved }, "local: merged hosts");
  for (const hostId of [sourceId, targetId]) {
    await publishLocalChanged({ terminalId: null, hostId, userId: result.userId }).catch((err) =>
      logger.warn({ err, hostId }, "local: failed to publish host merge"),
    );
  }
  return result.moved;
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

/**
 * The allowlist the daemon reported after changing it on Optio's request
 * (see local-dirs-service.ts). Returns the updated row, or null when the
 * host is gone.
 */
export async function setHostDirs(id: string, dirs: LocalHostDir[]): Promise<LocalHostRow | null> {
  const [row] = await db
    .update(localHosts)
    .set({ dirs: sanitizeDirs(dirs), updatedAt: new Date() })
    .where(eq(localHosts.id, id))
    .returning();
  if (!row) return null;
  await publishLocalChanged({ terminalId: null, hostId: row.id, userId: row.userId }).catch((err) =>
    logger.warn({ err, hostId: row.id }, "local: failed to publish host dirs change"),
  );
  return row;
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

function cleanWindow(raw: unknown): AgentLimitWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) return null;
  const resets =
    typeof w.resetsAt === "string" && !isNaN(Date.parse(w.resetsAt))
      ? new Date(w.resetsAt).toISOString()
      : null;
  return {
    usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
    windowMinutes:
      typeof w.windowMinutes === "number" && Number.isFinite(w.windowMinutes)
        ? Math.max(0, Math.round(w.windowMinutes))
        : null,
    resetsAt: resets,
  };
}

/** Validate a daemon-supplied limits report; unknown agents are dropped. */
export function sanitizeAgentLimits(input: unknown): LocalHostAgentLimits {
  const out: LocalHostAgentLimits = {};
  if (!input || typeof input !== "object") return out;
  const codex = (input as Record<string, unknown>).codex;
  if (codex && typeof codex === "object") {
    const c = codex as Record<string, unknown>;
    const primary = cleanWindow(c.primary);
    const secondary = cleanWindow(c.secondary);
    const observed =
      typeof c.observedAt === "string" && !isNaN(Date.parse(c.observedAt))
        ? new Date(c.observedAt).toISOString()
        : null;
    if ((primary || secondary) && observed) {
      out.codex = {
        primary,
        secondary,
        planType: typeof c.planType === "string" ? c.planType.slice(0, 40) : null,
        observedAt: observed,
      };
    }
  }
  return out;
}

export async function handleAgentLimits(hostId: string, limits: unknown): Promise<void> {
  const clean = sanitizeAgentLimits(limits);
  const [row] = await db
    .update(localHosts)
    .set({ agentLimits: clean, updatedAt: new Date() })
    .where(eq(localHosts.id, hostId))
    .returning();
  if (row) {
    await publishLocalChanged({ terminalId: null, hostId: row.id, userId: row.userId }).catch(
      (err) => logger.warn({ err }, "local: failed to publish host limits change"),
    );
  }
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
