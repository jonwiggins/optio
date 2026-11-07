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
 *   with the admin key (`/key/*`).
 * - `openrouter`: OpenRouter: context lengths and prices for the models the
 *   catalog names (`/api/v1/models` lists hundreds, so Sync adds none) and a
 *   token's limit and usage (`/api/v1/key`), and keys Optio makes with a
 *   management key (`/api/v1/keys`), each with a credit limit that resets
 *   daily, weekly or monthly. Bearer tokens only.
 * - `portkey`: Portkey: the catalog's ids (`/v1/models`); its key goes in its
 *   own `x-portkey-api-key` header. Bearer tokens only.
 *
 * Elsewhere people paste their own tokens: Optio makes no keys there.
 */

import { isValidGatewayDuration } from "./gateway-keys.js";
import type { ModelGatewayType, ModelProviderAuthHeader } from "./types/model-provider.js";

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
  /** A token's own spend and budget can be read with the token (the Overview's budget panel). */
  tokenBudget: boolean;
  /** Optio makes, rotates and revokes people's keys with an admin key. */
  managedKeys: boolean;
  /** A key Optio makes can carry a spending limit. */
  budgets: boolean;
  /** Optio reads what a key it made has spent (the admin's key list, carrying spend over). */
  spend: boolean;
  /** A key Optio makes can be limited to some of the catalog's models. */
  keyModels: boolean;
}

export interface ModelGatewayTypeInfo {
  type: ModelGatewayType;
  label: string;
  /**
   * What Settings shows in an empty base URL field; for a `hosted` type, its
   * public URL, which picking the type fills in.
   */
  baseUrlExample: string;
  /** A service with one public URL (OpenRouter, Portkey), not one you run. */
  hosted: boolean;
  /**
   * How Claude Code may send the token (`authHeader`): the auth headers the
   * type takes. Settings offers only these and the API refuses the rest.
   */
  authHeaders: readonly ModelProviderAuthHeader[];
  /** What the gateway calls the key Optio makes keys with (null = no managed keys). */
  adminKeyName: string | null;
  /** Which key that is, in the gateway's own terms. */
  adminKeyHint: string | null;
  /** The label of the second URL field (null = the type has none, and the API refuses one). */
  syncUrlLabel: string | null;
  /** What the second URL is for. */
  syncUrlHint: string | null;
  capabilities: ModelGatewayCapabilities;
}

const BOTH_HEADERS: readonly ModelProviderAuthHeader[] = ["bearer", "api-key"];

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
    hosted: false,
    authHeaders: BOTH_HEADERS,
    adminKeyName: null,
    adminKeyHint: null,
    syncUrlLabel: null,
    syncUrlHint: null,
    capabilities: NONE,
  },
  litellm: {
    type: "litellm",
    label: "LiteLLM",
    baseUrlExample: "https://litellm.example.com",
    hosted: false,
    authHeaders: BOTH_HEADERS,
    adminKeyName: "LiteLLM admin key",
    adminKeyHint: "The master key, or a proxy admin's key.",
    syncUrlLabel: "Sync URL",
    syncUrlHint: "Where LiteLLM answers /model/info and /key/info, when that isn't the base URL.",
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
    hosted: true,
    // Its Claude Code guide: the key as ANTHROPIC_AUTH_TOKEN, no ANTHROPIC_API_KEY.
    authHeaders: ["bearer"],
    adminKeyName: "OpenRouter management key",
    adminKeyHint: "A management key (Settings → Management keys); it can't call models itself.",
    syncUrlLabel: null,
    syncUrlHint: null,
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
    hosted: true,
    authHeaders: ["bearer"],
    adminKeyName: null,
    adminKeyHint: null,
    syncUrlLabel: null,
    syncUrlHint: null,
    capabilities: NONE,
  },
};

export function modelGatewayTypeInfo(type: unknown): ModelGatewayTypeInfo {
  return MODEL_GATEWAY_TYPE_INFO[modelGatewayTypeOf(type)];
}

export function modelGatewayCapabilities(type: unknown): ModelGatewayCapabilities {
  return modelGatewayTypeInfo(type).capabilities;
}

/** Whether a gateway of `type` takes `authHeader` (`ModelGatewayTypeInfo.authHeaders`). */
export function gatewayTypeTakesAuthHeader(
  type: unknown,
  authHeader: ModelProviderAuthHeader,
): boolean {
  return modelGatewayTypeInfo(type).authHeaders.includes(authHeader);
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
 * (daily, weekly, monthly, in UTC).
 */
export function isGatewayBudgetPeriod(type: unknown, period: string): boolean {
  const v = period.trim();
  if (modelGatewayTypeOf(type) === "openrouter") return v === "1d" || v === "1w" || v === "1mo";
  return isValidGatewayDuration(v);
}

/**
 * The period `type` takes that is nearest to `period` (a LiteLLM duration):
 * the period itself when the type takes it; for OpenRouter a day or less →
 * `1d`, up to a week → `1w`, longer → `1mo`. Null stays null (never
 * resets); garbage is null.
 */
export function gatewayBudgetPeriodFor(type: unknown, period: string | null): string | null {
  if (period === null) return null;
  const v = period.trim();
  if (isGatewayBudgetPeriod(type, v)) return v;
  const s = seconds(v);
  if (s === null || s <= 0) return null;
  if (modelGatewayTypeOf(type) === "openrouter") {
    return s <= DAY ? "1d" : s <= 7 * DAY ? "1w" : "1mo";
  }
  return null;
}
