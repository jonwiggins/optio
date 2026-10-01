import {
  getProviderCatalog,
  optionRunsOn,
  providerForAgentType,
  resolveModelId,
} from "@optio/shared";
import type { AgentOptionsValues } from "@/components/agent-options-picker";

/**
 * The pure half of `AgentChoice`: which runtimes exist, what they're called,
 * and how a repo row's agent columns map to and from the picker's values.
 * The picker's keys (`ProviderCatalog.modelField`, `OptionField.key`) are the
 * repo column names, so the mapping is mostly a filter.
 */

export const RUNTIMES: Array<{ value: string; label: string }> = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "OpenAI Codex" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "gemini", label: "Google Gemini" },
  { value: "cursor", label: "Cursor" },
  { value: "opencode", label: "OpenCode" },
  { value: "openclaw", label: "OpenClaw" },
];

/** The "no agent" choice: a bare terminal in the work form, "inherit" for a review agent. */
export const TERMINAL = "";

export function runtimeLabel(runtime: string): string {
  if (runtime === TERMINAL) return "terminal";
  return RUNTIMES.find((r) => r.value === runtime)?.label ?? runtime;
}

/**
 * The option keys a runtime's picker reads and writes (model first) —
 * `podOnly` drops the fields only a run on your machine takes (permission
 * modes), which have no repo column.
 */
export function optionKeysFor(runtime: string, podOnly = false): string[] {
  if (runtime === TERMINAL) return [];
  const catalog = getProviderCatalog(providerForAgentType(runtime));
  if (!catalog) return [];
  const options = podOnly ? catalog.options.filter((o) => optionRunsOn(o, "pod")) : catalog.options;
  return [catalog.modelField, ...options.map((o) => o.key)];
}

/**
 * Runtimes a repo keeps no settings for. Codex shares Copilot's
 * copilotModel / copilotEffort columns, so a repo's values there are
 * Copilot's — Codex runs on its own defaults.
 */
export const NO_REPO_SETTINGS = new Set(["codex"]);

/** The repo's configured values for this runtime's options, to seed the picker. */
export function optionsFromRepo(
  runtime: string,
  repo: Record<string, unknown> | null | undefined,
): AgentOptionsValues {
  if (!repo || NO_REPO_SETTINGS.has(runtime)) return {};
  const out: AgentOptionsValues = {};
  for (const k of optionKeysFor(runtime)) {
    const v = repo[k];
    if (typeof v === "string" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

/** What a repo row holds when nobody has set its agent (the DB column defaults). */
export const REPO_FACTORY_AGENT = "claude-code";
export const REPO_FACTORY_OPTIONS: AgentOptionsValues = {
  claudeModel: "opus",
  claudeContextWindow: "1m",
  claudeEffort: "high",
  geminiModel: "gemini-2.5-pro",
  geminiApprovalMode: "yolo",
};

/**
 * Whether the repo has settings of its own for `runtime` — any value that
 * isn't the column default. A repo nobody configured carries the defaults,
 * which shouldn't outrank the settings you used last.
 */
export function repoHasOwnOptions(
  runtime: string,
  repo: Record<string, unknown> | null | undefined,
): boolean {
  return Object.entries(optionsFromRepo(runtime, repo)).some(
    ([k, v]) => v !== "" && REPO_FACTORY_OPTIONS[k] !== v,
  );
}

/** The repo's default agent, when someone picked one (or set its options). */
export function repoOwnRuntime(repo: Record<string, unknown> | null | undefined): string | null {
  if (!repo) return null;
  const agent = typeof repo.defaultAgentType === "string" ? repo.defaultAgentType : null;
  if (!agent || !RUNTIMES.some((r) => r.value === agent)) return null;
  return agent !== REPO_FACTORY_AGENT || repoHasOwnOptions(agent, repo) ? agent : null;
}

/** Every agent column on a repo row, as one picker-values map. */
export function repoAgentValues(repo: Record<string, unknown>): AgentOptionsValues {
  const out: AgentOptionsValues = {};
  for (const r of RUNTIMES) Object.assign(out, optionsFromRepo(r.value, repo));
  // Columns the DB leaves null still read as the column default here.
  for (const [k, v] of Object.entries(REPO_FACTORY_OPTIONS)) {
    if (out[k] === undefined || out[k] === "") out[k] = v;
  }
  return out;
}

/**
 * The PATCH /api/repos/:id body for the agent: the default agent and every
 * agent column, by the rules the settings page always used: Claude Code's
 * strings go as they are (blank effort = the model's own), the OpenCode base
 * URL blank clears it, and any other blank goes as `undefined` (left alone).
 */
const SENT_AS_IS = new Set(["claudeModel", "claudeContextWindow", "claudeEffort"]);

export function repoAgentPatch(
  runtime: string,
  values: AgentOptionsValues,
): Record<string, string | boolean | null | undefined> {
  const patch: Record<string, string | boolean | null | undefined> = {
    defaultAgentType: runtime,
  };
  const keys = new Set(RUNTIMES.flatMap((r) => optionKeysFor(r.value, true)));
  for (const k of keys) {
    const v = values[k];
    if (typeof v === "boolean") patch[k] = v;
    else if (k === "opencodeBaseUrl") patch[k] = v || null;
    else if (SENT_AS_IS.has(k)) patch[k] = v ?? undefined;
    else patch[k] = v || undefined;
  }
  return patch;
}

/** Summary line for a card header: "Claude Code · opus · high". */
export function agentSummary(runtime: string, values: AgentOptionsValues): string {
  if (runtime === TERMINAL) return "";
  const keys = NO_REPO_SETTINGS.has(runtime) ? [] : optionKeysFor(runtime);
  const model = keys[0] ? values[keys[0]] : undefined;
  const effort = keys.find((k) => /Effort$/.test(k));
  const effortValue = effort ? values[effort] : undefined;
  return [runtimeLabel(runtime), model, effortValue]
    .filter((x): x is string => typeof x === "string" && x !== "")
    .join(" · ");
}

/** A review agent's model after its agent changes: that agent's catalog default. */
export function defaultModelFor(runtime: string): string {
  if (runtime === TERMINAL) return "";
  return resolveModelId(providerForAgentType(runtime), undefined) ?? "";
}

/** The picker key a review agent's model sits under (its catalog's model field). */
export function reviewModelField(runtime: string): string | null {
  if (runtime === TERMINAL) return null;
  return getProviderCatalog(providerForAgentType(runtime))?.modelField ?? null;
}
