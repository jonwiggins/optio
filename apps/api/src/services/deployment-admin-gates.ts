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
