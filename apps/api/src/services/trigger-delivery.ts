/** Durable ingress and dispatch. Postgres owns pending work; queue ticks only wake it.
 * A delivery's UUID is also its target run/message id. A crash after creating the
 * target and before recording success therefore resumes the same target.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { triggerEvents, triggerOccurrences, workflowTriggers } from "../db/schema.js";
import type { Db } from "./work-definition-service.js";
import type { TriggerRow } from "./trigger-service.js";
import type { TriggerFiring, TriggerFireResult } from "./trigger-dispatch.js";
import type { EventTriggerType } from "@optio/shared";
import { logger } from "../logger.js";

const MAX_ATTEMPTS = 8;
export const deliveryKey = (body: unknown) =>
  createHash("sha256").update(JSON.stringify(body)).digest("hex");

/** Returns only after the event is durable. Database failures must reach the sender. */
export async function acceptTriggerEvent(
  source: EventTriggerType,
  key: string | null | undefined,
  payload: unknown,
) {
  const [row] = await db
    .insert(triggerEvents)
    .values({
      source,
      deliveryKey: key || deliveryKey(payload),
      payload: payload as Record<string, unknown>,
    })
    .onConflictDoNothing()
    .returning({ id: triggerEvents.id });
  return row ? {} : { duplicate: true };
}

export async function deliveryTargetScope(id: string, tx: Db & Pick<Database, "execute"> = db) {
  const [scope] = await tx.execute<{
    workspace_id: string | null;
    owner_user_id: string | null;
    owner_team_id: string | null;
    name: string;
  }>(sql`
    SELECT workspace_id,owner_user_id,owner_team_id,name FROM work_definitions WHERE id=${id}::uuid
    UNION ALL SELECT workspace_id,owner_user_id,owner_team_id,name FROM persistent_agents WHERE id=${id}::uuid
    UNION ALL SELECT workspace_id,NULL::uuid,NULL::uuid,'Review ' || repo_owner || '/' || repo_name || '#' || pr_number FROM pr_reviews WHERE id=${id}::uuid LIMIT 1`);
  return scope;
}

export async function enqueueOccurrence(
  trigger: Pick<TriggerRow, "id" | "targetType" | "targetId">,
  firing: TriggerFiring,
  key: string = randomUUID(),
  tx: Db & Pick<Database, "execute"> = db,
) {
  // Snapshot attribution independently of later edits/deletion. No payload is
  // returned by the history API; private target history stays private.
  const scope = await deliveryTargetScope(trigger.targetId, tx);
  const [row] = await tx
    .insert(triggerOccurrences)
    .values({
      occurrenceKey: key,
      triggerId: trigger.id,
      targetType: trigger.targetType,
      targetId: trigger.targetId,
      targetName: scope?.name ?? "Work",
      workspaceId: scope?.workspace_id,
      ownerUserId: scope?.owner_user_id,
      ownerTeamId: scope?.owner_team_id,
      source: firing.source,
      firing: { ...firing },
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [existing] = await tx
    .select()
    .from(triggerOccurrences)
    .where(eq(triggerOccurrences.occurrenceKey, key));
  return existing;
}

function retry(attempts: number) {
  return {
    attempts,
    state: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
    nextAttemptAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** attempts)),
  };
}

/** Row locks last until dispatch settles; SKIP LOCKED lets other instances work.
 * Target creation uses the fixed occurrence id and is recoverable if this tx dies.
 */
let dispatchTail: Promise<unknown> = Promise.resolve();
function serializeDispatch<T>(run: () => Promise<T>): Promise<T> {
  const next = dispatchTail.then(run, run);
  dispatchTail = next.catch(() => {});
  return next;
}
export function deliverOccurrence(id?: string): Promise<TriggerFireResult | null> {
  return serializeDispatch(() => dispatchOccurrence(id));
}
async function dispatchOccurrence(id?: string): Promise<TriggerFireResult | null> {
  let failure: unknown;
  const result = await db.transaction(async (tx) => {
    const [picked] = await tx.execute<{ id: string }>(sql`
      SELECT id FROM trigger_occurrences WHERE ${id ? sql`id = ${id}::uuid` : sql`state = 'pending' AND next_attempt_at <= now()`}
      ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    if (!picked) return null;
    const [row] = await tx
      .select()
      .from(triggerOccurrences)
      .where(eq(triggerOccurrences.id, picked.id));
    if (row.state === "started") return row.result as TriggerFireResult;
    if (
      row.state === "skipped" ||
      row.state === "failed" ||
      row.nextAttemptAt.getTime() > Date.now()
    )
      return null;
    try {
      const [trigger] = await db
        .select()
        .from(workflowTriggers)
        .where(and(eq(workflowTriggers.id, row.triggerId), eq(workflowTriggers.enabled, true)));
      const { fireTrigger } = await import("./trigger-dispatch.js");
      const scope = await deliveryTargetScope(row.targetId);
      const sameBoundary =
        scope &&
        scope.workspace_id === row.workspaceId &&
        scope.owner_user_id === row.ownerUserId &&
        (scope.owner_team_id ?? null) === (row.ownerTeamId ?? null);
      const fired =
        trigger &&
        trigger.targetId === row.targetId &&
        trigger.targetType === row.targetType &&
        sameBoundary
          ? await fireTrigger(
              {
                id: row.triggerId,
                targetType: row.targetType as TriggerRow["targetType"],
                targetId: row.targetId,
              },
              row.firing as unknown as TriggerFiring,
              row.id,
            )
          : null;
      await tx
        .update(triggerOccurrences)
        .set({
          state: fired ? "started" : "skipped",
          result: fired,
          error: null,
          finishedAt: new Date(),
          attempts: row.attempts + 1,
        })
        .where(eq(triggerOccurrences.id, row.id));
      return fired;
    } catch (err) {
      failure = err;
      // Errors can contain provider responses; retain only a bounded diagnostic.
      logger.warn({ err, occurrenceId: row.id }, "Trigger delivery will retry");
      await tx
        .update(triggerOccurrences)
        .set({
          ...retry(row.attempts + 1),
          error: "Could not start work. Check the target's configuration and service availability.",
        })
        .where(eq(triggerOccurrences.id, row.id));
      return null;
    }
  });
  if (id && failure) throw failure;
  return result;
}

async function dispatchEvent(): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [picked] = await tx.execute<{ id: string }>(
      sql`SELECT id FROM trigger_events WHERE state = 'pending' AND next_attempt_at <= now() ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    if (!picked) return false;
    const [row] = await tx.select().from(triggerEvents).where(eq(triggerEvents.id, picked.id));
    try {
      const { fireEventTriggers } = await import("./event-trigger-service.js");
      await fireEventTriggers(row.source as EventTriggerType, row.payload as never, row.id);
      await tx
        .update(triggerEvents)
        .set({
          state: "dispatched",
          finishedAt: new Date(),
          error: null,
          attempts: row.attempts + 1,
        })
        .where(eq(triggerEvents.id, row.id));
    } catch (err) {
      logger.warn({ err, eventId: row.id }, "Event matching will retry");
      await tx
        .update(triggerEvents)
        .set({ ...retry(row.attempts + 1), state: "pending", error: "Event matching failed" })
        .where(eq(triggerEvents.id, row.id));
    }
    return true;
  });
}

export async function drainTriggerDeliveries(): Promise<void> {
  for (let i = 0; i < 30 && (await serializeDispatch(dispatchEvent)); i++) {
    /* bounded batch */
  }
  const due = await db
    .select({ id: triggerOccurrences.id })
    .from(triggerOccurrences)
    .where(
      sql`${triggerOccurrences.state} = 'pending' AND ${triggerOccurrences.nextAttemptAt} <= now()`,
    )
    .limit(30);
  for (const row of due) await deliverOccurrence(row.id).catch(() => {});
}

export class DeliveryPendingError extends Error {
  constructor(public readonly deliveryId: string) {
    super("Delivery saved for retry");
  }
}
export async function fireTriggerDurably(
  trigger: Pick<TriggerRow, "id" | "targetType" | "targetId">,
  firing: TriggerFiring,
  key?: string,
) {
  const row = await enqueueOccurrence(trigger, firing, key);
  let result: TriggerFireResult | null;
  try {
    result = await deliverOccurrence(row.id);
  } catch {
    throw new DeliveryPendingError(row.id);
  }
  if (!result) {
    const [current] = await db
      .select()
      .from(triggerOccurrences)
      .where(eq(triggerOccurrences.id, row.id));
    if (current?.state === "pending") throw new DeliveryPendingError(row.id);
    if (current?.state === "started") return current.result as TriggerFireResult;
  }
  return result;
}

/** Keep receipt identities for 90 days; shed completed payloads after one day.
 * Failed occurrences retain their payload so an operator can retry them.
 */
export async function pruneTriggerDeliveries() {
  await db.execute(
    sql`UPDATE trigger_events SET payload='{}'::jsonb WHERE state='dispatched' AND finished_at < now()-interval '1 day' AND payload <> '{}'::jsonb`,
  );
  await db.execute(
    sql`UPDATE trigger_occurrences SET firing='{}'::jsonb WHERE state IN ('started','skipped') AND finished_at < now()-interval '1 day' AND firing <> '{}'::jsonb`,
  );
  await db.execute(
    sql`DELETE FROM trigger_events WHERE state='dispatched' AND received_at < now()-interval '90 days'`,
  );
  await db.execute(
    sql`DELETE FROM trigger_occurrences WHERE state IN ('started','skipped') AND received_at < now()-interval '90 days'`,
  );
}
