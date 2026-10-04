/**
 * How the apply decides a row already matches its manifest: each desired
 * column, normalized, against the row's. Null and undefined are the same
 * absence; numbers and numeric strings (`budgetUsd`) compare as numbers;
 * jsonb compares with keys sorted; dates as ISO strings.
 */
import { stableStringify } from "@optio/shared";

export function norm(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    return /^-?\d+(\.\d+)?$/.test(value.trim()) ? String(Number(value)) : value;
  }
  if (typeof value === "object") return stableStringify(value);
  return String(value);
}

/** The keys of `desired` whose value differs from the row's. */
export function fieldChanges(
  row: Record<string, unknown>,
  desired: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  for (const [key, want] of Object.entries(desired)) {
    if (want === undefined) continue;
    if (norm(row[key]) !== norm(want)) changed.push(key);
  }
  return changed;
}

/** Two lists as sets (order ignored); null, undefined and [] are the same. */
export function sameSet(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  const sa = [...new Set(a ?? [])].sort();
  const sb = [...new Set(b ?? [])].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

/** An object without its undefined, null and empty-object entries (what an export writes). */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      Object.keys(value as Record<string, unknown>).length === 0
    ) {
      continue;
    }
    out[key] = value;
  }
  return out as Partial<T>;
}
