import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import type { Actor } from "./ownership.js";
import { isAuthDisabled } from "./oauth/index.js";
import { isDeploymentAdmin } from "./sign-in-config-service.js";
import { teamMembershipsOf } from "./team-service.js";
import { canSeeWork, getWorkVisibility } from "./work-visibility.js";
import { getUserRole } from "./workspace-service.js";
import type { WebhookScope } from "./webhook-scope.js";

export { webhookScopeOf, type WebhookScope } from "./webhook-scope.js";

/**
 * Who an outbound webhook speaks for, and so which events it receives.
 *
 * Upstream sent every task and Job-run event to every active webhook that
 * subscribed to its name, whatever the workspace and whoever's work it was:
 * any member could make a hook and receive every workspace's and every
 * team's work (title, repo, MR link, error). Now:
 *
 * - A hook receives events for work in **its own workspace** only.
 * - Inside it, only for work its **creator may see** there, by the same rule
 *   as everywhere else (`canSeeWork`, services/work-visibility.ts): under
 *   `teams` visibility a member's hook gets their own, their teams' and what
 *   they started; an admin's hook gets all of the workspace's. A creator who
 *   has left the workspace gets nothing.
 * - A hook with **no workspace** (made before workspaces, or with auth off)
 *   speaks for the whole deployment: only a deployment admin's still
 *   receives anything.
 * - An event that doesn't say whose work it is reaches only those
 *   deployment-wide hooks.
 *
 * Changing a hook, testing it or reading its deliveries (which carry the
 * payloads) is its creator's or a workspace admin's (`webhookRefusal`), so
 * nobody can point someone else's hook at their own address. With auth
 * disabled (local development) everything goes, as everywhere else.
 */

interface HookOwner {
  id: string;
  workspaceId: string | null;
  createdBy: string | null;
}

/** The creator's Actor in a workspace; null when they aren't a member of it. */
async function creatorActor(userId: string, workspaceId: string): Promise<Actor | null> {
  const [role, mine, workVisibility] = await Promise.all([
    getUserRole(workspaceId, userId),
    teamMembershipsOf(userId, workspaceId),
    getWorkVisibility(workspaceId),
  ]);
  if (!role) return null;
  return {
    userId,
    workspaceId,
    isAdmin: role === "admin",
    teamIds: mine.map((m) => m.teamId),
    adminTeamIds: mine.filter((m) => m.role === "admin").map((m) => m.teamId),
    workVisibility,
  };
}

async function isDeploymentAdminId(userId: string): Promise<boolean> {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return !!row && (await isDeploymentAdmin({ id: userId, email: row.email }));
}

/**
 * The hooks of `hooks` that may receive an event about work in `scope`
 * (none given: an event with no owner). Lookups are shared across the hooks
 * of one event.
 */
export async function filterWebhookAudience<T extends HookOwner>(
  hooks: T[],
  scope: WebhookScope | undefined,
): Promise<T[]> {
  if (isAuthDisabled()) {
    return hooks.filter((h) => !h.workspaceId || !scope || h.workspaceId === scope.workspaceId);
  }
  const actors = new Map<string, Promise<Actor | null>>();
  const deployAdmins = new Map<string, Promise<boolean>>();
  const actorFor = (userId: string, workspaceId: string) => {
    const key = `${workspaceId}:${userId}`;
    let found = actors.get(key);
    if (!found) actors.set(key, (found = creatorActor(userId, workspaceId)));
    return found;
  };
  const deployAdmin = (userId: string) => {
    let found = deployAdmins.get(userId);
    if (!found) deployAdmins.set(userId, (found = isDeploymentAdminId(userId)));
    return found;
  };

  const out: T[] = [];
  for (const hook of hooks) {
    if (!hook.createdBy) continue; // nobody it could speak for
    if (!hook.workspaceId) {
      if (await deployAdmin(hook.createdBy)) out.push(hook);
      continue;
    }
    if (!scope || scope.workspaceId !== hook.workspaceId) continue;
    const actor = await actorFor(hook.createdBy, hook.workspaceId);
    if (actor && canSeeWork(scope, actor)) out.push(hook);
  }
  return out;
}

/** Who is asking to change a hook or read its deliveries. */
export interface WebhookRequester {
  id?: string | null;
  email?: string | null;
  workspaceRole?: string | null;
}

/**
 * Why `user` may not change, test or read the deliveries of `hook` — null
 * when they may: its creator, a workspace admin, and for a hook with no
 * workspace a deployment admin only.
 */
export async function webhookRefusal(
  hook: HookOwner,
  user: WebhookRequester | null | undefined,
): Promise<{ status: 403; error: string } | null> {
  if (isAuthDisabled()) return null;
  const refused = {
    status: 403 as const,
    error: "Only the webhook's creator or a workspace admin can change it or see its deliveries",
  };
  if (!user?.id) return refused;
  if (!hook.workspaceId) {
    const admin = await isDeploymentAdmin({ id: user.id, email: user.email ?? null });
    return admin
      ? null
      : { status: 403, error: "Only a deployment admin can change a webhook with no workspace" };
  }
  if (hook.createdBy && hook.createdBy === user.id) return null;
  if (user.workspaceRole === "admin") return null;
  return refused;
}
