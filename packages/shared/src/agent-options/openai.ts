import type { ProviderCatalog } from "./types.js";

/**
 * Hardcoded baseline for OpenAI (Codex agent). Lives under the `openai`
 * provider id because the underlying list-models API is OpenAI's.
 *
 * NOTE: the DB column for this is `repos.copilotModel` — a historical naming
 * quirk; see `docs/tasks.md`. We keep `modelField: "copilotModel"` here so
 * the UI writes to the correct column.
 */
export const OPENAI_CATALOG: ProviderCatalog = {
  provider: "openai",
  label: "OpenAI Codex",
  modelField: "copilotModel",
  models: [
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
    {
      id: "claude-sonnet-4.5",
      label: "Claude Sonnet 4.5",
      family: "sonnet",
      source: "baseline",
    },
  ],
  aliases: {
    "gpt-5": "gpt-5.4",
    "gpt-5-mini": "gpt-5.4-mini",
  },
  options: [],
  liveRefreshSupported: true,
};
