/**
 * What a new gateway key carries over from the keys before it
 * (docs/model-gateway.md "A person's key"). Pure (no database, no gateway):
 * services/gateway-keys.ts uses it when it makes a key, and
 * gateway-key-check.ts when it checks one. Written in LiteLLM's terms; on
 * OpenRouter the same amounts are carried as a lower limit instead of a
 * spend (the driver's `carry: "limit"`), and the spend read for a key adds
 * them back (`keySpendOf`), so the arithmetic here is the same.
 *
 * LiteLLM counts a budget per key, and a key's budget period starts when the
 * key is made. So a new key (after Rotate, or after Give up and then Get my
 * token) starts with what the person's earlier keys spent in periods that
 * are still running (`spend` on `/key/generate`). Each amount keeps the time
 * its own key's period ends (`until`). Once that time is up, the
 * housekeeping check takes the amount off the key's spend in LiteLLM. Spend
 * then counts for the period it was spent in and no longer, however often
 * someone rotates. Carrying one total to the next key's reset would let it
 * build up across rotations until LiteLLM refused the person for good.
 */

/** An amount a key carries from an earlier key, and when that key's period ends (null = never). */
export interface CarriedSpend {
  usd: number;
  until: string | null;
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  mo: 2592000,
};

/** The approximate end of a LiteLLM duration from `from` (for when LiteLLM doesn't say). */
export function durationEnd(duration: string | null, from = new Date()): Date | null {
  const m = duration?.match(/^(\d+)(s|m|h|d|w|mo)$/);
  if (!m) return null;
  const unit = UNIT_SECONDS[m[2]] ?? 0;
  return new Date(from.getTime() + Number(m[1]) * unit * 1000);
}

/** When the budget period running at `at` ends, for a key made at `createdAt` (null = no period). */
export function periodEndAt(createdAt: Date, duration: string | null, at: Date): Date | null {
  const first = durationEnd(duration, createdAt);
  if (!first) return null;
  const step = first.getTime() - createdAt.getTime();
  if (step <= 0) return null;
  if (first.getTime() > at.getTime()) return first;
  const periods = Math.floor((at.getTime() - createdAt.getTime()) / step) + 1;
  return new Date(createdAt.getTime() + periods * step);
}

/** Whether a key's budget period is still running at `now` (a budget that never resets always is). */
export function budgetPeriodOpen(
  key: { budgetResetAt: Date | string | null; budgetDuration: string | null; createdAt: Date },
  now = new Date(),
): boolean {
  if (key.budgetResetAt) return new Date(key.budgetResetAt).getTime() > now.getTime();
  if (!key.budgetDuration) return true;
  const end = durationEnd(key.budgetDuration, key.createdAt);
  return !end || end.getTime() > now.getTime();
}

/** USD as LiteLLM keeps it, without float dust. */
function usd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

const time = (v: string | null) => (v === null ? Infinity : new Date(v).getTime());

/** The sum of carried amounts. */
export function carriedTotal(carried: readonly CarriedSpend[] | null | undefined): number {
  return usd((carried ?? []).reduce((s, p) => s + (Number.isFinite(p.usd) ? p.usd : 0), 0));
}

/** A stored `carried_spend` value, cleaned (garbage = nothing carried). */
export function carriedOf(raw: unknown): CarriedSpend[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => {
    const r = (p ?? {}) as Record<string, unknown>;
    const amount = Number(r.usd);
    const until =
      typeof r.until === "string" && !Number.isNaN(Date.parse(r.until)) ? r.until : null;
    if (!Number.isFinite(amount) || amount <= 0) return [];
    if (r.until !== null && until === null) return [];
    return [{ usd: usd(amount), until }];
  });
}

export interface CarryKey {
  createdAt: Date;
  budgetDuration: string | null;
  carriedSpend: unknown;
}

/**
 * Whether LiteLLM's spend for `key`, read at `at`, still has the amounts the
 * key carried in it. They all end before the key's own first reset (they
 * come from keys made before it), and LiteLLM zeroes the key's spend then.
 */
function carryCounted(key: CarryKey, at: Date): boolean {
  const firstReset = durationEnd(key.budgetDuration, key.createdAt);
  return !firstReset || firstReset.getTime() > at.getTime();
}

/**
 * The carried amounts a key's spend holds at `at`, as LiteLLM keeps them:
 * every amount still on the key (the check removes one once it takes it
 * off), and none once the key's own period has started over. A gateway that
 * carries by a lower limit (OpenRouter) adds this to the usage it reports,
 * so `carryAfter` reads its spend as it reads LiteLLM's.
 */
export function carriedInSpend(key: CarryKey, at: Date): number {
  return carryCounted(key, at) ? carriedTotal(carriedOf(key.carriedSpend)) : 0;
}

/**
 * What the key after `key` carries at `now`. That is the amounts `key`
 * carried that are still running, plus what `key` spent itself (LiteLLM's
 * spend less what it carried) while its own period runs. `reading` is
 * LiteLLM's spend for `key`, read at `readAt` (live, or saved when the key
 * was given up), with the end of its period then (`resetAt`).
 */
export function carryAfter(
  key: CarryKey,
  reading: { spend: number; resetAt: Date | string | null; readAt: Date },
  now = new Date(),
): CarriedSpend[] {
  const earlier = carryCounted(key, reading.readAt) ? carriedOf(key.carriedSpend) : [];
  const out = earlier.filter((p) => time(p.until) > now.getTime());
  const own = usd(Math.max(0, reading.spend - carriedTotal(earlier)));
  if (own > 0) {
    const ends = reading.resetAt
      ? new Date(reading.resetAt)
      : periodEndAt(key.createdAt, key.budgetDuration, reading.readAt);
    if (!ends) {
      // A budget that never resets: what was spent counts for good.
      if (!key.budgetDuration) out.push({ usd: own, until: null });
    } else if (ends.getTime() > now.getTime()) {
      out.push({ usd: own, until: ends.toISOString() });
    }
  }
  return out;
}

/**
 * What the housekeeping check does with a key's carried amounts at `now`:
 * how much to take off LiteLLM's spend for it, and what stays carried. Null
 * when nothing is due. Once LiteLLM has started the key's own period over,
 * its spend no longer includes any of them, so they are dropped and nothing
 * is taken off.
 */
export function carryDue(
  key: CarryKey,
  now = new Date(),
): { takeOff: number; keep: CarriedSpend[] } | null {
  const carried = carriedOf(key.carriedSpend);
  if (!carried.length) return null;
  if (!carryCounted(key, now)) return { takeOff: 0, keep: [] };
  const due = carried.filter((p) => time(p.until) <= now.getTime());
  if (!due.length) return null;
  return { takeOff: carriedTotal(due), keep: carried.filter((p) => !due.includes(p)) };
}
