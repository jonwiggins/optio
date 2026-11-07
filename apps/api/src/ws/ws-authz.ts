/**
 * Shared workspace authorization for WebSocket log/event streams.
 *
 * Log-stream sockets (`/ws/workflow-runs/:id/logs`, `/ws/persistent-agents/:id/events`,
 * `/ws/pr-reviews/:id/logs`, ...) authenticate the caller but must ALSO confirm
 * the resolved resource belongs to the caller's workspace before streaming any
 * output — otherwise a client could tail another tenant's agent logs live.
 */

import { getUserRole } from "../services/workspace-service.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { type Actor } from "../services/ownership.js";
import { actorTeamFields } from "../services/team-service.js";
import { canSeeWork, getWorkVisibility } from "../services/work-visibility.js";

/** Minimal WebSocket surface — avoids depending on @types/ws. */
interface WsSocket {
  close(code?: number, reason?: string): void;
}

/** WebSocket close code used for a cross-workspace access denial. */
export const WS_CLOSE_FORBIDDEN = 4403;

/** Role hierarchy — keep in sync with ROLE_LEVEL in plugins/auth.ts. */
const ROLE_LEVEL: Record<string, number> = { admin: 3, member: 2, viewer: 1 };

/**
 * Assert that the socket's user and the resolved resource share a workspace.
 *
 * Workspaces are null-normalized before comparison, so:
 *  - a `null` user workspace (auth-disabled synthetic dev user) matches a
 *    `null` resource workspace (local dev resources) and passes, and
 *  - a scoped user (`workspace A`) is denied access to a resource in
 *    `workspace B` or to a legacy null-workspace resource.
 *
 * On mismatch the socket is closed with code 4403 and `false` is returned;
 * callers should stop and release the connection. Returns `true` when access
 * is allowed.
 */
export function assertWorkspace(
  socket: WsSocket,
  userWorkspaceId: string | null | undefined,
  resourceWorkspaceId: string | null | undefined,
): boolean {
  const user = userWorkspaceId ?? null;
  const resource = resourceWorkspaceId ?? null;
  if (user !== resource) {
    socket.close(WS_CLOSE_FORBIDDEN, "Access denied");
    return false;
  }
  return true;
}

/** Apply the same workspace + private-owner rule as the HTTP work routes. */
export function wsActor(user: {
  id: string;
  workspaceId: string | null;
  workspaceRole?: string | null;
}): Actor {
  return {
    userId: user.id,
    workspaceId: user.workspaceId,
    isAdmin: isAuthDisabled() || user.workspaceRole === "admin",
  };
}

/**
 * `wsActor` with what the auth plugin adds to an HTTP request while teams are
 * on: the person's teams and the workspace's "teams" work visibility.
 */
export async function wsWorkActor(user: Parameters<typeof wsActor>[0]): Promise<Actor> {
  const actor = wsActor(user);
  const teams = await actorTeamFields(user.id, user.workspaceId);
  if (!teams.teamIds) return actor;
  Object.assign(actor, teams);
  if ((await getWorkVisibility(user.workspaceId)) === "teams") actor.workVisibility = "teams";
  return actor;
}

export async function assertWorkVisible(
  socket: WsSocket,
  user: Parameters<typeof wsActor>[0],
  resource: {
    workspaceId?: string | null;
    ownerUserId?: string | null;
    ownerTeamId?: string | null;
    createdBy?: string | null;
  },
): Promise<boolean> {
  if (!assertWorkspace(socket, user.workspaceId, resource.workspaceId)) return false;
  if (!canSeeWork(resource, await wsWorkActor(user))) {
    socket.close(WS_CLOSE_FORBIDDEN, "Access denied");
    return false;
  }
  return true;
}

/**
 * Assert that the socket's user holds at least `minimumRole` in the given
 * workspace (falling back to the user's active workspace). Sockets that
 * accept mutating input — the session terminal, session chat, and Optio
 * chat — sit outside the HTTP auth plugin (`/ws/` is a public prefix), so
 * without this check the HTTP-side viewer read-only baseline is bypassable.
 *
 * Auth-disabled local dev always passes. On denial the socket is closed
 * with 4403 and `false` is returned; callers must stop and release the
 * connection slot.
 */
export async function requireWsRole(
  socket: WsSocket,
  user: { id: string; workspaceId: string | null },
  minimumRole: "admin" | "member",
  workspaceId?: string | null,
): Promise<boolean> {
  if (isAuthDisabled()) return true;
  const ws = workspaceId ?? user.workspaceId;
  const role = ws ? await getUserRole(ws, user.id) : null;
  if (!role || (ROLE_LEVEL[role] ?? 0) < ROLE_LEVEL[minimumRole]) {
    socket.close(WS_CLOSE_FORBIDDEN, `Requires ${minimumRole} role`);
    return false;
  }
  return true;
}
