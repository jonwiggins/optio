import { getProviderCatalog, providerForAgentType } from "@optio/shared";

/**
 * Per-run agent parameters → the env vars the pooled-pod command builders
 * (`workflow-worker`, `persistent-agent-worker`) turn into CLI flags.
 *
 * Repo Tasks go through the agent adapters, which write settings files into
 * the worktree pod. Job and Persistent Agent pods have no adapter step — the
 * command is built from env — so this is the one place that maps the catalog
 * keys (`claudeEffort`, `copilotEffort`, `geminiApprovalMode`, …) onto the
 * flags each CLI takes. Keys match `ProviderCatalog.modelField` and
 * `OptionField.key`, i.e. the `repos` columns.
 *
 * `fallbackModel` is the legacy single `model` column, honored when the
 * options carry no model for the runtime.
 */
export function agentOptionsEnv(
  agentType: string,
  options: Record<string, string | boolean> | null | undefined,
  fallbackModel?: string | null,
): Record<string, string> {
  const o = options ?? {};
  const str = (key: string): string | undefined => {
    const v = o[key];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const catalog = getProviderCatalog(providerForAgentType(agentType));
  const model = (catalog ? str(catalog.modelField) : undefined) ?? fallbackModel ?? undefined;

  const env: Record<string, string> = {};
  switch (agentType) {
    case "claude-code": {
      if (model) env.OPTIO_CLAUDE_MODEL = model;
      const ctx = str("claudeContextWindow");
      if (ctx) env.OPTIO_CLAUDE_CONTEXT_WINDOW = ctx;
      // Effort + thinking ride along as a `--settings` JSON blob — the same
      // keys the claude-code adapter writes to ~/.claude/settings.json.
      const settings: Record<string, unknown> = {};
      const effort = str("claudeEffort");
      if (effort) settings.effortLevel = effort;
      if (typeof o.claudeThinking === "boolean") settings.alwaysThinkingEnabled = o.claudeThinking;
      if (Object.keys(settings).length) env.OPTIO_CLAUDE_SETTINGS_JSON = JSON.stringify(settings);
      break;
    }
    case "copilot":
    case "codex": {
      if (model) env.COPILOT_MODEL = model;
      const effort = str("copilotEffort");
      if (effort) env.COPILOT_EFFORT = effort;
      break;
    }
    case "opencode": {
      if (model) env.OPTIO_OPENCODE_MODEL = model;
      const agent = str("opencodeAgent");
      if (agent) env.OPTIO_OPENCODE_AGENT = agent;
      const baseUrl = str("opencodeBaseUrl");
      if (baseUrl) env.OPTIO_OPENCODE_BASE_URL = baseUrl;
      break;
    }
    case "gemini": {
      if (model) env.OPTIO_GEMINI_MODEL = model;
      const approval = str("geminiApprovalMode");
      if (approval) env.OPTIO_GEMINI_APPROVAL_MODE = approval;
      break;
    }
    case "cursor": {
      if (model) env.OPTIO_CURSOR_MODEL = model;
      break;
    }
    default: {
      // Unknown runtime: keep the legacy behavior (a Claude model hint).
      if (model) env.OPTIO_CLAUDE_MODEL = model;
    }
  }
  return env;
}
