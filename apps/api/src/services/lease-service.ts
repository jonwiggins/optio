/**
 * Leases (docs/plans/scale-out.md §3): the one way an API instance claims
 * something for a while when several instances share the database — a
 * poller's turn, a per-user chat lock, a Local host's owner.
 *
 * A lease is a row in `leases` (`key`, `holder`, `expires_at`). Acquiring is
 * one statement, an insert that becomes an update only when the row has
 * expired or already belongs to the same holder, so two instances can race
 * for a key and exactly one gets it. Renewing and releasing are updates
 * guarded by the holder. Nothing here waits: a caller that loses a lease
 * does something else, or tries again later.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { INSTANCE_ID } from "./instance.js";

const MAX_KEY = 200;

function assertKey(key: string): string {
  if (!key || key.length > MAX_KEY) throw new Error(`Invalid lease key: ${JSON.stringify(key)}`);
  return key;
}

/**
 * Takes the lease for `holder` (this instance by default) for `ttlMs` when
 * nobody holds it, it has expired, or `holder` already holds it (which
 * extends it). True iff the lease is now held by `holder`.
 */
export async function acquireLease(
  key: string,
  ttlMs: number,
  holder: string = INSTANCE_ID,
): Promise<boolean> {
  const rows = await db.execute<{ key: string }>(sql`
    INSERT INTO "leases" ("key", "holder", "expires_at")
    VALUES (${assertKey(key)}, ${holder}, now() + make_interval(secs => ${ttlMs / 1000}))
    ON CONFLICT ("key") DO UPDATE
      SET "holder" = EXCLUDED."holder", "expires_at" = EXCLUDED."expires_at"
      WHERE "leases"."expires_at" < now() OR "leases"."holder" = EXCLUDED."holder"
    RETURNING "key"`);
  return rows.length > 0;
}

/** Extends a lease `holder` holds. False when it was lost (expired and taken, or released). */
export async function renewLease(
  key: string,
  ttlMs: number,
  holder: string = INSTANCE_ID,
): Promise<boolean> {
  const rows = await db.execute<{ key: string }>(sql`
    UPDATE "leases"
    SET "expires_at" = now() + make_interval(secs => ${ttlMs / 1000})
    WHERE "key" = ${assertKey(key)} AND "holder" = ${holder} AND "expires_at" >= now()
    RETURNING "key"`);
  return rows.length > 0;
}

/** Gives a lease up right away, if `holder` holds it. */
export async function releaseLease(key: string, holder: string = INSTANCE_ID): Promise<void> {
  await db.execute(sql`
    UPDATE "leases" SET "expires_at" = now()
    WHERE "key" = ${assertKey(key)} AND "holder" = ${holder}`);
}

/** Who holds a lease right now, or null when nobody does. */
export async function leaseHolder(key: string): Promise<string | null> {
  const rows = await db.execute<{ holder: string }>(sql`
    SELECT "holder" FROM "leases" WHERE "key" = ${assertKey(key)} AND "expires_at" > now()`);
  return rows[0]?.holder ?? null;
}

/**
 * Takes a lease by force — for "newest daemon wins" (the Local relay): the
 * previous holder finds out at its next renew.
 */
export async function seizeLease(
  key: string,
  ttlMs: number,
  holder: string = INSTANCE_ID,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO "leases" ("key", "holder", "expires_at")
    VALUES (${assertKey(key)}, ${holder}, now() + make_interval(secs => ${ttlMs / 1000}))
    ON CONFLICT ("key") DO UPDATE
      SET "holder" = EXCLUDED."holder", "expires_at" = EXCLUDED."expires_at"`);
}

/** Drops leases that expired more than a day ago (housekeeping). */
export async function sweepLeases(): Promise<number> {
  const rows = await db.execute<{ key: string }>(sql`
    DELETE FROM "leases" WHERE "expires_at" < now() - interval '1 day' RETURNING "key"`);
  return rows.length;
}

export class LeaseLostError extends Error {
  constructor(public readonly key: string) {
    super(`lease ${key} was lost`);
    this.name = "LeaseLostError";
  }
}

export interface WithLeaseOptions {
  /** How long each acquire / renew holds the lease (default 60 s). */
  ttlMs?: number;
  /** How often to renew while `fn` runs (default a third of the TTL). */
  renewEveryMs?: number;
  holder?: string;
}

/**
 * Runs `fn` while holding the lease, renewing it on an interval. Resolves
 * `null` without running `fn` when the lease is held elsewhere. If a renew
 * fails while `fn` runs, `fn`'s `signal` aborts and, once `fn` settles, the
 * call rejects with `LeaseLostError`; `fn` should stop what it is doing when
 * the signal fires. The lease is released when `fn` finishes.
 */
export async function withLease<T>(
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: WithLeaseOptions = {},
): Promise<T | null> {
  const ttlMs = opts.ttlMs ?? 60_000;
  const renewEveryMs = opts.renewEveryMs ?? Math.max(250, Math.floor(ttlMs / 3));
  const holder = opts.holder ?? INSTANCE_ID;
  if (!(await acquireLease(key, ttlMs, holder))) return null;

  const controller = new AbortController();
  let lost = false;
  let renewing: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    renewing = renewing.then(async () => {
      if (lost) return;
      let ok = false;
      try {
        ok = await renewLease(key, ttlMs, holder);
      } catch {
        // A failed renew (the database away for a moment) is not a lost
        // lease: the next tick tries again, and the TTL covers the gap.
        return;
      }
      if (!ok) {
        lost = true;
        controller.abort(new LeaseLostError(key));
      }
    });
  }, renewEveryMs);
  timer.unref?.();

  try {
    const result = await fn(controller.signal);
    if (lost) throw new LeaseLostError(key);
    return result;
  } catch (err) {
    if (lost && !(err instanceof LeaseLostError)) throw new LeaseLostError(key);
    throw err;
  } finally {
    clearInterval(timer);
    await renewing.catch(() => {});
    if (!lost) await releaseLease(key, holder).catch(() => {});
  }
}
