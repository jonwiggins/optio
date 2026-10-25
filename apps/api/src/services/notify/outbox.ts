import { Queue, type JobsOptions } from "bullmq";
import { and, asc, count, desc, eq, inArray, lt, min } from "drizzle-orm";
import { db } from "../../db/client.js";
import { notifyOutbox, teams, users } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { getBullMQOptions } from "../redis-config.js";
import { sendEmail, type OutgoingEmail } from "./email.js";
import { hookForTarget, postToHook } from "./chat-hooks.js";
import { chatMessageSummary, type ChatMessage } from "./chat-messages.js";

/**
 * Delivery with retries (docs/notifications.md "When the relay is down").
 *
 * Every email and chat post goes into `notify_outbox` and onto the BullMQ
 * queue `notify-outbox` (job id = row id). The worker
 * (workers/notify-worker.ts) sends it; a failure it may get past (the relay
 * or the chat can't be reached, a 4xx SMTP answer, a 5xx HTTP one) is
 * retried with exponential backoff — 30 s, 1 min, 2 min, … ten tries over
 * about four hours by default (`OPTIO_NOTIFY_RETRY_ATTEMPTS`,
 * `OPTIO_NOTIFY_RETRY_BASE_SECONDS`). Delivered rows are deleted. When the
 * tries run out, or the far end refused it for good (a 5xx SMTP answer to
 * every recipient, a 4xx from the chat, a host the outbound policy blocks),
 * the row stays as **dead**: Settings → Notifications → Undelivered lists it
 * for deployment admins, who retry or discard it; dead rows go after
 * `OPTIO_NOTIFY_DEAD_LETTER_DAYS` (30).
 *
 * The row is the truth, the job only its trigger: the housekeeping tick
 * re-adds the job of any pending row whose job was lost (a Redis restart)
 * — BullMQ ignores the add while that job still waits or backs off.
 *
 * Until the worker runs in this process (`setOutboxActive`), `deliver` sends
 * at once and reports the outcome, without a row: what the unit and
 * integration tests of the senders see, and an API booting.
 */

export const NOTIFY_OUTBOX_QUEUE = "notify-outbox";

export interface RetryPolicy {
  /** Tries in all, the first included. */
  attempts: number;
  /** The first wait; each next one doubles. */
  baseMs: number;
  /** How long a dead row is kept. */
  deadLetterDays: number;
}

function numberEnv(name: string, fallback: number, lo: number, hi: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

export function retryPolicy(): RetryPolicy {
  return {
    attempts: Math.round(numberEnv("OPTIO_NOTIFY_RETRY_ATTEMPTS", 10, 1, 50)),
    baseMs: Math.round(numberEnv("OPTIO_NOTIFY_RETRY_BASE_SECONDS", 30, 0.01, 3600) * 1000),
    deadLetterDays: numberEnv("OPTIO_NOTIFY_DEAD_LETTER_DAYS", 30, 1, 3650),
  };
}

let active = false;

/** Whether deliveries go through the queue (the worker runs in this process). */
export function outboxActive(): boolean {
  return active;
}

/** The worker turns the queue on at start and off when it closes; tests do too. */
export function setOutboxActive(on: boolean): void {
  active = on;
}

let queue: Queue | null = null;

export function outboxQueue(): Queue {
  queue ??= new Queue(NOTIFY_OUTBOX_QUEUE, { ...getBullMQOptions() });
  return queue;
}

export async function closeOutboxQueue(): Promise<void> {
  const q = queue;
  queue = null;
  await q?.close().catch(() => undefined);
}

function jobOptions(id: string): JobsOptions {
  const p = retryPolicy();
  return {
    jobId: id,
    attempts: p.attempts,
    backoff: { type: "exponential", delay: p.baseMs },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

async function enqueue(id: string): Promise<void> {
  try {
    await outboxQueue().add("deliver", { id }, jobOptions(id));
  } catch (err) {
    // The row is kept; the housekeeping tick adds the job again.
    logger.warn({ err, id }, "notify: could not queue a delivery; it is retried later");
  }
}

export type OutboxItem =
  | {
      channel: "email";
      kind: string;
      /** The person it goes to (null: an address given by hand, the Settings test). */
      userId: string | null;
      workspaceId?: string | null;
      email: OutgoingEmail;
    }
  | {
      channel: "chat";
      kind: string;
      /** A person's own hook, or a team's channel — resolved when it is sent. */
      target: { userId: string } | { teamId: string };
      workspaceId?: string | null;
      message: ChatMessage;
    };

export type DeliverResult = { ok: true; queued: boolean } | { ok: false; error: string };

type AttemptResult = { ok: true } | { ok: false; error: string; permanent: boolean };

/**
 * Whether an email's failure stays a failure however often it is tried: no
 * address to send to, or the relay answered 5xx — to every recipient, or to
 * the message itself. Not reaching the relay, a 4xx (greylisting, a full
 * queue) or a refused sign-in (which an admin fixes) are retried.
 */
export function emailFailureIsPermanent(error: string): boolean {
  if (/^No valid recipient address/.test(error)) return true;
  const every = error.match(/refused every recipient: (.*)$/s);
  if (every) {
    const codes = [...every[1].matchAll(/\((\d{3})\b/g)].map((m) => Number(m[1]));
    return codes.length > 0 && codes.every((c) => c >= 500);
  }
  return /refused the message: 5\d\d/.test(error);
}

async function attempt(item: OutboxItem): Promise<AttemptResult> {
  if (item.channel === "email") {
    const r = await sendEmail(item.email);
    return r.ok
      ? { ok: true }
      : { ok: false, error: r.error, permanent: emailFailureIsPermanent(r.error) };
  }
  const hook = await hookForTarget(
    "teamId" in item.target ? { teamId: item.target.teamId } : { userId: item.target.userId },
  );
  // The hook was removed or turned off meanwhile: nothing left to deliver to.
  if (!hook) return { ok: true };
  const r = await postToHook(hook, item.message);
  return r.ok ? { ok: true } : { ok: false, error: r.error, permanent: r.permanent };
}

function summaryOf(item: OutboxItem): string {
  return (item.channel === "email" ? item.email.subject : chatMessageSummary(item.message)).slice(
    0,
    300,
  );
}

/**
 * Send `item`: through the queue when the worker runs here (resolves once
 * it is stored: `queued: true`), else at once. Never throws.
 */
export async function deliver(item: OutboxItem): Promise<DeliverResult> {
  try {
    if (!active) {
      const r = await attempt(item);
      return r.ok ? { ok: true, queued: false } : { ok: false, error: r.error };
    }
    const [row] = await db
      .insert(notifyOutbox)
      .values({
        channel: item.channel,
        kind: item.kind,
        userId:
          item.channel === "email"
            ? item.userId
            : "userId" in item.target
              ? item.target.userId
              : null,
        teamId: item.channel === "chat" && "teamId" in item.target ? item.target.teamId : null,
        workspaceId: item.workspaceId ?? null,
        summary: summaryOf(item),
        payload:
          item.channel === "email"
            ? { email: item.email }
            : { target: item.target, message: item.message },
      })
      .returning({ id: notifyOutbox.id });
    await enqueue(row.id);
    return { ok: true, queued: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ kind: item.kind, channel: item.channel, error }, "notify: not delivered");
    return { ok: false, error };
  }
}

type Row = typeof notifyOutbox.$inferSelect;

function itemOf(row: Row): OutboxItem {
  const p = row.payload as Record<string, unknown>;
  if (row.channel === "email") {
    return {
      channel: "email",
      kind: row.kind,
      userId: row.userId,
      email: p.email as OutgoingEmail,
    };
  }
  return {
    channel: "chat",
    kind: row.kind,
    target: p.target as { userId: string } | { teamId: string },
    message: p.message as ChatMessage,
  };
}

export type ProcessOutcome = "delivered" | "retry" | "dead" | "missing";

/**
 * One try at a pending row (the worker's job): delivered → the row goes;
 * failed → `retry` (the worker throws, BullMQ backs off) until the tries run
 * out or the failure is for good → `dead`.
 */
export async function processOutboxRow(
  id: string,
): Promise<{ outcome: ProcessOutcome; error?: string }> {
  const [row] = await db
    .select()
    .from(notifyOutbox)
    .where(and(eq(notifyOutbox.id, id), eq(notifyOutbox.status, "pending")));
  if (!row) return { outcome: "missing" };
  let r: AttemptResult;
  try {
    r = await attempt(itemOf(row));
  } catch (err) {
    r = { ok: false, error: err instanceof Error ? err.message : String(err), permanent: false };
  }
  if (r.ok) {
    await db.delete(notifyOutbox).where(eq(notifyOutbox.id, id));
    return { outcome: "delivered" };
  }
  const attempts = row.attempts + 1;
  const dead = r.permanent || attempts >= retryPolicy().attempts;
  const now = new Date();
  await db
    .update(notifyOutbox)
    .set({
      attempts,
      lastError: r.error.slice(0, 1000),
      updatedAt: now,
      ...(dead ? { status: "dead" as const, deadAt: now } : {}),
    })
    .where(eq(notifyOutbox.id, id));
  if (dead) {
    logger.warn(
      { id, kind: row.kind, channel: row.channel, attempts, error: r.error },
      "notify: gave up on a delivery; it waits under Undelivered",
    );
  }
  return { outcome: dead ? "dead" : "retry", error: r.error };
}

// ── Housekeeping ────────────────────────────────────────────────────────────

/** How long a pending row's job may be missing before the tick adds it again. */
const RECOVER_AFTER_MS = 2 * 60_000;

/**
 * Re-add the jobs of pending rows that have none (a Redis restart lost them;
 * an add BullMQ already has is ignored), and drop dead rows past their
 * keeping time. Only while the queue is on.
 */
export async function recoverOutbox(
  now = new Date(),
): Promise<{ requeued: number; purged: number }> {
  let requeued = 0;
  if (active) {
    const stale = await db
      .select({ id: notifyOutbox.id })
      .from(notifyOutbox)
      .where(
        and(
          eq(notifyOutbox.status, "pending"),
          lt(notifyOutbox.updatedAt, new Date(now.getTime() - RECOVER_AFTER_MS)),
        ),
      )
      .orderBy(asc(notifyOutbox.createdAt))
      .limit(500);
    for (const { id } of stale) {
      await enqueue(id);
      requeued++;
    }
  }
  const cutoff = new Date(now.getTime() - retryPolicy().deadLetterDays * 86_400_000);
  const purged = await db
    .delete(notifyOutbox)
    .where(and(eq(notifyOutbox.status, "dead"), lt(notifyOutbox.deadAt, cutoff)))
    .returning({ id: notifyOutbox.id });
  return { requeued, purged: purged.length };
}

// ── Dead letters (deployment admins) ────────────────────────────────────────

export interface OutboxCounts {
  pending: number;
  dead: number;
  /** When the oldest delivery still waiting was made. */
  oldestPendingAt: string | null;
}

export async function outboxCounts(): Promise<OutboxCounts> {
  const rows = await db
    .select({ status: notifyOutbox.status, n: count(), oldest: min(notifyOutbox.createdAt) })
    .from(notifyOutbox)
    .groupBy(notifyOutbox.status);
  const of = (s: string) => rows.find((r) => r.status === s);
  const oldest = of("pending")?.oldest;
  return {
    pending: Number(of("pending")?.n ?? 0),
    dead: Number(of("dead")?.n ?? 0),
    oldestPendingAt: oldest ? new Date(oldest as unknown as string).toISOString() : null,
  };
}

export interface DeadLetterView {
  id: string;
  channel: "email" | "chat";
  kind: string;
  summary: string;
  /** An email's address, or whose chat it was for. */
  to: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  deadAt: string | null;
}

export async function listDeadLetters(limit = 100): Promise<DeadLetterView[]> {
  const rows = await db
    .select({
      row: notifyOutbox,
      personName: users.displayName,
      teamName: teams.name,
    })
    .from(notifyOutbox)
    .leftJoin(users, eq(users.id, notifyOutbox.userId))
    .leftJoin(teams, eq(teams.id, notifyOutbox.teamId))
    .where(eq(notifyOutbox.status, "dead"))
    .orderBy(desc(notifyOutbox.deadAt))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(({ row, personName, teamName }) => {
    const p = row.payload as { email?: OutgoingEmail };
    const to =
      row.channel === "email"
        ? (p.email?.to ?? []).join(", ")
        : row.teamId
          ? `${teamName ?? "a team"}'s channel`
          : `${personName ?? "someone"}'s chat hook`;
    return {
      id: row.id,
      channel: row.channel,
      kind: row.kind,
      summary: row.summary,
      to,
      attempts: row.attempts,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
      deadAt: row.deadAt?.toISOString() ?? null,
    };
  });
}

/** Give dead rows a fresh set of tries; how many. */
export async function retryDeadLetters(ids?: string[]): Promise<number> {
  if (ids && !ids.length) return 0;
  const revived = await db
    .update(notifyOutbox)
    .set({ status: "pending", attempts: 0, deadAt: null, updatedAt: new Date() })
    .where(and(eq(notifyOutbox.status, "dead"), ...(ids ? [inArray(notifyOutbox.id, ids)] : [])))
    .returning({ id: notifyOutbox.id });
  for (const { id } of revived) {
    if (active) await enqueue(id);
    else await processOutboxRow(id);
  }
  return revived.length;
}

/** Forget dead rows; how many. */
export async function discardDeadLetters(ids?: string[]): Promise<number> {
  if (ids && !ids.length) return 0;
  const gone = await db
    .delete(notifyOutbox)
    .where(and(eq(notifyOutbox.status, "dead"), ...(ids ? [inArray(notifyOutbox.id, ids)] : [])))
    .returning({ id: notifyOutbox.id });
  return gone.length;
}
