import type { ProviderCatalog } from "./types.js";

/**
 * Hardcoded baseline for OpenAI (Codex agent). Lives under the `openai`
 * provider id because the underlying list-models API is OpenAI's.
 *
 * The live list comes first from Codex itself: each Optio Local daemon reads
 * the machine's Codex model catalog (`codex debug models`: the models, their
 * reasoning efforts and defaults, in Codex's own order) and the options
 * endpoint merges it in (`mergeCodexModels`). This baseline mirrors that
 * catalog as of Codex 0.146 for installs with no machine paired; older ids
 * stay so saved rows keep their label.
 *
 * NOTE: the DB columns for this are `repos.copilotModel` / `copilotEffort`
 * — a historical naming quirk shared with Copilot; see `docs/tasks.md`. We
 * keep `modelField: "copilotModel"` and the `copilotEffort` key so the UI
 * writes the columns the runtime reads.
 */
const FULL_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const STANDARD_EFFORTS = ["low", "medium", "high", "xhigh"];

export const OPENAI_CATALOG: ProviderCatalog = {
  provider: "openai",
  label: "OpenAI Codex",
  modelField: "copilotModel",
  models: [
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      latest: true,
      efforts: FULL_EFFORTS,
      defaultEffort: "low",
      source: "baseline",
    },
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6-Terra",
      description: "Balanced agentic coding model for everyday work.",
      efforts: FULL_EFFORTS,
      defaultEffort: "medium",
      source: "baseline",
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6-Luna",
      description: "Fast and affordable agentic coding model.",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      source: "baseline",
    },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      efforts: STANDARD_EFFORTS,
      defaultEffort: "medium",
      source: "baseline",
    },
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      efforts: STANDARD_EFFORTS,
      defaultEffort: "medium",
      source: "baseline",
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4-Mini",
      efforts: STANDARD_EFFORTS,
      defaultEffort: "medium",
      source: "baseline",
    },
    {
      id: "gpt-5.2",
      label: "GPT-5.2",
      efforts: STANDARD_EFFORTS,
      defaultEffort: "medium",
      source: "baseline",
    },
  ],
  aliases: {
    "gpt-5": "gpt-5.4",
    "gpt-5-mini": "gpt-5.4-mini",
  },
  options: [
    {
      key: "copilotEffort",
      label: "Reasoning effort",
      kind: "select",
      runsOn: ["pod", "local"],
      localParam: "effort",
      modelEfforts: true,
      choices: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra high" },
        { value: "max", label: "Max" },
        { value: "ultra", label: "Ultra" },
      ],
    },
  ],
  liveRefreshSupported: true,
};
