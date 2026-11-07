/**
 * How long the audit trail is kept (docs/audit.md), and the daily prune.
 *
 * Retention is deployment-wide, in days: the app's setting (the Audit page,
 * a deployment admin) wins; unset, `OPTIO_AUDIT_RETENTION_DAYS` (Helm
 * `audit.retentionDays`); unset or invalid, 365. The housekeeping tick
 * (workers/sweep-worker.ts, every 30 s on one replica) runs
 * `pruneAuditTrail`, which deletes entries older than that in batches and,
 * once a pass finds nothing more to delete, rests for a day
 * (`audit_settings.last_pruned_at`), so the trail is pruned once a day
 * whichever replica holds the tick.
 *
 * The audit trail is the action log (`optio_actions`): the prune is its only
 * deletion, apart from upstream's. Task logs have their own rules; a long
 * audit retention keeps "who did what" after the runs it names are gone.
 */
import { eq, sql } from "drizzle-orm";
import { AUDIT_RETENTION_DEFAULT_DAYS, AUDIT_RETENTION_MAX_DAYS } from "@optio/shared";
import { db } from "../db/client.js";
import { auditSettings } from "../db/schema.js";

/** Rows one prune statement deletes (short locks; the next tick continues). */
export const PRUNE_BATCH = 5000;
const DAY_MS = 86_400_000;

export interface AuditRetention {
  /** The retention in force. */
  days: number;
  /** Where it comes from: the app's setting, the environment, or the default. */
  source: "app" | "environment" | "default";
  /** What the environment (or the default) says, i.e. what clearing the app's setting gives. */
  environmentDays: number;
  lastPrunedAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

function validDays(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= AUDIT_RETENTION_MAX_DAYS;
}

/** OPTIO_AUDIT_RETENTION_DAYS, or null when unset or not a whole number of days in range. */
export function envRetentionDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env.OPTIO_AUDIT_RETENTION_DAYS ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return validDays(n) ? n : null;
}

async function settingsRow() {
  const [row] = await db.select().from(auditSettings).where(eq(auditSettings.id, 1));
  return row ?? null;
}

export async function getAuditRetention(): Promise<AuditRetention> {
  const row = await settingsRow();
  const env = envRetentionDays();
  const environmentDays = env ?? AUDIT_RETENTION_DEFAULT_DAYS;
  const app = row?.retentionDays;
  return {
    days: validDays(app) ? app : environmentDays,
    source: validDays(app) ? "app" : env !== null ? "environment" : "default",
    environmentDays,
    lastPrunedAt: row?.lastPrunedAt ? row.lastPrunedAt.toISOString() : null,
    updatedAt: row?.retentionDays != null && row.updatedAt ? row.updatedAt.toISOString() : null,
    updatedBy: row?.retentionDays != null ? (row.updatedBy ?? null) : null,
  };
}

export class AuditSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditSettingsError";
  }
}

/** Set (or, with null, clear) the app's retention. */
export async function setAuditRetention(
  days: number | null,
  by: string | null,
): Promise<AuditRetention> {
  if (days !== null && !validDays(days)) {
    throw new AuditSettingsError(
      `Keep the audit trail between 1 and ${AUDIT_RETENTION_MAX_DAYS} days`,
    );
  }
  await db
    .insert(auditSettings)
    .values({ id: 1, retentionDays: days, updatedBy: by, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: auditSettings.id,
      // A shorter retention takes effect at the next tick, not a day later.
      set: { retentionDays: days, updatedBy: by, updatedAt: new Date(), lastPrunedAt: null },
    });
  return getAuditRetention();
}

/**
 * One prune step (a housekeeping sweep): nothing when a pass finished in
 * the last day; otherwise delete up to `PRUNE_BATCH` entries older than the
 * retention, and mark the pass done when fewer than that were left. Returns
 * how many it deleted.
 */
export async function pruneAuditTrail(now: Date = new Date()): Promise<number> {
  const row = await settingsRow();
  if (row?.lastPrunedAt && now.getTime() - row.lastPrunedAt.getTime() < DAY_MS) return 0;
  const { days } = await getAuditRetention();
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const deleted = await db.execute<{ id: string }>(sql`
    DELETE FROM "optio_actions"
    WHERE "id" IN (
      SELECT "id" FROM "optio_actions" WHERE "created_at" < ${cutoff.toISOString()}::timestamptz
      LIMIT ${PRUNE_BATCH}
    )
    RETURNING "id"`);
  if (deleted.length < PRUNE_BATCH) {
    await db
      .insert(auditSettings)
      .values({ id: 1, lastPrunedAt: now })
      .onConflictDoUpdate({ target: auditSettings.id, set: { lastPrunedAt: now } });
  }
  return deleted.length;
}
