import type { SessionUser } from "../services/session-service.js";
import type { Actor } from "../services/ownership.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { getUserRole } from "../services/workspace-service.js";
import { teamMembershipsOf } from "../services/team-service.js";
import { getWorkVisibility } from "../services/work-visibility.js";

/**
 * The Actor behind a WebSocket, for the work-visibility rules
 * (services/work-visibility.ts). `/ws/` sits outside the auth plugin, so a
 * socket's user arrives without the role, teams and visibility mode the
 * plugin puts on `req.user`: they are looked up here, in the user's
 * workspace, as the plugin does. Auth-disabled dev is one user who sees
 * everything.
 */
export async function wsActor(user: SessionUser): Promise<Actor> {
  if (isAuthDisabled()) {
    return { userId: user.id, workspaceId: user.workspaceId, isAdmin: true };
  }
  return (await actorWithRole(user, user.workspaceId ?? null)).actor;
}

/**
 * The same Actor in another workspace — null when the user isn't one of its
 * members. A socket outlives a switch of workspace (the iOS app keeps its
 * `/ws/events` socket), so a frame from another of the user's workspaces is
 * judged by who they are there.
 */
export async function wsActorIn(user: SessionUser, workspaceId: string): Promise<Actor | null> {
  if (isAuthDisabled()) return { userId: user.id, workspaceId, isAdmin: true };
  const { role, actor } = await actorWithRole(user, workspaceId);
  return role ? actor : null;
}

async function actorWithRole(user: SessionUser, workspaceId: string | null) {
  const [role, mine, workVisibility] = await Promise.all([
    workspaceId ? getUserRole(workspaceId, user.id) : null,
    workspaceId ? teamMembershipsOf(user.id, workspaceId) : [],
    getWorkVisibility(workspaceId),
  ]);
  const actor: Actor = {
    userId: user.id,
    workspaceId,
    isAdmin: role === "admin",
    teamIds: mine.map((m) => m.teamId),
    adminTeamIds: mine.filter((m) => m.role === "admin").map((m) => m.teamId),
    workVisibility,
  };
  return { role, actor };
}
