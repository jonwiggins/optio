import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "../db/client.js";
import { foundingWorkspaceId } from "./founding-workspace.js";

/**
 * The deployment's own configuration — rows with no workspace — and which
 * workspaces read it (docs/scope.md, "The deployment's own").
 *
 * The founding workspace (the oldest, which owns the deployment's rows) and
 * callers with no workspace read every deployment row. Any other workspace
 * reads only the rows a deployment admin shares as **deployment defaults**
 * (`deployment_default = true`): it resolves its own rows first and falls
 * back to those, never silently to whatever has no workspace.
 *
 * Every configuration table with a nullable `workspace_id` that pods or
 * lists read — secrets, connections, MCP servers, skills, installed skills,
 * agent settings — goes through these helpers. A new one must too: a row
 * with no workspace is never every workspace's by default.
 */

/** Whether `workspaceId` reads every deployment row, not only the shared ones. */
export async function readsAllDeploymentRows(
  workspaceId: string | null | undefined,
): Promise<boolean> {
  if (!workspaceId) return true;
  return (await foundingWorkspaceId()) === workspaceId;
}

/**
 * The SQL term for "this workspace's rows, plus the deployment rows it may
 * use": undefined (no filter) for a caller with no workspace, as before.
 */
export async function workspaceOrDeploymentDefault(
  workspaceCol: PgColumn,
  deploymentDefaultCol: PgColumn,
  workspaceId: string | null | undefined,
): Promise<SQL | undefined> {
  if (!workspaceId) return undefined;
  const all = await readsAllDeploymentRows(workspaceId);
  return all
    ? or(eq(workspaceCol, workspaceId), isNull(workspaceCol))
    : or(eq(workspaceCol, workspaceId), and(isNull(workspaceCol), eq(deploymentDefaultCol, true)));
}

/** Whether a row (by its workspace and flag) is one `workspaceId` may read. */
export async function mayReadRow(
  row: { workspaceId: string | null; deploymentDefault?: boolean | null },
  workspaceId: string | null | undefined,
): Promise<boolean> {
  if (!workspaceId) return true;
  if (row.workspaceId) return row.workspaceId === workspaceId;
  if (row.deploymentDefault) return true;
  return readsAllDeploymentRows(workspaceId);
}

/** The configuration tables whose deployment rows a deployment admin shares. */
export type ShareableTable = "connections" | "mcp_servers" | "custom_skills" | "installed_skills";

/**
 * Share a deployment row (no workspace) with every workspace, or stop. False
 * when `id` isn't a deployment row of `table`. The caller has checked
 * deployment authority.
 */
export async function setRowDeploymentDefault(
  table: ShareableTable,
  id: string,
  shared: boolean,
): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE ${sql.identifier(table)}
    SET "deployment_default" = ${shared}, "updated_at" = now()
    WHERE "id" = ${id} AND "workspace_id" IS NULL
    RETURNING "id"`);
  return rows.length > 0;
}
