/**
 * Adding an attempt's AI usage onto a row's cost columns, computed by
 * Postgres in the UPDATE itself: exact decimal arithmetic on the stored
 * string (`cost_usd` is text — see the schema), and atomic, so two writers
 * can't lose each other's spend the way read-add-write could.
 *
 * Every row that accumulates spend uses these: task runs (a resumed or
 * retried run adds each attempt), Job runs, PR-review runs, a persistent
 * agent's running total, and a pod session's chat.
 */
import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * The amount a run may add. Usage comes from the agent's own output, which a
 * prompt-injected agent controls: it must not subtract spend (hiding it from
 * budgets and analytics) or turn a sum into NaN / Infinity (`1e400` parses to
 * Infinity, which Postgres numeric stores — a budget that never resets).
 * Anything but a finite, non-negative decimal adds nothing.
 */
function usageAmount(amount: string | number): string {
  if (typeof amount === "string") {
    const t = amount.trim();
    return /^\d+(\.\d+)?(e[-+]?\d+)?$/i.test(t) && Number.isFinite(Number(t)) ? t : "0";
  }
  return Number.isFinite(amount) && amount > 0 ? String(amount) : "0";
}

/** `column + amount`, for a cost stored as a decimal string (null and '' count as 0). */
export function plusCost(column: AnyColumn, amount: string | number): SQL<string> {
  return sql<string>`trim_scale(COALESCE(NULLIF(${column}, ''), '0')::numeric + ${usageAmount(amount)}::numeric)::text`;
}

/** `column + amount`, for a token count (null counts as 0; see `usageAmount`). */
function plusTokens(column: AnyColumn, amount: number): SQL<number> {
  const n = Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
  return sql<number>`COALESCE(${column}, 0) + ${n}`;
}

export interface Usage {
  costUsd?: number | string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  model?: string | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costBasis?: string | null;
}

/**
 * The SET fields that add `usage` onto a row's `costUsd` / `inputTokens` /
 * `outputTokens` and record the model used. Absent fields leave their column
 * alone, so the result can be spread into any UPDATE (including a state
 * transition's).
 */
export function addUsage(
  table: {
    costUsd: AnyColumn;
    inputTokens: AnyColumn;
    outputTokens: AnyColumn;
    cacheReadTokens?: AnyColumn;
    cacheWriteTokens?: AnyColumn;
  },
  usage: Usage,
): {
  costUsd?: SQL<string>;
  inputTokens?: SQL<number>;
  outputTokens?: SQL<number>;
  modelUsed?: string;
  cacheReadTokens?: SQL<number>;
  cacheWriteTokens?: SQL<number>;
  costBasis?: string;
} {
  return {
    ...(usage.costUsd != null ? { costUsd: plusCost(table.costUsd, usage.costUsd) } : {}),
    ...(usage.inputTokens != null
      ? { inputTokens: plusTokens(table.inputTokens, usage.inputTokens) }
      : {}),
    ...(usage.outputTokens != null
      ? { outputTokens: plusTokens(table.outputTokens, usage.outputTokens) }
      : {}),
    ...(table.cacheReadTokens && usage.cacheReadTokens != null
      ? { cacheReadTokens: plusTokens(table.cacheReadTokens, usage.cacheReadTokens) }
      : {}),
    ...(table.cacheWriteTokens && usage.cacheWriteTokens != null
      ? { cacheWriteTokens: plusTokens(table.cacheWriteTokens, usage.cacheWriteTokens) }
      : {}),
    ...(usage.costBasis ? { costBasis: usage.costBasis } : {}),
    ...(usage.model ? { modelUsed: usage.model } : {}),
  };
}
