import { eq, isNull, or, type SQL } from "drizzle-orm";
import { ticketProviders } from "../db/schema.js";
import { readsAllDeploymentRows } from "./deployment-defaults.js";

/**
 * The ticket providers a workspace reads: its own, plus — for the founding
 * workspace and callers with no workspace — any with no workspace (saved with
 * auth disabled). A workspace's providers match its own repos only
 * (`syncAllTickets`), so two workspaces can point at two Jiras.
 */
export async function ticketProvidersOf(
  workspaceId: string | null | undefined,
): Promise<SQL | undefined> {
  if (!workspaceId) return undefined;
  return (await readsAllDeploymentRows(workspaceId))
    ? or(eq(ticketProviders.workspaceId, workspaceId), isNull(ticketProviders.workspaceId))
    : eq(ticketProviders.workspaceId, workspaceId);
}
