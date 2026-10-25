/**
 * Model gateway types (docs/model-gateway.md "Gateway types"): what a
 * `kind: "gateway"` model provider talks to, and which of Optio's gateway
 * features that product supports. Settings offers only what a type supports
 * and the API refuses the rest, so a feature a type lacks is hidden, never
 * half-run.
 *
 * - `generic`: any OpenAI- / Anthropic-compatible endpoint: a base URL and a
 *   token; the catalog's ids come from `GET /v1/models`.
 * - `litellm`: a LiteLLM proxy: the catalog with context windows and prices
 *   (`/model/info`), a token's budget (`/key/info`), and keys Optio makes
 *   with the admin key (`/key/*`, `/team/*`).
 * - `openrouter`: OpenRouter: the catalog with context lengths and prices
 *   (`/api/v1/models`), a token's limit and usage (`/api/v1/key`), and keys
 *   Optio makes with a management key (`/api/v1/keys`), each with a credit
 *   limit that resets daily, weekly or monthly.
 * - `portkey`: Portkey: the catalog's ids (`/v1/models`), and keys Optio
 *   makes with an admin API key (`/v1/api-keys`), each with a cost limit
 *   that resets weekly, monthly or every so many days.
 */

import { isValidGatewayDuration } from "./gateway-keys.js";
import type { ModelGatewayType } from "./types/model-provider.js";

/** In the order Settings lists them (by label). */
export const MODEL_GATEWAY_TYPES: readonly ModelGatewayType[] = [
  "litellm",
  "generic",
  "openrouter",
  "portkey",
];

/** The type a gateway saved before types existed has, and a new one gets when none is given. */
export const DEFAULT_MODEL_GATEWAY_TYPE: ModelGatewayType = "litellm";

export function isModelGatewayType(value: unknown): value is ModelGatewayType {
  return typeof value === "string" && (MODEL_GATEWAY_TYPES as readonly string[]).includes(value);
}

/** A stored type, or the default for a row without one. */
export function modelGatewayTypeOf(value: unknown): ModelGatewayType {
  return isModelGatewayType(value) ? value : DEFAULT_MODEL_GATEWAY_TYPE;
}

/** Which of Optio's gateway features a type supports. */
export interface ModelGatewayCapabilities {
  /** Sync reads the models the gateway serves. */
  catalog: boolean;
  /** Sync also reads each model's context window, output limit and prices. */
  catalogDetails: boolean;
  /**
   * Sync adds every model the gateway lists. Without it (a gateway that
   * lists hundreds) Sync refreshes the models the catalog already names,
   * and an admin adds the ones they want by id.
   */
  catalogAddsModels: boolean;
  /**
   * A token's own spend, budget and expiry can be read with the token:
   * the Overview's budget panel, credential health and the run pre-flight.
   */
  tokenBudget: boolean;
  /** Optio makes, rotates and revokes people's and teams' keys with an admin key. */
  managedKeys: boolean;
  /** A key Optio makes can carry a spending limit (a person's or a team's budget). */
  budgets: boolean;
  /** Optio reads what a key it made has spent: budget warnings and the usage panels. */
  spend: boolean;
  /** A key Optio makes can be limited to some of the catalog's models. */
  keyModels: boolean;
}

export interface ModelGatewayTypeInfo {
  type: ModelGatewayType;
  label: string;
  /** What Settings shows in an empty base URL field. */
  baseUrlExample: string;
  /** The label of the second URL field (null = the type has none). */
  syncUrlLabel: string | null;
  /** What the second URL is for. */
  syncUrlHint: string | null;
  /** What the gateway calls the key Optio makes keys with (null = no managed keys). */
  adminKeyName: string | null;
  /** Which key that is, in the gateway's own terms. */
  adminKeyHint: string | null;
  capabilities: ModelGatewayCapabilities;
}

const NONE: ModelGatewayCapabilities = {
  catalog: true,
  catalogDetails: false,
  catalogAddsModels: true,
  tokenBudget: false,
  managedKeys: false,
  budgets: false,
  spend: false,
  keyModels: false,
};

export const MODEL_GATEWAY_TYPE_INFO: Readonly<Record<ModelGatewayType, ModelGatewayTypeInfo>> = {
  generic: {
    type: "generic",
    label: "OpenAI- / Anthropic-compatible",
    baseUrlExample: "https://gateway.example.com",
    syncUrlLabel: null,
    syncUrlHint: null,
    adminKeyName: null,
    adminKeyHint: null,
    capabilities: NONE,
  },
  litellm: {
    type: "litellm",
    label: "LiteLLM",
    baseUrlExample: "https://litellm.example.com",
    syncUrlLabel: "Sync URL",
    syncUrlHint:
      "Where LiteLLM answers /model/info and its key routes, when that isn't the base URL.",
    adminKeyName: "LiteLLM admin key",
    adminKeyHint: "The master key, or a proxy admin's key.",
    capabilities: {
      catalog: true,
      catalogDetails: true,
      catalogAddsModels: true,
      tokenBudget: true,
      managedKeys: true,
      budgets: true,
      spend: true,
      keyModels: true,
    },
  },
  openrouter: {
    type: "openrouter",
    label: "OpenRouter",
    baseUrlExample: "https://openrouter.ai/api",
    syncUrlLabel: null,
    syncUrlHint: null,
    adminKeyName: "OpenRouter management key",
    adminKeyHint: "A management key (Settings → Management keys); it can't call models itself.",
    capabilities: {
      catalog: true,
      catalogDetails: true,
      catalogAddsModels: false,
      tokenBudget: true,
      managedKeys: true,
      budgets: true,
      spend: true,
      keyModels: false,
    },
  },
  portkey: {
    type: "portkey",
    label: "Portkey",
    baseUrlExample: "https://api.portkey.ai",
    syncUrlLabel: "Control plane URL",
    syncUrlHint:
      "Where Portkey's admin API answers (/api-keys), for a self-hosted control plane; empty = the base URL's /v1.",
    adminKeyName: "Portkey admin API key",
    adminKeyHint: "An API key allowed to create, update, rotate and delete workspace service keys.",
    capabilities: {
      catalog: true,
      catalogDetails: false,
      catalogAddsModels: true,
      tokenBudget: false,
      managedKeys: true,
      budgets: true,
      spend: false,
      keyModels: false,
    },
  },
};

export function modelGatewayTypeInfo(type: unknown): ModelGatewayTypeInfo {
  return MODEL_GATEWAY_TYPE_INFO[modelGatewayTypeOf(type)];
}

export function modelGatewayCapabilities(type: unknown): ModelGatewayCapabilities {
  return modelGatewayTypeInfo(type).capabilities;
}

// ── Budget periods ───────────────────────────────────────────────────────────

const DAY = 86_400;
const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: DAY,
  w: 7 * DAY,
  mo: 30 * DAY,
};

function seconds(duration: string): number | null {
  const m = duration.trim().match(/^(\d+)(s|m|h|d|w|mo)$/);
  return m ? Number(m[1]) * (UNIT_SECONDS[m[2]] ?? 0) : null;
}

/**
 * Whether `type` takes `period` as a budget's reset period as it stands:
 * LiteLLM any duration ("30d", "1mo", "12h"); OpenRouter `1d`, `1w` or `1mo`
 * (daily, weekly, monthly, in UTC); Portkey `1w`, `1mo` or 1 to 365 days.
 */
export function isGatewayBudgetPeriod(type: unknown, period: string): boolean {
  const v = period.trim();
  switch (modelGatewayTypeOf(type)) {
    case "openrouter":
      return v === "1d" || v === "1w" || v === "1mo";
    case "portkey": {
      if (v === "1w" || v === "1mo") return true;
      const m = v.match(/^(\d{1,3})d$/);
      return !!m && Number(m[1]) >= 1 && Number(m[1]) <= 365;
    }
    default:
      return isValidGatewayDuration(v);
  }
}

/**
 * The period `type` takes that is nearest to `period` (a LiteLLM duration):
 * the period itself when the type takes it; for OpenRouter a day or less →
 * `1d`, up to a week → `1w`, longer → `1mo`; for Portkey whole days (1 to
 * 365), a week or a month. Null stays null (never resets); garbage is null.
 */
export function gatewayBudgetPeriodFor(type: unknown, period: string | null): string | null {
  if (period === null) return null;
  const v = period.trim();
  if (isGatewayBudgetPeriod(type, v)) return v;
  const s = seconds(v);
  if (s === null || s <= 0) return null;
  switch (modelGatewayTypeOf(type)) {
    case "openrouter":
      return s <= DAY ? "1d" : s <= 7 * DAY ? "1w" : "1mo";
    case "portkey":
      return `${Math.min(365, Math.max(1, Math.round(s / DAY)))}d`;
    default:
      return null;
  }
}

/**
 * Why `type` won't take `amount` (USD) as a key's budget, or null when it
 * will (null = no cap is always taken): Portkey takes whole USD, 1 or more.
 */
export function gatewayBudgetProblem(type: unknown, amount: number | null): string | null {
  if (amount === null) return null;
  if (modelGatewayTypeOf(type) === "portkey" && (!Number.isInteger(amount) || amount < 1)) {
    return "Portkey takes a budget in whole USD, 1 or more";
  }
  return null;
}
