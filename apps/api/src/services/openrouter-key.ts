import { z } from "zod";

/**
 * OpenRouter's answers about a key (docs/model-gateway.md "OpenRouter"):
 * `GET /api/v1/key` with the key itself. Read through zod, so an answer of
 * another shape reads as nothing rather than as a budget.
 */

/** What a key has spent this period, and of what. */
export interface OpenRouterSpend {
  /** USD. */
  spend: number;
  /** USD; null = no limit. */
  maxBudget: number | null;
  /** ISO time the limit resets, when it does. */
  budgetResetAt: string | null;
  /** The reset as a duration (`1d`, `1w`, `1mo`), when it resets. */
  budgetDuration: string | null;
  /** OpenRouter disabled the key. */
  blocked: boolean;
}

const money = z.union([z.number(), z.string()]).nullish();

/** The fields of a key object Optio reads (OpenRouter sends more). */
export const openRouterKeySchema = z
  .object({
    label: z.string().max(500).nullish(),
    limit: money,
    limit_remaining: money,
    limit_reset: z.string().max(20).nullish(),
    usage: money,
    usage_daily: money,
    usage_weekly: money,
    usage_monthly: money,
    disabled: z.boolean().nullish(),
    expires_at: z.string().max(64).nullish(),
  })
  .passthrough();

export type OpenRouterKey = z.infer<typeof openRouterKeySchema>;

/** `{ data: <key> }`, the shape of `GET /api/v1/key`; null for anything else. */
export function parseOpenRouterKey(body: unknown): OpenRouterKey | null {
  const parsed = z.object({ data: openRouterKeySchema }).safeParse(body);
  return parsed.success ? parsed.data.data : null;
}

function amount(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const PERIODS: Record<string, string> = { daily: "1d", weekly: "1w", monthly: "1mo" };

/** When a `limit_reset` period running at `now` ends: the next midnight, Monday or 1st, UTC. */
export function openRouterResetAt(reset: unknown, now = new Date()): string | null {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (reset === "daily") return new Date(day + 86_400_000).toISOString();
  if (reset === "weekly") {
    // getUTCDay: Sunday 0 … Saturday 6; OpenRouter's weeks start on Monday.
    const toMonday = ((8 - now.getUTCDay()) % 7 || 7) * 86_400_000;
    return new Date(day + toMonday).toISOString();
  }
  if (reset === "monthly") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  }
  return null;
}

/**
 * A key's spend this period: its limit less what remains when it has a
 * limit, else the usage of its reset period (all-time when it never resets).
 */
export function openRouterSpend(key: OpenRouterKey, now = new Date()): OpenRouterSpend {
  const reset = key.limit_reset ?? null;
  const limit = amount(key.limit);
  const remaining = amount(key.limit_remaining);
  const usage =
    reset === "daily"
      ? key.usage_daily
      : reset === "weekly"
        ? key.usage_weekly
        : reset === "monthly"
          ? key.usage_monthly
          : key.usage;
  const spend =
    limit !== null && remaining !== null ? Math.max(0, limit - remaining) : (amount(usage) ?? 0);
  return {
    spend: Math.round(spend * 1e6) / 1e6,
    maxBudget: limit,
    budgetResetAt: openRouterResetAt(reset, now),
    budgetDuration: (reset && PERIODS[reset]) ?? null,
    blocked: key.disabled === true,
  };
}
