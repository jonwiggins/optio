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
      id: "claude-opus-4-8",
      label: "Opus 4.8",
      family: "opus",
      latest: true,
      source: "baseline",
    },
    {
      id: "claude-opus-4-7",
      label: "Opus 4.7",
      family: "opus",
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
    {
      id: "claude-fable-5",
      label: "Fable 5",
      family: "fable",
      source: "baseline",
    },
  ],
  aliases: {
    opus: "claude-opus-4-8",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5-20251001",
    fable: "claude-fable-5",
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
      runsOn: ["pod", "local"],
      localParam: "effort",
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
    {
      // Pods always skip permission checks (the pod is the sandbox); on your
      // own machine the daemon passes `--permission-mode`.
      key: "claudePermissionMode",
      label: "Permissions",
      kind: "select",
      default: "auto",
      runsOn: ["local"],
      localParam: "permissionMode",
      choices: [
        {
          value: "auto",
          label: "Auto",
          description: "Claude's classifier approves routine actions and blocks risky ones",
        },
        {
          value: "bypassPermissions",
          label: "Skip all checks",
          description: "--dangerously-skip-permissions: nothing is asked or blocked",
        },
        {
          value: "default",
          label: "Ask first",
          description: "Asks before edits and commands; a run that exits when done can't ask",
        },
      ],
      helpText:
        "Auto keeps the agent moving without prompts and still blocks risky actions; Skip all checks runs everything it tries.",
    },
  ],
  liveRefreshSupported: true,
};
