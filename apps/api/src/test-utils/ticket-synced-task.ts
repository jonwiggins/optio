import { db } from "../db/client.js";
import { tasks, ticketSyncClaims } from "../db/schema.js";
import { insertTask } from "./integration/fixtures.js";

/**
 * A task as the ticket sync makes it from a provider's ticket: the task, and
 * the sync's claim on the ticket naming it (ticket-sync-service.ts). The round
 * trip acts only on such work (ticket-writeback.ts `madeBySyncOf`); a task
 * inserted without the claim is one someone created through the API.
 */
export async function insertSyncedTask(
  overrides: Partial<typeof tasks.$inferInsert>,
  claimSource?: string,
) {
  const task = await insertTask(overrides);
  if (!task.ticketSource || !task.ticketExternalId) {
    throw new Error("A synced task comes from a ticket: give it ticketSource and ticketExternalId");
  }
  await db.insert(ticketSyncClaims).values({
    ticketSource: claimSource ?? task.ticketSource,
    ticketExternalId: task.ticketExternalId,
    repoUrl: task.repoUrl,
    taskId: task.id,
  });
  return task;
}
