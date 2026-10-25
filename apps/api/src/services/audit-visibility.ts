/**
 * Who reads which action-log rows outside the Audit page (docs/audit.md):
 * the Activity feed's actions (`routes/activity.ts`) and upstream's
 * `GET /api/optio/actions` (`routes/optio.ts`).
 *
 * - A member reads their workspace's rows, without the admin-only actions
 *   (`ADMIN_ONLY_ACTION_PREFIXES`: sign-ins, keys, tokens, merges, the
 *   audit's own).
 * - A workspace admin reads their workspace's rows and the legacy rows
 *   without a workspace (upstream's rule), except the deployment-wide audit
 *   entries (`DEPLOYMENT_WIDE_ACTION_PREFIXES`: refused sign-ins, sign-in
 *   settings, deployment admins).
 * - A deployment admin reads those too. With auth disabled (local dev) the
 *   caller reads everything.
 *
 * A separate file so audit.ts (imported by the sign-in routes) needn't
 * import the sign-in configuration.
 */
import type { FastifyRequest } from "fastify";
import { sql, type SQL } from "drizzle-orm";
import { isAuthDisabled } from "./oauth/index.js";
import { isDeploymentAdmin } from "./sign-in-config-service.js";
import { notAdminOnlyAction, notDeploymentWideAction } from "./audit.js";

/** Whether the caller reads the deployment-wide entries (a deployment admin, or auth disabled). */
export async function readsDeploymentWideActions(req: FastifyRequest): Promise<boolean> {
  if (isAuthDisabled()) return true;
  if (!req.user) return false;
  return isDeploymentAdmin(req.user).catch(() => false);
}

/**
 * The extra condition on action rows a workspace admin who isn't a
 * deployment admin gets (undefined for everyone else). Members are already
 * held to their own workspace, which has no deployment-wide entries.
 */
export async function deploymentWideActionFilter(
  req: FastifyRequest,
  cols: { workspace: SQL; action: SQL },
): Promise<SQL | undefined> {
  if (await readsDeploymentWideActions(req)) return undefined;
  return notDeploymentWideAction(cols.workspace, cols.action);
}

/** The whole rule above as one condition on action rows (undefined = everything). */
export async function actionsVisibleTo(
  req: FastifyRequest,
  cols: { workspace: SQL; action: SQL },
): Promise<SQL | undefined> {
  if (isAuthDisabled()) return undefined;
  if (!req.user) return sql`false`;
  const wsId = req.user.workspaceId ?? null;
  if (req.user.workspaceRole !== "admin") {
    if (!wsId) return sql`false`;
    return sql`(${cols.workspace} = ${wsId} AND ${notAdminOnlyAction(cols.action)})`;
  }
  const own = wsId
    ? sql`(${cols.workspace} = ${wsId} OR ${cols.workspace} IS NULL)`
    : sql`${cols.workspace} IS NULL`;
  const wide = await deploymentWideActionFilter(req, cols);
  return wide ? sql`(${own} AND ${wide})` : own;
}
