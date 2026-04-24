import type { ProviderCatalog } from "./types.js";

/**
 * OpenClaw wraps a downstream provider and accepts free-text model / agent
 * identifiers. No public list-models API, so no live refresh.
 */
export const OPENCLAW_CATALOG: ProviderCatalog = {
  provider: "openclaw",
  label: "OpenClaw",
  modelField: "openclawModel",
  modelIsFreeText: true,
  modelPlaceholder: "Default (auto-detect)",
  models: [],
  aliases: {},
  options: [
    {
      key: "openclawAgent",
      label: "Agent",
      kind: "text",
      placeholder: "Default",
    },
  ],
  liveRefreshSupported: false,
};
