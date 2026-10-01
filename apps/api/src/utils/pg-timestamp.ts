/**
 * Timestamps from raw SQL — `db.execute(sql…)`, or a `sql` expression in a
 * select without `.mapWith(column)` — come back as Postgres text
 * ("2026-09-23 01:22:37.388801+00"): drizzle's postgres-js driver switches the
 * driver's own date parsing off and maps only real columns back to `Date`.
 * Every other date field in the API serializes as ISO-8601, and clients decode
 * strictly (the iOS app rejects the Postgres form), so convert such values
 * before they reach a response.
 */

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** A raw timestamp as a `Date` (serializes as ISO-8601); null stays null. */
export function pgDate(value: string | Date): Date;
export function pgDate(value: string | Date | null | undefined): Date | null;
export function pgDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  return value instanceof Date ? value : new Date(value);
}

/** A raw timestamp as an ISO-8601 string; null (or unparseable) → null. */
export function pgIso(value: string | Date | null | undefined): string | null {
  const date = pgDate(value);
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/**
 * Millisecond-precision `updated_at` comparison — the ONE way every CAS guard
 * on a row's version must compare. Postgres `timestamptz` columns store
 * microseconds, but JavaScript's Date type only carries milliseconds — so a
 * JS-side `eq(updated_at, version)` against a row whose updated_at was set by
 * PG's `now()`/`defaultNow()` (microsecond precision) will silently never
 * match, leaving the row permanently "stale" to the reconciler. Both sides are
 * truncated to milliseconds so the round-trip is symmetric. JS-originated
 * writes are already ms-precision so this is exactly the comparison we want
 * everywhere.
 */
export function updatedAtMatches(column: SQLWrapper, version: Date): SQL {
  return sql`date_trunc('milliseconds', ${column})
      = date_trunc('milliseconds', ${version.toISOString()}::timestamptz)`;
}
