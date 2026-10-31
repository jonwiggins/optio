import type { ModelOption, ModelProviderModel, ProviderCatalog } from "@optio/shared";

/**
 * A model gateway's catalog as the picker shows it before (and without)
 * the API's answer (docs/model-gateway.md): the same shape
 * `GET /api/agents/:provider/options?provider=<id>` builds server-side —
 * the gateway's models with their efforts, no aliases, and the vendor
 * catalog's options minus what the catalog already says (Claude Code's
 * context window comes from the model), so the form never flashes the
 * stock list or the context-window field while the fetch is in flight.
 */

/** Option fields a gateway catalog leaves out: the catalog says it per model. */
export const GATEWAY_HIDDEN_OPTIONS: readonly string[] = ["claudeContextWindow"];

export function gatewayModelOption(m: ModelProviderModel): ModelOption {
  return {
    id: m.id,
    label: m.label?.trim() || m.id,
    ...(m.efforts ? { efforts: [...m.efforts] } : {}),
    ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
    ...(m.missing ? { description: "Not served by the gateway since the last sync" } : {}),
    source: "live",
  };
}

export function gatewayCatalogFor(
  baseline: ProviderCatalog,
  gatewayName: string,
  models: ModelProviderModel[],
): ProviderCatalog {
  return {
    ...baseline,
    label: `${baseline.label} via ${gatewayName}`,
    modelIsFreeText: false,
    modelPlaceholder: undefined,
    modelHelpText: `Models ${gatewayName} serves (Settings → Model gateway)`,
    models: models.map(gatewayModelOption),
    aliases: {},
    options: baseline.options.filter((o) => !GATEWAY_HIDDEN_OPTIONS.includes(o.key)),
    liveRefreshSupported: false,
  };
}
