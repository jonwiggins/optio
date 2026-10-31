import type { WorkspaceRole } from "@optio/shared";
import { normalizeAccessGroups } from "./workspace-groups.js";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { workspaces } from "../db/schema.js";
import { logAction } from "./optio-action-service.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isAuthDisabled } from "./oauth/index.js";
import { isDeploymentAdmin } from "./sign-in-config-service.js";
import { workspaceCreationPolicy } from "./deployment-settings.js";

/**
 * Only a **deployment admin** changes what belongs to the whole deployment
 * rather than to one workspace:
 *
 * - **The deployment settings** (routes/deployment-settings.ts): anyone
 *   signed in reads them, a deployment admin changes them.
 * - **Creating a workspace**, when the deployment lets only its admins
 *   (`workspaces.creation`: Settings → Access → Workspaces, or
 *   `OPTIO_WORKSPACE_CREATION` / chart `workspaces.creation`; default
 *   `everyone`, as before). Under `admins`, people still get their workspace
 *   by signing in (the organization's).
 *
 * With auth disabled everything goes: the local dev user acts as the admin.
 */

export const ACCESS_GROUPS_REFUSAL =
  "Only a deployment admin opens a workspace to directory groups";

export const WORKSPACE_CREATION_REFUSAL =
  "Only a deployment admin creates workspaces here — ask one for access to a workspace";

/** Whether the request's person is a deployment admin (everyone, with auth disabled). */
export async function requesterIsDeploymentAdmin(req: FastifyRequest): Promise<boolean> {
  if (isAuthDisabled()) return true;
  return !!req.user && (await isDeploymentAdmin(req.user));
}

/**
 * 403 unless the requester is a deployment admin. Resolves to true when it
 * refused (the 403 is sent), and the handler stops there:
 *
 *   if (await refuseUnlessDeploymentAdmin(req, reply, msg)) return reply;
 *
 * It never resolves to the reply itself: a Fastify reply is thenable, so an
 * async function that returns it resolves to `undefined` once the reply is
 * sent — the caller's test would always be false and it would go on to do
 * what it had just refused.
 */
export async function refuseUnlessDeploymentAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  error: string,
): Promise<boolean> {
  if (await requesterIsDeploymentAdmin(req)) return false;
  void reply.status(403).send({ error });
  return true;
}

/** Why `req` may not create a workspace now; null when it may. */
export async function workspaceCreationRefusal(req: FastifyRequest): Promise<string | null> {
  // The policy first: under the default, `everyone`, nobody is asked who they are.
  if ((await workspaceCreationPolicy()).value === "everyone") return null;
  if (await requesterIsDeploymentAdmin(req)) return null;
  return WORKSPACE_CREATION_REFUSAL;
}

/** Whether `req` may create a workspace now (for the web app's "New workspace"). */
export async function mayCreateWorkspace(req: FastifyRequest): Promise<boolean> {
  return (await workspaceCreationRefusal(req)) === null;
}

/**
 * Whether a create / update body changes who joins by group. Only a change
 * counts: a body that repeats the workspace's current groups and role (a
 * client sending its whole form) isn't refused.
 */
export function changesAccessGroups(
  body: { accessGroups?: string[]; accessGroupsRole?: WorkspaceRole },
  current?: { accessGroups?: string[] | null; accessGroupsRole?: string | null } | null,
): boolean {
  if (body.accessGroups !== undefined) {
    const next = normalizeAccessGroups(body.accessGroups);
    const now = [...(current?.accessGroups ?? [])].sort();
    if ("error" in next) return true;
    if (next.groups.length !== now.length || next.groups.some((g, i) => g !== now[i])) return true;
  }
  if (body.accessGroupsRole !== undefined) {
    const nowRole = current?.accessGroupsRole === "viewer" ? "viewer" : "member";
    // A new workspace starts at "member".
    if (body.accessGroupsRole !== nowRole) return true;
  }
  return false;
}

type AccessGroupsBody = { accessGroups?: string[]; accessGroupsRole?: WorkspaceRole };

/** Why `req` may not create this workspace (with these groups); null when it may. */
export async function workspaceCreateRefusal(
  req: FastifyRequest,
  body: AccessGroupsBody,
): Promise<string | null> {
  const refusal = await workspaceCreationRefusal(req);
  if (refusal) return refusal;
  if (changesAccessGroups(body) && !(await requesterIsDeploymentAdmin(req))) {
    return ACCESS_GROUPS_REFUSAL;
  }
  return null;
}

/** Why `req` may not change who joins workspace `id` by group; null when it may (or doesn't). */
export async function accessGroupsUpdateRefusal(
  req: FastifyRequest,
  id: string,
  body: AccessGroupsBody,
): Promise<string | null> {
  if (body.accessGroups === undefined && body.accessGroupsRole === undefined) return null;
  if (await requesterIsDeploymentAdmin(req)) return null;
  const [current] = await db
    .select({
      accessGroups: workspaces.accessGroups,
      accessGroupsRole: workspaces.accessGroupsRole,
    })
    .from(workspaces)
    .where(eq(workspaces.id, id));
  return changesAccessGroups(body, current ?? {}) ? ACCESS_GROUPS_REFUSAL : null;
}

/**
 * The action log's record of a workspace made, or opened to groups (fire and
 * forget). The log keeps only allowlisted params (optio-action-service.ts),
 * so the groups and role go in its result.
 */
export function logWorkspaceAccessChange(
  req: FastifyRequest,
  action: "workspace.create" | "workspace.access_groups",
  workspaceId: string,
  body: AccessGroupsBody & { name?: string },
): void {
  logAction({
    workspaceId,
    userId: req.user?.id,
    action,
    params: {
      id: workspaceId,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.accessGroups !== undefined ? { count: body.accessGroups.length } : {}),
    },
    result: {
      id: workspaceId,
      ...(body.accessGroups !== undefined ? { accessGroups: body.accessGroups } : {}),
      ...(body.accessGroupsRole !== undefined ? { accessGroupsRole: body.accessGroupsRole } : {}),
    },
    success: true,
  }).catch(() => {});
}
