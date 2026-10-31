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
 *   (`/model/info`) and a token's budget (`/key/info`).
 * - `openrouter`: OpenRouter: context lengths and prices for the models the
 *   catalog names (`/api/v1/models` lists hundreds, so Sync adds none) and a
 *   token's limit and usage (`/api/v1/key`). Bearer tokens only.
 * - `portkey`: Portkey: the catalog's ids (`/v1/models`); its key goes in its
 *   own `x-portkey-api-key` header. Bearer tokens only.
 *
 * People paste their own tokens: Optio makes no keys on a gateway.
 */

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
};

export const MODEL_GATEWAY_TYPE_INFO: Readonly<Record<ModelGatewayType, ModelGatewayTypeInfo>> = {
  generic: {
    type: "generic",
    label: "OpenAI- / Anthropic-compatible",
    baseUrlExample: "https://gateway.example.com",
    hosted: false,
    authHeaders: BOTH_HEADERS,
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
    syncUrlLabel: "Sync URL",
    syncUrlHint: "Where LiteLLM answers /model/info and /key/info, when that isn't the base URL.",
    capabilities: {
      catalog: true,
      catalogDetails: true,
      catalogAddsModels: true,
      tokenBudget: true,
    },
  },
  openrouter: {
    type: "openrouter",
    label: "OpenRouter",
    baseUrlExample: "https://openrouter.ai/api",
    hosted: true,
    // Its Claude Code guide: the key as ANTHROPIC_AUTH_TOKEN, no ANTHROPIC_API_KEY.
    authHeaders: ["bearer"],
    syncUrlLabel: null,
    syncUrlHint: null,
    capabilities: {
      catalog: true,
      catalogDetails: true,
      catalogAddsModels: false,
      tokenBudget: true,
    },
  },
  portkey: {
    type: "portkey",
    label: "Portkey",
    baseUrlExample: "https://api.portkey.ai",
    hosted: true,
    authHeaders: ["bearer"],
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
