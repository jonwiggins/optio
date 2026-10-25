/**
 * The one log store for every agent run: `task_logs` holds the lines of task
 * runs, PR-review runs, and persistent-agent turns alike. Each kind's service
 * keeps its own live event (the WebSocket frames differ per kind); the rows,
 * their filters, and their order live here.
 */
import { and, eq, ilike, type SQL } from "drizzle-orm";
import { sanitizeJson, stripNul } from "@optio/shared";
import { db } from "../db/client.js";
import { persistentAgentTurns, prReviewRuns, taskLogs, workRuns } from "../db/schema.js";
import { logger } from "../logger.js";

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

/**
 * A line as `task_logs` can hold it: agent output carries a NUL now and
 * then, and Postgres rejects one in `content` (text) and in any string of
 * `metadata` (jsonb) — which used to fail the insert, and with it the run.
 * Every writer of the table passes through here, so a NUL reads as U+FFFD.
 */
function cleanLine(line: LogLine): LogLine {
  return {
    ...line,
    content: stripNul(line.content),
    metadata: line.metadata ? sanitizeJson(line.metadata) : line.metadata,
  };
}

/** Store one line and return the stored row (its id and timestamp are what live frames carry). */
export async function insertLog(owner: LogOwner, line: LogLine): Promise<LogRow> {
  const clean = cleanLine(line);
  const [row] = await db
    .insert(taskLogs)
    .values({
      ...owner,
      content: clean.content,
      stream: clean.stream ?? "stdout",
      logType: clean.logType ?? null,
      metadata: clean.metadata ?? null,
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
    .orderBy(taskLogs.timestamp, taskLogs.id)
    .$dynamic();
  if (opts.limit) query = query.limit(opts.limit);
  if (opts.offset) query = query.offset(opts.offset);
  return query;
}

// ── Runs under the run protocol (docs/plans/scale-out.md §1–2) ──────────────

/**
 * The rows an agent run lives in: a task or Job run (`work-run`, a row of
 * the `tasks` table, which both run views read), a PR-review run, a
 * persistent-agent turn. Each carries the attachment columns.
 */
export type RunRowKind = "work-run" | "review-run" | "turn";

export interface RunRowRef {
  kind: RunRowKind;
  id: string;
}

/** The table a run row lives in. */
export function runRowTable(kind: RunRowKind) {
  switch (kind) {
    case "work-run":
      return workRuns;
    case "review-run":
      return prReviewRuns;
    case "turn":
      return persistentAgentTurns;
  }
}

/** Whose log lines a run row's are. */
export function logOwnerOf(ref: RunRowRef): LogOwner {
  switch (ref.kind) {
    case "work-run":
      return { taskId: ref.id };
    case "review-run":
      return { prReviewRunId: ref.id };
    case "turn":
      return { persistentAgentTurnId: ref.id };
  }
}

/** The run columns a new attempt of a run starts from: no agent, nothing consumed, nobody attached. */
export const NEW_ATTEMPT_EXECUTION = {
  execState: null,
  execPid: null,
  consumedBytes: 0,
  attachedBy: null,
  attachLeaseUntil: null,
} as const;

/** Where a requeue runs: a transaction (or the client, for one statement). */
type Executor = Pick<typeof db, "select" | "update">;

/** The agent of a run's previous attempt, as a requeue found it started. */
export interface PreviousAttempt {
  runId: string;
  podId: string | null;
  pid: number | null;
}

/**
 * Sending a run back to `queued` starts a new attempt — and every path that
 * does it (a task's transition to queued and its force-redo, a Job run's
 * retry or requeue, a review run's requeue) goes through here. In the
 * caller's transaction, the run's row is locked and read, then `write` does
 * the caller's own state write with NEW_ATTEMPT_EXECUTION merged in: no
 * agent, nothing consumed, nobody attached (docs/plans/scale-out.md §2) —
 * the last attempt's lease or exit is no claim on the new one. When the
 * last attempt's agent was started and the write happened, that agent is
 * returned: the caller passes it to `stopPreviousAttempt` once the
 * transaction has committed.
 */
export async function resetRunAttempt<T>(
  tx: Executor,
  ref: RunRowRef,
  write: (reset: typeof NEW_ATTEMPT_EXECUTION) => Promise<T | null | undefined>,
): Promise<{ result: T | null; previous: PreviousAttempt | null }> {
  const previous = await readStartedAttempt(tx, ref);
  const result = (await write(NEW_ATTEMPT_EXECUTION)) ?? null;
  return { result, previous: result ? previous : null };
}

async function readStartedAttempt(tx: Executor, ref: RunRowRef): Promise<PreviousAttempt | null> {
  let row: { execState: string | null; execPid: number | null; podId: string | null } | undefined;
  switch (ref.kind) {
    case "work-run":
      [row] = await tx
        .select({
          execState: workRuns.execState,
          execPid: workRuns.execPid,
          podId: workRuns.lastPodId,
        })
        .from(workRuns)
        .where(eq(workRuns.id, ref.id))
        .for("update");
      break;
    case "review-run":
      [row] = await tx
        .select({
          execState: prReviewRuns.execState,
          execPid: prReviewRuns.execPid,
          podId: prReviewRuns.podId,
        })
        .from(prReviewRuns)
        .where(eq(prReviewRuns.id, ref.id))
        .for("update");
      break;
    case "turn":
      [row] = await tx
        .select({
          execState: persistentAgentTurns.execState,
          execPid: persistentAgentTurns.execPid,
          podId: persistentAgentTurns.podId,
        })
        .from(persistentAgentTurns)
        .where(eq(persistentAgentTurns.id, ref.id))
        .for("update");
      break;
  }
  if (row?.execState !== "started") return null;
  return { runId: ref.id, podId: row.podId, pid: row.execPid };
}

/**
 * After a requeue committed: TERM to the previous attempt's agent, from
 * whichever instance requeued it, scoped to that attempt's supervisor pid
 * so the new attempt in the same run directory is never hit. Fire and
 * forget: the attempt's own job, if one still streams it, stops it too.
 */
export function stopPreviousAttempt(previous: PreviousAttempt | null): void {
  if (!previous) return;
  import("./run-attachment.js")
    .then(({ signalRun }) =>
      signalRun(previous.podId, previous.runId, "TERM", {
        pid: previous.pid ?? undefined,
      }),
    )
    .catch((err) =>
      logger.warn({ err, runId: previous.runId }, "Failed to stop the previous attempt's agent"),
    );
}

/** This instance no longer holds the run: another one claimed it, or it was requeued. */
export class AttachmentLostError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is no longer attached to this instance`);
    this.name = "AttachmentLostError";
  }
}

/**
 * Stores a batch of a run's log lines and advances its consumed offset from
 * `offsets.from` to `offsets.to` in one transaction: the rows exist iff the
 * offset moved, so a run that changes instances never gets a duplicate or a
 * gap. The offset write is a CAS on the hold (`holder`, its mark in
 * `attached_by`) and on the old offset; when it fails the transaction rolls
 * back and AttachmentLostError is thrown. Returns the stored rows in order,
 * for the live frames.
 */
export async function appendRunLogsBatch(
  ref: RunRowRef,
  entries: LogLine[],
  offsets: { from: number; to: number },
  holder: string,
): Promise<LogRow[]> {
  const owner = logOwnerOf(ref);
  const table = runRowTable(ref.kind);
  return db.transaction(async (tx) => {
    const rows =
      entries.length > 0
        ? await tx
            .insert(taskLogs)
            .values(
              entries.map(cleanLine).map((line) => ({
                ...owner,
                content: line.content,
                stream: line.stream ?? "stdout",
                logType: line.logType ?? null,
                metadata: line.metadata ?? null,
              })),
            )
            .returning()
        : [];
    const advanced = await tx
      .update(table)
      .set({ consumedBytes: offsets.to })
      .where(
        and(
          eq(table.id, ref.id),
          eq(table.attachedBy, holder),
          eq(table.consumedBytes, offsets.from),
        ),
      )
      .returning({ id: table.id });
    if (advanced.length === 0) throw new AttachmentLostError(ref.id);
    return rows;
  });
}
