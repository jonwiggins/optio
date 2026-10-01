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

/** `column + amount`, for a cost stored as a decimal string (null and '' count as 0). */
export function plusCost(column: AnyColumn, amount: string | number): SQL<string> {
  return sql<string>`trim_scale(COALESCE(NULLIF(${column}, ''), '0')::numeric + ${String(amount)}::numeric)::text`;
}

/** `column + amount`, for a token count (null counts as 0). */
export function plusTokens(column: AnyColumn, amount: number): SQL<number> {
  return sql<number>`COALESCE(${column}, 0) + ${Math.round(amount)}`;
}

export interface Usage {
  costUsd?: number | string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  model?: string | null;
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
  },
  usage: Usage,
): {
  costUsd?: SQL<string>;
  inputTokens?: SQL<number>;
  outputTokens?: SQL<number>;
  modelUsed?: string;
} {
  return {
    ...(usage.costUsd != null ? { costUsd: plusCost(table.costUsd, usage.costUsd) } : {}),
    ...(usage.inputTokens != null
      ? { inputTokens: plusTokens(table.inputTokens, usage.inputTokens) }
      : {}),
    ...(usage.outputTokens != null
      ? { outputTokens: plusTokens(table.outputTokens, usage.outputTokens) }
      : {}),
    ...(usage.model ? { modelUsed: usage.model } : {}),
  };
}
