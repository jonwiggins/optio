import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { parseIntEnv } from "@optio/shared";
import { db } from "../db/client.js";
import { interactiveSessions, sessionChatTurns } from "../db/schema.js";
import { INSTANCE_ID } from "./instance.js";
import { acquireLease, releaseLease, renewLease } from "./lease-service.js";
import { logger } from "../logger.js";
import { onSessionBus, publishSessionBus } from "./session-bus.js";

// ── The running turn's lease ────────────────────────────────────────────────
//
// The instance running a chat turn holds the lease `chat-turn:<turnId>` for
// as long as the turn runs (renewed on an interval, released when it
// settles). Recovery — at boot, and on the housekeeping sweep — settles only
// `running` turns whose lease is missing or expired: a turn orphaned by a
// crash is recorded as interrupted within about a lease TTL plus one sweep,
// and a replica booting never touches a turn another instance is running.

const TURN_LEASE_TTL_MS = parseIntEnv("OPTIO_TURN_LEASE_TTL_MS", 60_000);
const TURN_LEASE_RENEW_MS = parseIntEnv("OPTIO_TURN_LEASE_RENEW_MS", 20_000);
export const turnLeaseKey = (turnId: string) => `chat-turn:${turnId}`;

/** turnId → the renew timer of a lease this instance holds. */
const turnLeases = new Map<string, NodeJS.Timeout>();

function holdTurnLease(turnId: string): void {
  const key = turnLeaseKey(turnId);
  const timer = setInterval(() => {
    renewLease(key, TURN_LEASE_TTL_MS)
      // Lapsed (a stalled event loop): take it again. Nobody else takes a
      // turn's lease; if recovery settled the row meanwhile, the turn's
      // control poll stops it.
      .then((held) => (held ? true : acquireLease(key, TURN_LEASE_TTL_MS)))
      .catch((err) => logger.debug({ err, turnId }, "turn lease renew failed"));
  }, TURN_LEASE_RENEW_MS);
  timer.unref?.();
  turnLeases.set(turnId, timer);
}

async function dropTurnLease(turnId: string): Promise<void> {
  const timer = turnLeases.get(turnId);
  if (timer) clearInterval(timer);
  turnLeases.delete(turnId);
  await releaseLease(turnLeaseKey(turnId)).catch(() => {});
}

export async function claimSessionTurn(sessionId: string, requestId: string, prompt: string) {
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  // The lease before the row, so no recovery pass ever sees this turn
  // `running` without a holder.
  const id = randomUUID();
  await acquireLease(turnLeaseKey(id), TURN_LEASE_TTL_MS);
  let turn: typeof sessionChatTurns.$inferSelect | undefined;
  try {
    [turn] = await db
      .insert(sessionChatTurns)
      .values({ id, sessionId, requestId, promptHash, state: "running" })
      .onConflictDoNothing()
      .returning();
  } catch (err) {
    await releaseLease(turnLeaseKey(id)).catch(() => {});
    throw err;
  }
  if (turn) {
    holdTurnLease(turn.id);
    return { accepted: true as const, turn };
  }
  await releaseLease(turnLeaseKey(id)).catch(() => {});
  const [existing] = await db
    .select()
    .from(sessionChatTurns)
    .where(
      and(eq(sessionChatTurns.sessionId, sessionId), eq(sessionChatTurns.requestId, requestId)),
    );
  return {
    accepted: false as const,
    reason: existing
      ? existing.promptHash !== promptHash
        ? "Request ID already belongs to a different prompt"
        : `This prompt was already accepted (${existing.state}); it will not be replayed`
      : "Another turn is running in this session",
  };
}

export async function finishSessionTurn(id: string, completed: boolean) {
  try {
    await db
      .update(sessionChatTurns)
      .set({ state: completed ? "completed" : "interrupted", finishedAt: new Date(), prompt: null })
      .where(and(eq(sessionChatTurns.id, id), eq(sessionChatTurns.state, "running")));
  } finally {
    await dropTurnLease(id);
  }
}

/**
 * Settles the `running` turns no live instance holds (their lease missing or
 * expired) as interrupted — never requeued, as a chat turn's exec cannot be
 * resumed. Runs at boot and on every housekeeping sweep
 * (glance-sweep-worker.ts). Viewers of each settled session are told the
 * session is idle, wherever they are connected. Resolves how many it settled.
 */
export async function recoverSessionTurns(): Promise<number> {
  const rows = await db.execute<{ id: string; session_id: string }>(sql`
    UPDATE "session_chat_turns" AS t
    SET "state" = 'interrupted', "finished_at" = now()
    WHERE t."state" = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM "leases" AS l
        WHERE l."key" = 'chat-turn:' || t."id"::text AND l."expires_at" > now()
      )
    RETURNING t."id", t."session_id"`);
  for (const row of rows) {
    const { expireSessionApprovals } = await import("./session-tool-approval.js");
    await expireSessionApprovals(row.id);
    broadcastSessionChat(row.session_id, { type: "status", status: "idle", recovery: "resumable" });
  }
  if (rows.length > 0) logger.info({ settled: rows.length }, "Settled orphaned chat turns");
  return rows.length;
}

export async function latestSessionTurn(sessionId: string) {
  const [turn] = await db
    .select()
    .from(sessionChatTurns)
    .where(and(eq(sessionChatTurns.sessionId, sessionId), ne(sessionChatTurns.state, "queued")))
    .orderBy(desc(sql`${sessionChatTurns.state} = 'running'`), desc(sessionChatTurns.startedAt))
    .limit(1);
  return turn ?? null;
}

// ── Live frames: this instance's sockets, every instance's turns ────────────

type Listener = (frame: Record<string, unknown>) => void;
/** sessionId → the sockets on this instance showing the session. */
const listeners = new Map<string, Set<Listener>>();
/** sessionId → the turn this instance is running for it, and how to stop it. */
const interrupts = new Map<string, { turnId: string; fire: () => void }>();

export function subscribeSessionChat(id: string, listener: Listener) {
  const set = listeners.get(id) ?? new Set();
  set.add(listener);
  listeners.set(id, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(id);
  };
}

/** Hands a frame to this instance's sockets for the session. */
function deliverSessionChat(id: string, frame: Record<string, unknown>) {
  for (const listener of listeners.get(id) ?? []) listener(frame);
}

/**
 * A frame for every viewer of the session, wherever they are connected:
 * this instance's sockets now, every other instance's through the bus.
 */
export function broadcastSessionChat(id: string, frame: Record<string, unknown>) {
  deliverSessionChat(id, frame);
  void publishSessionBus({ kind: "chat", sessionId: id, frame, origin: INSTANCE_ID });
}

/** How many sockets this instance holds for the session (diagnostics / tests). */
export function sessionChatListenerCount(id: string): number {
  return listeners.get(id)?.size ?? 0;
}

onSessionBus("chat", (m) => deliverSessionChat(m.sessionId, m.frame));
onSessionBus("control", (m) => {
  if (m.scope !== "pod" || m.action !== "interrupt" || !m.turnId) return;
  // Only the turn that was flagged: a later turn of the same session is not
  // stopped by an interrupt meant for the one before it.
  const running = interrupts.get(m.sessionId);
  if (running?.turnId === m.turnId) running.fire();
});

// ── Interrupt: durable flag + bus nudge + this instance's exec ──────────────

/**
 * Records that the session's running turn (or `turnId` only) should stop:
 * `finished_at` set on a turn that is still `running` (no other write
 * produces that state). The instance running the turn honors it on its next
 * poll even if the bus message never arrived; `finishSessionTurn` overwrites
 * the time when the turn ends. Resolves the ids of the turns it flagged.
 */
export async function requestTurnInterrupt(sessionId: string, turnId?: string): Promise<string[]> {
  const rows = await db
    .update(sessionChatTurns)
    .set({ finishedAt: new Date() })
    .where(
      and(
        eq(sessionChatTurns.sessionId, sessionId),
        turnId ? eq(sessionChatTurns.id, turnId) : undefined,
        eq(sessionChatTurns.state, "running"),
        isNull(sessionChatTurns.finishedAt),
      ),
    )
    .returning({ id: sessionChatTurns.id });
  return rows.map((r) => r.id);
}

/**
 * Stops the session's running turn wherever it runs: the durable flag on
 * the turn's row, then this instance's exec at once when the flagged turn is
 * running here, or a nudge on the bus naming the turn so the instance that
 * runs it acts now rather than at its next poll. Nothing is published when
 * no turn was flagged. If the flag cannot be written, this instance's own
 * exec is still stopped.
 */
export async function interruptSessionChat(id: string, turnId?: string): Promise<void> {
  const local = interrupts.get(id);
  let flagged: string[];
  try {
    flagged = await requestTurnInterrupt(id, turnId);
  } catch (err) {
    logger.warn({ err, sessionId: id }, "could not record the turn interrupt");
    if (local && (!turnId || local.turnId === turnId)) local.fire();
    return;
  }
  for (const flaggedId of flagged) {
    if (local?.turnId === flaggedId) {
      local.fire();
      continue;
    }
    await publishSessionBus({
      kind: "control",
      scope: "pod",
      sessionId: id,
      turnId: flaggedId,
      action: "interrupt",
      origin: INSTANCE_ID,
    });
  }
}

/** How often a running turn checks the durable flag and its session's state. */
const TURN_CONTROL_POLL_MS = parseIntEnv("OPTIO_TURN_CONTROL_POLL_MS", 2_000);

/**
 * Whether the turn has been asked to stop: the interrupt flag on its row,
 * the row settled by someone else (boot recovery), or its session no longer
 * active (ended from any instance).
 */
export async function turnShouldStop(turnId: string): Promise<boolean> {
  const [row] = await db
    .select({
      finishedAt: sessionChatTurns.finishedAt,
      state: sessionChatTurns.state,
      sessionState: interactiveSessions.state,
    })
    .from(sessionChatTurns)
    .innerJoin(interactiveSessions, eq(interactiveSessions.id, sessionChatTurns.sessionId))
    .where(eq(sessionChatTurns.id, turnId));
  if (!row) return true;
  if (row.state !== "running") return true;
  if (row.finishedAt) return true;
  return row.sessionState !== "active";
}

/**
 * While this instance runs a turn: registers how to stop it (for the bus
 * and for sockets on this instance) and polls the durable flag, so an
 * interrupt or an end-session from any instance stops the exec even when
 * the bus message was lost. Returns the function that ends the watch.
 */
export function watchTurnControl(
  sessionId: string,
  turnId: string,
  interrupt: () => void,
): () => void {
  let stopped = false;
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    interrupt();
  };
  const entry = { turnId, fire };
  interrupts.set(sessionId, entry);
  const timer = setInterval(() => {
    if (stopped || fired) return;
    turnShouldStop(turnId)
      .then((stop) => {
        if (stop && !stopped) fire();
      })
      .catch((err) => logger.debug({ err, turnId }, "turn control poll failed"));
  }, TURN_CONTROL_POLL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (interrupts.get(sessionId) === entry) interrupts.delete(sessionId);
  };
}

/** Pending messages are durable receipts too; never automatically replay a started turn. */
export async function queuedSessionMessages(sessionId: string) {
  return db
    .select({ requestId: sessionChatTurns.requestId, content: sessionChatTurns.prompt })
    .from(sessionChatTurns)
    .where(and(eq(sessionChatTurns.sessionId, sessionId), eq(sessionChatTurns.state, "queued")))
    .orderBy(asc(sessionChatTurns.startedAt), asc(sessionChatTurns.id));
}

export async function publishSessionQueue(sessionId: string) {
  broadcastSessionChat(sessionId, {
    type: "queue",
    messages: await queuedSessionMessages(sessionId),
  });
}

export async function enqueueSessionMessage(sessionId: string, requestId: string, prompt: string) {
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  await db.transaction(async (tx) => {
    // Serialize enqueue, dequeue and cancellation across API replicas.
    const [session] = await tx
      .select()
      .from(interactiveSessions)
      .where(eq(interactiveSessions.id, sessionId))
      .for("update");
    if (!session || session.state !== "active" || !session.agentRuntime)
      throw new Error("Session is not active");
    const [existing] = await tx
      .select()
      .from(sessionChatTurns)
      .where(
        and(eq(sessionChatTurns.sessionId, sessionId), eq(sessionChatTurns.requestId, requestId)),
      );
    if (existing) {
      if (existing.promptHash !== promptHash)
        throw new Error("Request ID already belongs to a different prompt");
      // Repeated frames are acknowledgements, never another execution.
      return;
    }
    const waiting = await tx
      .select({ id: sessionChatTurns.id })
      .from(sessionChatTurns)
      .where(and(eq(sessionChatTurns.sessionId, sessionId), eq(sessionChatTurns.state, "queued")));
    if (waiting.length >= 20)
      throw new Error("The message queue is full (20 messages). Wait or remove a queued message.");
    await tx
      .insert(sessionChatTurns)
      .values({ sessionId, requestId, prompt, promptHash, state: "queued" });
  });
  await publishSessionQueue(sessionId);
}

export async function cancelQueuedSessionMessage(sessionId: string, requestId: string) {
  const cancelled = await db.transaction(async (tx) => {
    await tx
      .select({ id: interactiveSessions.id })
      .from(interactiveSessions)
      .where(eq(interactiveSessions.id, sessionId))
      .for("update");
    return tx
      .update(sessionChatTurns)
      .set({ state: "interrupted", prompt: null, finishedAt: new Date() })
      .where(
        and(
          eq(sessionChatTurns.sessionId, sessionId),
          eq(sessionChatTurns.requestId, requestId),
          eq(sessionChatTurns.state, "queued"),
        ),
      )
      .returning({ id: sessionChatTurns.id });
  });
  await publishSessionQueue(sessionId);
  return cancelled.length > 0;
}

export async function claimQueuedSessionTurn(sessionId: string) {
  let leasedId: string | undefined;
  try {
    const turn = await db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(interactiveSessions)
        .where(eq(interactiveSessions.id, sessionId))
        .for("update");
      if (!session || session.state !== "active" || !session.agentRuntime) return null;
      const [running] = await tx
        .select({ id: sessionChatTurns.id })
        .from(sessionChatTurns)
        .where(
          and(eq(sessionChatTurns.sessionId, sessionId), eq(sessionChatTurns.state, "running")),
        );
      if (running) return null;
      const [next] = await tx
        .select()
        .from(sessionChatTurns)
        .where(and(eq(sessionChatTurns.sessionId, sessionId), eq(sessionChatTurns.state, "queued")))
        .orderBy(asc(sessionChatTurns.startedAt), asc(sessionChatTurns.id))
        .limit(1);
      if (!next) return null;
      if (!(await acquireLease(turnLeaseKey(next.id), TURN_LEASE_TTL_MS))) return null;
      leasedId = next.id;
      const [claimed] = await tx
        .update(sessionChatTurns)
        .set({ state: "running", startedAt: new Date() })
        .where(eq(sessionChatTurns.id, next.id))
        .returning();
      return claimed;
    });
    if (turn) holdTurnLease(turn.id);
    return turn;
  } catch (err) {
    if (leasedId) await releaseLease(turnLeaseKey(leasedId)).catch(() => {});
    throw err;
  }
}
