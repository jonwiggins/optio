/**
 * Cost accounting helpers.
 *
 * `tasks.cost_usd` (and the equivalent columns on workflow_runs / pr_review_runs
 * / persistent_agents) is stored as a **string** — see the schema comment
 * "stored as string to avoid float precision issues". Analytics reads it back
 * with `CAST(cost_usd AS NUMERIC)` and sums across rows, so the string must be a
 * plain decimal literal (no scientific notation, no thousands separators).
 */

/** Count the digits after the decimal point in a numeric string. */
function decimalPlaces(s: string): number {
  const m = /\.(\d+)/.exec(s);
  return m ? m[1].length : 0;
}

/**
 * Decimal-safe addition of two cost values, returning a plain decimal string.
 *
 * Naive float addition drifts (`0.1 + 0.2 === 0.30000000000000004`), which would
 * accumulate error every time a resumed run's cost is added to the prior total.
 * To avoid that, both operands are scaled to integers at the finer of the two
 * inputs' decimal precision (capped so the scale can't overflow), added exactly
 * as integers, then rescaled.
 *
 * Nullish, empty, or non-numeric operands are treated as `0`, so this is safe to
 * call with a task's current `costUsd` (which may be `null` on the first run).
 */
export function addCostStrings(a?: string | number | null, b?: string | number | null): string {
  const sa = a == null ? "" : String(a);
  const sb = b == null ? "" : String(b);
  const na = Number(sa || 0);
  const nb = Number(sb || 0);
  const va = Number.isFinite(na) ? na : 0;
  const vb = Number.isFinite(nb) ? nb : 0;

  // Cap precision at 12 decimals: more than enough for per-run USD costs and
  // keeps 10 ** decimals well within safe-integer range.
  const decimals = Math.min(12, Math.max(decimalPlaces(sa), decimalPlaces(sb)));
  const scale = 10 ** decimals;
  const sum = (Math.round(va * scale) + Math.round(vb * scale)) / scale;

  // Format with toFixed (never scientific notation, unlike String() for values
  // below 1e-6) at the operands' precision, then trim trailing zeros so the
  // result is a clean plain-decimal literal for CAST(... AS NUMERIC).
  let out = sum.toFixed(decimals);
  if (out.includes(".")) {
    out = out.replace(/0+$/, "").replace(/\.$/, "");
  }
  return out;
}

/**
 * Add two token counts, treating nullish operands as 0. Tokens are integers, so
 * plain addition is exact — this just centralizes the null handling.
 */
export function addTokenCounts(a?: number | null, b?: number | null): number {
  return (a ?? 0) + (b ?? 0);
}
