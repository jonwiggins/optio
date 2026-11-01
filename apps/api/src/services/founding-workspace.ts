import { asc } from "drizzle-orm";
import { db } from "../db/client.js";
import { workspaces } from "../db/schema.js";

/**
 * The deployment's founding workspace: its oldest. What the deployment
 * itself owns — global secrets, ticket providers — belongs to it, and its
 * admins stand in for a deployment admin until someone holds that role
 * (`requireDeploymentAdmin`). Anyone signed in can create a workspace, so
 * no other one counts. Null when there is none.
 */
export async function foundingWorkspaceId(): Promise<string | null> {
  const [first] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  return first?.id ?? null;
}
