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
 *
 * People paste their own tokens: Optio makes no keys on a gateway.
 */

import type { ModelGatewayType } from "./types/model-provider.js";

/** In the order Settings lists them (by label). */
export const MODEL_GATEWAY_TYPES: readonly ModelGatewayType[] = ["litellm", "generic"];

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
  /** What Settings shows in an empty base URL field. */
  baseUrlExample: string;
  /** The label of the second URL field (null = the type has none). */
  syncUrlLabel: string | null;
  /** What the second URL is for. */
  syncUrlHint: string | null;
  capabilities: ModelGatewayCapabilities;
}

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
    syncUrlLabel: null,
    syncUrlHint: null,
    capabilities: NONE,
  },
  litellm: {
    type: "litellm",
    label: "LiteLLM",
    baseUrlExample: "https://litellm.example.com",
    syncUrlLabel: "Sync URL",
    syncUrlHint: "Where LiteLLM answers /model/info and /key/info, when that isn't the base URL.",
    capabilities: {
      catalog: true,
      catalogDetails: true,
      catalogAddsModels: true,
      tokenBudget: true,
    },
  },
};

export function modelGatewayTypeInfo(type: unknown): ModelGatewayTypeInfo {
  return MODEL_GATEWAY_TYPE_INFO[modelGatewayTypeOf(type)];
}

export function modelGatewayCapabilities(type: unknown): ModelGatewayCapabilities {
  return modelGatewayTypeInfo(type).capabilities;
}
