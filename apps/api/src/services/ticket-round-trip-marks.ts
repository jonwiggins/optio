/**
 * Two moments the ticket round trip keeps on a provider's `config.roundTrip`,
 * next to its settings but never sent by the form (routes/ticket-round-trip.ts
 * merges the settings around them; docs/ticket-round-trip.md):
 *
 *   since           when the round trip first ran for the provider: its
 *                   creation for a provider that hadn't synced yet, else the
 *                   first ticket sync after the round trip was turned on. Until
 *                   then the provider's tickets are backlog — a ticket the
 *                   sync skips is not told why (ticket-writeback.ts
 *                   noteTicketSkipped) — and no comment written before it is
 *                   a follow-up, so an upgrade doesn't replay months of
 *                   conversation into waiting work.
 *   followUpsSince  when its follow-ups last widened (Off → Mentions only →
 *                   Any comment): comments written before then weren't
 *                   meant for Optio.
 *
 * A follow-up must be newer than both, and than its work (ticket-follow-ups.ts).
 */
import { and, eq, sql } from "drizzle-orm";
import type { TicketFollowUpMode } from "@optio/shared";
import { db } from "../db/client.js";
import { ticketProviders } from "../db/schema.js";

type ProviderRow = typeof ticketProviders.$inferSelect;

export interface RoundTripMarks {
  since: Date | null;
  followUpsSince: Date | null;
}

function dateOf(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The marks a provider's stored config holds (null where none is set). Never throws. */
export function roundTripMarks(config: unknown): RoundTripMarks {
  const raw =
    config && typeof config === "object"
      ? (config as Record<string, unknown>).roundTrip
      : undefined;
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { since: dateOf(r.since), followUpsSince: dateOf(r.followUpsSince) };
}

/** The moment before which no comment is a follow-up, or null for none. */
export function followUpFloor(marks: RoundTripMarks): Date | null {
  const times = [marks.since, marks.followUpsSince].filter((d): d is Date => !!d);
  return times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
}

const FOLLOW_UP_RANK: Record<TicketFollowUpMode, number> = { off: 0, mention: 1, any: 2 };

/** Whether a change of the follow-up mode lets more comments in than before. */
export function followUpsWidened(before: TicketFollowUpMode, after: TicketFollowUpMode): boolean {
  return FOLLOW_UP_RANK[after] > FOLLOW_UP_RANK[before];
}

/**
 * `config.roundTrip` with `patch` merged in, in one statement, so the
 * settings saved from the form and the marks the sync sets never overwrite
 * each other (and the rest of the config stays as it is).
 */
export function mergeRoundTripSql(patch: Record<string, unknown>) {
  const c = ticketProviders.config;
  return sql`jsonb_set(${c}, '{roundTrip}', (CASE WHEN jsonb_typeof(${c}->'roundTrip') = 'object' THEN ${c}->'roundTrip' ELSE '{}'::jsonb END) || ${JSON.stringify(patch)}::jsonb)`;
}

/**
 * Sets `since` on a provider that has none — its creation when it hasn't
 * finished a sync yet (a provider made since the round trip), else now (one
 * that synced before it) — and returns the provider as stored. The ticket
 * sync calls this once per sweep (ticket-follow-ups.ts ticketRoundTripSweep),
 * after the sweep's tickets.
 */
export async function ensureRoundTripSince(provider: ProviderRow): Promise<ProviderRow> {
  if (roundTripMarks(provider.config).since) return provider;
  const since = provider.initialSyncAt == null ? provider.createdAt : new Date();
  const [row] = await db
    .update(ticketProviders)
    .set({ config: mergeRoundTripSql({ since: since.toISOString() }) })
    .where(
      and(
        eq(ticketProviders.id, provider.id),
        sql`${ticketProviders.config}->'roundTrip'->>'since' IS NULL`,
      ),
    )
    .returning();
  if (row) return row;
  // Another runner set it first.
  const [fresh] = await db
    .select()
    .from(ticketProviders)
    .where(eq(ticketProviders.id, provider.id));
  return fresh ?? provider;
}
