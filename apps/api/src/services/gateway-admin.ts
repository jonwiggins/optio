import { modelGatewayTypeInfo, modelGatewayTypeOf, normalizeGatewayBaseUrl } from "@optio/shared";
import {
  GatewayAdminError,
  type GatewayAdmin,
  type GatewayKeyDriver,
} from "./gateway-admin-http.js";
import { liteLLMDriver } from "./litellm-admin.js";
import type { ModelProviderRow } from "./model-provider-service.js";
import { openRouterDriver } from "./openrouter-admin.js";

/**
 * The key-management driver for a gateway's type (docs/model-gateway.md
 * "Keys Optio makes"): LiteLLM (litellm-admin.ts) or OpenRouter
 * (openrouter-admin.ts). Other types have none: Optio doesn't make keys on
 * them (their `managedKeys` capability is off).
 */
export function keyDriver(admin: GatewayAdmin): GatewayKeyDriver {
  const type = modelGatewayTypeOf(admin.type);
  switch (type) {
    case "litellm":
      return liteLLMDriver(admin);
    case "openrouter":
      return openRouterDriver(admin);
    default:
      throw new GatewayAdminError(
        `Optio doesn't make keys on ${modelGatewayTypeInfo(type).label} gateways`,
        400,
      );
  }
}

/**
 * Where a gateway's management API answers: LiteLLM's at the sync URL, else
 * the base URL (`/key/*`); OpenRouter's at the base URL's `/v1` (`/keys`).
 * Both are URLs the gateway's token consent already names.
 */
export function adminBaseOf(row: Pick<ModelProviderRow, "gatewayType" | "baseUrl" | "syncUrl">) {
  const base = normalizeGatewayBaseUrl(row.baseUrl ?? "");
  if (modelGatewayTypeOf(row.gatewayType) === "openrouter") return `${base}/v1`;
  return normalizeGatewayBaseUrl(row.syncUrl || row.baseUrl || "");
}
