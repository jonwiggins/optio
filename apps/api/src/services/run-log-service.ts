/**
 * The one log store for every agent run: `task_logs` holds the lines of task
 * runs, PR-review runs, and persistent-agent turns alike. Each kind's service
 * keeps its own live event (the WebSocket frames differ per kind); the rows,
 * their filters, and their order live here.
 */
import { and, eq, ilike, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { taskLogs } from "../db/schema.js";

/** Whose line it is. */
export type LogOwner =
  | { taskId: string }
  | { prReviewRunId: string }
  | { persistentAgentTurnId: string };

export interface LogLine {
  content: string;
  stream?: string;
  logType?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type LogRow = typeof taskLogs.$inferSelect;

function ownerFilter(owner: LogOwner): SQL {
  if ("taskId" in owner) return eq(taskLogs.taskId, owner.taskId);
  if ("prReviewRunId" in owner) return eq(taskLogs.prReviewRunId, owner.prReviewRunId);
  return eq(taskLogs.persistentAgentTurnId, owner.persistentAgentTurnId);
}

/** Store one line and return the stored row (its id and timestamp are what live frames carry). */
export async function insertLog(owner: LogOwner, line: LogLine): Promise<LogRow> {
  const [row] = await db
    .insert(taskLogs)
    .values({
      ...owner,
      content: line.content,
      stream: line.stream ?? "stdout",
      logType: line.logType ?? null,
      metadata: line.metadata ?? null,
    })
    .returning();
  return row;
}

/** An owner's lines, oldest first. */
export async function listLogs(
  owner: LogOwner,
  opts: { logType?: string; search?: string; limit?: number; offset?: number } = {},
): Promise<LogRow[]> {
  const conditions = [ownerFilter(owner)];
  if (opts.logType) conditions.push(eq(taskLogs.logType, opts.logType));
  if (opts.search) conditions.push(ilike(taskLogs.content, `%${opts.search}%`));
  let query = db
    .select()
    .from(taskLogs)
    .where(and(...conditions))
    .orderBy(taskLogs.timestamp)
    .$dynamic();
  if (opts.limit) query = query.limit(opts.limit);
  if (opts.offset) query = query.offset(opts.offset);
  return query;
}
