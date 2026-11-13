import type { FastifyReply, FastifyRequest } from "fastify";
import { hasDeploymentAuthority } from "../plugins/auth.js";
import { z } from "zod";
import {
  mayReadRow,
  setRowDeploymentDefault,
  type ShareableTable,
} from "../services/deployment-defaults.js";

/**
 * The workspace rule for one configuration row (a connection, an MCP server,
 * a skill) before the caller sees or changes it (docs/scope.md):
 *
 * - another workspace's row: 404, as if it didn't exist;
 * - a deployment row (no workspace) the caller's workspace doesn't read — an
 *   unshared one, outside the founding workspace: 404;
 * - changing a deployment row: only with deployment authority (403 for a
 *   workspace admin, who would otherwise change what every workspace runs).
 *
 * Sends the reply and returns false when refused.
 */
export async function allowWorkspaceRow(
  req: FastifyRequest,
  reply: FastifyReply,
  row: { workspaceId?: string | null; deploymentDefault?: boolean | null },
  access: "see" | "change",
  notFound: string,
): Promise<boolean> {
  const workspaceId = req.user?.workspaceId ?? null;
  const target = { workspaceId: row.workspaceId ?? null, deploymentDefault: row.deploymentDefault };
  if (!(await mayReadRow(target, workspaceId))) {
    reply.status(404).send({ error: notFound });
    return false;
  }
  if (
    access === "change" &&
    workspaceId &&
    !target.workspaceId &&
    !(await hasDeploymentAuthority(req))
  ) {
    reply.status(403).send({
      error: "This belongs to the deployment: only a deployment admin can change it",
    });
    return false;
  }
  return true;
}

/** The PATCH body field that shares a deployment row (deployment admins only). */
export const deploymentDefaultField = z
  .boolean()
  .optional()
  .describe(
    "Deployment rows only (no workspace; a deployment admin's): share it with every " +
      "workspace (true) or keep it to the founding workspace (false)",
  );

/**
 * Apply a PATCH's `deploymentDefault`, after `allowWorkspaceRow(…, "change")`
 * (which already demanded deployment authority for a deployment row). A
 * workspace's own row can't be shared: 400. Returns false when refused.
 */
export async function applyDeploymentDefault(
  reply: FastifyReply,
  table: ShareableTable,
  row: { id: string; workspaceId?: string | null },
  shared: boolean | undefined,
): Promise<boolean> {
  if (shared === undefined) return true;
  if (row.workspaceId) {
    reply.status(400).send({ error: "Only the deployment's own rows can be shared" });
    return false;
  }
  await setRowDeploymentDefault(table, row.id, shared);
  return true;
}
