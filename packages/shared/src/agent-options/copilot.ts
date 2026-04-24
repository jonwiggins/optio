import type { ProviderCatalog } from "./types.js";

/**
 * Hardcoded baseline for GitHub Copilot. Copilot CLI resolves models locally
 * with no public list-models API, so this is the final source of truth (no
 * live refresh to merge in).
 */
export const COPILOT_CATALOG: ProviderCatalog = {
  provider: "copilot",
  label: "GitHub Copilot",
  modelField: "copilotModel",
  models: [
    {
      id: "claude-sonnet-4.5",
      label: "Claude Sonnet 4.5",
      family: "sonnet",
      source: "baseline",
    },
    {
      id: "gpt-5",
      label: "GPT-5",
      family: "gpt-5",
      source: "baseline",
    },
    {
      id: "gpt-5.2",
      label: "GPT-5.2",
      family: "gpt-5",
      source: "baseline",
    },
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      family: "gpt-5",
      latest: true,
      source: "baseline",
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      family: "gpt-5-mini",
      latest: true,
      source: "baseline",
    },
  ],
  aliases: {},
  options: [
    {
      key: "copilotEffort",
      label: "Reasoning Effort",
      kind: "select",
      default: "",
      choices: [
        { value: "", label: "Default" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    },
  ],
  liveRefreshSupported: false,
};
