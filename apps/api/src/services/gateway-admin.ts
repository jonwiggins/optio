import { modelGatewayTypeInfo, modelGatewayTypeOf, normalizeGatewayBaseUrl } from "@optio/shared";
import {
  GatewayAdminError,
  type GatewayAdmin,
  type GatewayKeyDriver,
} from "./gateway-admin-http.js";
import { liteLLMDriver } from "./litellm-admin.js";
import type { ModelProviderRow } from "./model-provider-service.js";
import { openRouterDriver } from "./openrouter-admin.js";
import { portkeyDriver } from "./portkey-admin.js";

/**
 * The key-management driver for a gateway's type (docs/model-gateway.md
 * "Gateway types"): LiteLLM (litellm-admin.ts), OpenRouter
 * (openrouter-admin.ts) or Portkey (portkey-admin.ts). A generic gateway has
 * none: Optio doesn't make keys on it (its `managedKeys` capability is off).
 */
export function keyDriver(admin: GatewayAdmin): GatewayKeyDriver {
  const type = modelGatewayTypeOf(admin.type);
  switch (type) {
    case "litellm":
      return liteLLMDriver(admin);
    case "openrouter":
      return openRouterDriver(admin);
    case "portkey":
      return portkeyDriver(admin);
    default:
      throw new GatewayAdminError(
        `Optio doesn't make keys on ${modelGatewayTypeInfo(type).label} gateways`,
        400,
      );
  }
}

/**
 * Where a gateway's management API answers: LiteLLM's at the sync URL, else
 * the base URL (`/key/*`, `/team/*`); OpenRouter's at the base URL's `/v1`
 * (`/keys`); Portkey's at the control plane URL (the sync URL field), else
 * the base URL's `/v1` (`/api-keys`).
 */
export function adminBaseOf(row: Pick<ModelProviderRow, "gatewayType" | "baseUrl" | "syncUrl">) {
  const base = normalizeGatewayBaseUrl(row.baseUrl ?? "");
  switch (modelGatewayTypeOf(row.gatewayType)) {
    case "openrouter":
      return `${base}/v1`;
    case "portkey":
      return row.syncUrl ? normalizeGatewayBaseUrl(row.syncUrl) : `${base}/v1`;
    default:
      return normalizeGatewayBaseUrl(row.syncUrl || row.baseUrl || "");
  }
}
