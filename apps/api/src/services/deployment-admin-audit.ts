/**
 * The workspace's record of deployment admins acting in it through the grant
 * (while deployment admins are admins of every workspace): a
 * `workspace.deployment_admin_access` entry in its activity log the first
 * time each day a deployment admin's request there is allowed by the grant
 * rather than a membership (none, or a lower role) — from the web, the CLI or
 * a token alike, since the auth plugin notes it. One entry per admin, per
 * workspace, per UTC day: a Redis key remembers the day (single-key, so it
 * works in cluster mode too).
 */
import { getRedisClient } from "./event-bus.js";
import { logAction } from "./optio-action-service.js";

export const DEPLOYMENT_ADMIN_ACCESS_ACTION = "workspace.deployment_admin_access";

const DAY_KEY_TTL_SECONDS = 2 * 24 * 60 * 60;

/** The Redis key that remembers a day's entry was written. */
export function accessDayKey(workspaceId: string, userId: string, now = new Date()): string {
  return `optio:deployment-admin-access:${workspaceId}:${userId}:${now.toISOString().slice(0, 10)}`;
}

/**
 * Write the day's entry unless it is written already. Returns whether this
 * call wrote it. The auth plugin calls it without waiting; a Redis or
 * database failure loses one entry, never the request.
 */
export async function noteDeploymentAdminAccess(
  workspaceId: string,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  const first = await getRedisClient().set(
    accessDayKey(workspaceId, userId, now),
    "1",
    "EX",
    DAY_KEY_TTL_SECONDS,
    "NX",
  );
  if (first !== "OK") return false;
  await logAction({
    workspaceId,
    userId,
    action: DEPLOYMENT_ADMIN_ACCESS_ACTION,
    params: {},
    result: { workspaceId, role: "admin", via: "deployment_admin" },
    success: true,
  });
  return true;
}
