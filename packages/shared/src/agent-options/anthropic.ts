import type { ProviderCatalog } from "./types.js";

/**
 * Hardcoded baseline for Anthropic (Claude Code agent). Kept in sync with
 * whatever model ids are currently deployed; the `/api/agents/anthropic/options`
 * endpoint augments this list from Anthropic's `/v1/models` API.
 */
export const ANTHROPIC_CATALOG: ProviderCatalog = {
  provider: "anthropic",
  label: "Claude Code",
  modelField: "claudeModel",
  models: [
    {
      id: "claude-opus-4-7",
      label: "Opus 4.7",
      family: "opus",
      latest: true,
      source: "baseline",
    },
    {
      id: "claude-opus-4-6",
      label: "Opus 4.6",
      family: "opus",
      source: "baseline",
    },
    {
      id: "claude-sonnet-4-6",
      label: "Sonnet 4.6",
      family: "sonnet",
      latest: true,
      source: "baseline",
    },
    {
      id: "claude-sonnet-4-5",
      label: "Sonnet 4.5",
      family: "sonnet",
      source: "baseline",
    },
    {
      id: "claude-haiku-4-5-20251001",
      label: "Haiku 4.5",
      family: "haiku",
      latest: true,
      source: "baseline",
    },
  ],
  aliases: {
    opus: "claude-opus-4-7",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5-20251001",
  },
  options: [
    {
      key: "claudeContextWindow",
      label: "Context Window",
      kind: "select",
      default: "1m",
      choices: [
        { value: "200k", label: "200K tokens" },
        { value: "1m", label: "1M tokens" },
      ],
    },
    {
      key: "claudeEffort",
      label: "Effort Level",
      kind: "select",
      default: "high",
      choices: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    },
    {
      key: "claudeThinking",
      label: "Extended Thinking",
      kind: "boolean",
      default: true,
    },
  ],
  liveRefreshSupported: true,
};
