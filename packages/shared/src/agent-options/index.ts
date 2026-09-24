import { ANTHROPIC_CATALOG } from "./anthropic.js";
import { OPENAI_CATALOG } from "./openai.js";
import { GEMINI_CATALOG } from "./gemini.js";
import { COPILOT_CATALOG } from "./copilot.js";
import { OPENCODE_CATALOG } from "./opencode.js";
import { OPENCLAW_CATALOG } from "./openclaw.js";
import { CURSOR_CATALOG } from "./cursor.js";
import type {
  AgentProviderId,
  LiveModel,
  ModelOption,
  OptionChoice,
  OptionField,
  ProviderCatalog,
} from "./types.js";
import { LOCAL_AGENT_PERMISSION_MODES, type LocalAgentPermissionMode } from "../types/local.js";

export type {
  AgentProviderId,
  LiveModel,
  ModelOption,
  OptionChoice,
  OptionField,
  ProviderCatalog,
} from "./types.js";
export { ANTHROPIC_CATALOG } from "./anthropic.js";
export { OPENAI_CATALOG } from "./openai.js";
export { GEMINI_CATALOG } from "./gemini.js";
export { COPILOT_CATALOG } from "./copilot.js";
export { OPENCODE_CATALOG } from "./opencode.js";
export { OPENCLAW_CATALOG } from "./openclaw.js";
export { CURSOR_CATALOG } from "./cursor.js";

/** All providers, keyed by id. */
export const PROVIDER_CATALOGS: Record<AgentProviderId, ProviderCatalog> = {
  anthropic: ANTHROPIC_CATALOG,
  openai: OPENAI_CATALOG,
  gemini: GEMINI_CATALOG,
  copilot: COPILOT_CATALOG,
  opencode: OPENCODE_CATALOG,
  openclaw: OPENCLAW_CATALOG,
  cursor: CURSOR_CATALOG,
};

export const ALL_PROVIDER_IDS: readonly AgentProviderId[] = [
  "anthropic",
  "openai",
  "gemini",
  "copilot",
  "opencode",
  "openclaw",
  "cursor",
];

/**
 * The set of agent type identifiers persisted in `repos.default_agent_type`,
 * `repos.review_agent_type`, etc. Each one maps to a provider catalog via
 * `providerForAgentType()`.
 */
export type AgentType =
  | "claude-code"
  | "codex"
  | "copilot"
  | "opencode"
  | "gemini"
  | "openclaw"
  | "cursor";

export const AGENT_TYPES: readonly AgentType[] = [
  "claude-code",
  "codex",
  "copilot",
  "opencode",
  "gemini",
  "openclaw",
  "cursor",
];

/**
 * Map an agent type (DB value) to the provider catalog id used by
 * `PROVIDER_CATALOGS`. Each agent type has exactly one matching catalog.
 */
export function providerForAgentType(agentType: AgentType | string): AgentProviderId {
  switch (agentType) {
    case "claude-code":
      return "anthropic";
    case "codex":
      return "openai";
    case "gemini":
      return "gemini";
    case "copilot":
      return "copilot";
    case "opencode":
      return "opencode";
    case "openclaw":
      return "openclaw";
    case "cursor":
      return "cursor";
    default:
      // Fall back to anthropic — preserves existing behavior for legacy rows.
      return "anthropic";
  }
}

/**
 * True if the given model id (or alias) belongs to the catalog for `agentType`.
 * Used by the API layer to reject mismatched (agentType, model) pairs.
 */
export function modelBelongsToAgentCatalog(agentType: AgentType | string, model: string): boolean {
  const catalog = PROVIDER_CATALOGS[providerForAgentType(agentType)];
  if (!catalog) return false;
  if (model in catalog.aliases) return true;
  if (catalog.modelIsFreeText) return true;
  return catalog.models.some((m) => m.id === model);
}

/**
 * Resolve a possibly-aliased model string (e.g. `opus`, `sonnet`, a full dated
 * id, or `undefined`) to a concrete model id for the given provider.
 *
 * Priority:
 *   1. The input is a known alias → return the target id.
 *   2. The input matches an existing model id in the catalog → return as-is.
 *   3. The input is a non-empty string → return as-is (free-text providers,
 *      or a dated id we haven't cataloged yet).
 *   4. Empty/undefined → return the `latest` model of the first family, or
 *      the first cataloged model, or `undefined` if the provider is free-text
 *      with no defaults.
 */
export function resolveModelId(
  providerId: AgentProviderId,
  input: string | null | undefined,
): string | undefined {
  const catalog = PROVIDER_CATALOGS[providerId];
  if (!catalog) return input ?? undefined;

  if (input && catalog.aliases[input]) {
    return catalog.aliases[input];
  }

  if (input) {
    // Exact match against a cataloged model id
    if (catalog.models.some((m) => m.id === input)) return input;
    // Unknown string — pass through (covers free-text + uncataloged ids)
    return input;
  }

  // No input → pick a sensible default
  const latest = catalog.models.find((m) => m.latest);
  if (latest) return latest.id;
  const first = catalog.models[0];
  return first?.id;
}

/**
 * Merge a list of live models (from a provider's list-models API) into the
 * hardcoded baseline. Live entries not present in the baseline are appended;
 * existing entries are preserved so we don't lose labels/family metadata.
 *
 * Live additions are labeled with the provider's display name when available
 * and assigned to a baseline family when their id contains one (longest match
 * wins), so they slot into the UI's grouped dropdown instead of each forming
 * a single-model group.
 *
 * Anthropic ids carry their version, so for Anthropic the merge also keeps
 * the aliases honest: a family's `latest` — and the alias that names it —
 * moves to the newest model the live list has, and each family reads
 * newest-first. "opus" is the newest Opus the key can see the day it ships,
 * not whatever the baseline was last edited to say.
 */
export function mergeLiveModels(
  catalog: ProviderCatalog,
  live: Array<string | LiveModel>,
): ProviderCatalog {
  const known = new Set(catalog.models.map((m) => m.id));
  const families = [...new Set(catalog.models.map((m) => m.family))]
    .filter((f): f is string => Boolean(f))
    .sort((a, b) => b.length - a.length);
  const additions: ModelOption[] = [];
  for (const entry of live) {
    const model = typeof entry === "string" ? { id: entry } : entry;
    if (!model.id || known.has(model.id)) continue;
    known.add(model.id);
    const family = families.find((f) => model.id.includes(f));
    additions.push({
      id: model.id,
      label: liveLabel(catalog.provider, model),
      ...(family ? { family } : {}),
      source: "live",
    });
  }
  if (additions.length === 0) return catalog;
  const merged = { ...catalog, models: [...catalog.models, ...additions] };
  return catalog.provider === "anthropic" ? promoteNewestInFamily(merged) : merged;
}

/**
 * The UI label for a live model. Anthropic's display names repeat the brand
 * ("Claude Opus 5"); the baseline's labels don't ("Opus 4.8"), so a family
 * reads as one list.
 */
function liveLabel(provider: AgentProviderId, model: LiveModel): string {
  if (!model.displayName) return model.id;
  return provider === "anthropic"
    ? model.displayName.replace(/^Claude\s+/i, "") || model.displayName
    : model.displayName;
}

/**
 * An Anthropic model id's version: `claude-opus-5-5` → [5, 5],
 * `claude-sonnet-5` → [5], the older `claude-3-5-haiku-20241022` → [3, 5].
 * Date stamps are skipped. Null when the id carries no version.
 */
export function anthropicModelVersion(id: string): number[] | null {
  const parts = id
    .toLowerCase()
    .split("-")
    .filter((p) => /^\d{1,2}$/.test(p));
  return parts.length > 0 ? parts.map(Number) : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Point each family's `latest` flag, and the aliases that named the old
 * latest, at the family's highest version (previews never win), and sort
 * each family newest-first. A family whose baseline latest is already the
 * newest keeps it, so an equal-version live twin (an undated id next to its
 * dated one) doesn't churn the default.
 */
function promoteNewestInFamily(catalog: ProviderCatalog): ProviderCatalog {
  const newest = new Map<string, { id: string; version: number[] }>();
  for (const m of catalog.models) {
    const version = anthropicModelVersion(m.id);
    if (!m.family || !version || m.preview) continue;
    const best = newest.get(m.family);
    if (!best || compareVersions(version, best.version) > 0) {
      newest.set(m.family, { id: m.id, version });
    }
  }

  const promoted = new Map<string, string>(); // family → new latest id
  for (const [family, best] of newest) {
    const current = catalog.models.find((m) => m.family === family && m.latest);
    const currentVersion = current ? anthropicModelVersion(current.id) : null;
    if (current && currentVersion && compareVersions(currentVersion, best.version) >= 0) continue;
    promoted.set(family, best.id);
  }

  const models = catalog.models.map((m) => {
    const winner = m.family ? promoted.get(m.family) : undefined;
    if (!winner) return m;
    const latest = m.id === winner;
    if (Boolean(m.latest) === latest) return m;
    if (latest) return { ...m, latest: true };
    const demoted = { ...m };
    delete demoted.latest;
    return demoted;
  });

  const familyOf = new Map(catalog.models.map((m) => [m.id, m.family]));
  const aliases = Object.fromEntries(
    Object.entries(catalog.aliases).map(([alias, target]) => {
      const family = familyOf.get(target);
      return [alias, (family && promoted.get(family)) ?? target];
    }),
  );

  // Newest-first within a family; families keep their first-seen order.
  const firstSeen = new Map<string, number>();
  models.forEach((m, i) => {
    const key = m.family ?? m.id;
    if (!firstSeen.has(key)) firstSeen.set(key, i);
  });
  const sorted = models
    .map((m, i) => ({ m, i, v: anthropicModelVersion(m.id) }))
    .sort((a, b) => {
      const byFamily = firstSeen.get(a.m.family ?? a.m.id)! - firstSeen.get(b.m.family ?? b.m.id)!;
      if (byFamily !== 0) return byFamily;
      if (a.v && b.v) {
        const byVersion = compareVersions(b.v, a.v);
        if (byVersion !== 0) return byVersion;
      } else if (a.v || b.v) {
        return a.v ? -1 : 1;
      }
      return a.i - b.i;
    })
    .map(({ m }) => m);

  return { ...catalog, models: sorted, aliases };
}

/**
 * Merge Codex's own model catalog (what `codex debug models` lists on a
 * machine, reported by its Optio Local daemon) into the OpenAI catalog.
 * Codex's models lead, in Codex's order, with its labels, descriptions and
 * per-model reasoning efforts, and the first one — Codex's default — is the
 * latest. Baseline models Codex no longer lists follow, so a saved choice
 * keeps its label.
 */
export function mergeCodexModels(catalog: ProviderCatalog, codex: LiveModel[]): ProviderCatalog {
  const baseline = new Map(catalog.models.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const lead: ModelOption[] = [];
  for (const live of codex) {
    if (!live.id || seen.has(live.id)) continue;
    seen.add(live.id);
    const entry: ModelOption = {
      ...baseline.get(live.id),
      id: live.id,
      label: live.displayName || baseline.get(live.id)?.label || live.id,
      source: "live",
    };
    delete entry.latest;
    if (live.description) entry.description = live.description;
    if (live.efforts?.length) entry.efforts = [...live.efforts];
    if (live.defaultEffort) entry.defaultEffort = live.defaultEffort;
    lead.push(entry);
  }
  if (lead.length === 0) return catalog;
  lead[0] = { ...lead[0], latest: true };
  const rest = catalog.models
    .filter((m) => !seen.has(m.id))
    .map((m) => {
      if (!m.latest) return m;
      const demoted = { ...m };
      delete demoted.latest;
      return demoted;
    });
  return { ...catalog, models: [...lead, ...rest] };
}

/**
 * Whether an option field applies to a run in an Optio pod or on the user's
 * machine (see `OptionField.runsOn`; unmarked fields are pod-only).
 */
export function optionRunsOn(field: OptionField, where: "pod" | "local"): boolean {
  return (field.runsOn ?? ["pod"]).includes(where);
}

/**
 * What a run on a machine passes to its agent CLI, from per-run agent
 * options keyed like the provider catalog: the model, and every field with a
 * `localParam` (effort, Claude Code's permission mode). Blank values are
 * left out, so the machine's own defaults apply.
 */
export function localAgentParams(
  agentType: string,
  agentOptions: Record<string, unknown> | null | undefined,
): { model?: string; effort?: string; permissionMode?: LocalAgentPermissionMode } {
  const out: { model?: string; effort?: string; permissionMode?: LocalAgentPermissionMode } = {};
  const catalog = agentOptions ? getProviderCatalog(providerForAgentType(agentType)) : undefined;
  if (!agentOptions || !catalog) return out;
  const str = (key: string): string | undefined => {
    const v = agentOptions[key];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const model = str(catalog.modelField);
  if (model) out.model = model;
  for (const field of catalog.options) {
    const value = field.localParam ? str(field.key) : undefined;
    if (!value) continue;
    if (field.localParam === "effort") out.effort = value;
    else if ((LOCAL_AGENT_PERMISSION_MODES as readonly string[]).includes(value)) {
      out.permissionMode = value as LocalAgentPermissionMode;
    }
  }
  return out;
}

/**
 * The choices a select field offers with `model` selected. A `modelEfforts`
 * field narrows to the model's own efforts, in its order (one the field
 * doesn't know by name is labelled by its value); any other field, or a
 * model that lists no efforts, gets the field's static choices.
 */
export function optionChoicesFor(
  field: OptionField,
  model: ModelOption | undefined,
): OptionChoice[] {
  const choices = field.choices ?? [];
  if (!field.modelEfforts || !model?.efforts?.length) return choices;
  return model.efforts.map(
    (effort) =>
      choices.find((c) => c.value === effort) ?? {
        value: effort,
        label: effort.charAt(0).toUpperCase() + effort.slice(1),
      },
  );
}

/**
 * Group a catalog's models by family. Used by the UI to render grouped
 * dropdowns (with the latest-of-family marker).
 */
export function groupModelsByFamily(
  catalog: ProviderCatalog,
): Array<{ family: string; models: ModelOption[] }> {
  const groups = new Map<string, ModelOption[]>();
  for (const model of catalog.models) {
    const family = model.family ?? model.id;
    const list = groups.get(family);
    if (list) {
      list.push(model);
    } else {
      groups.set(family, [model]);
    }
  }
  return Array.from(groups.entries()).map(([family, models]) => ({ family, models }));
}

/** Return the catalog for a provider, or `undefined` for unknown providers. */
export function getProviderCatalog(provider: string): ProviderCatalog | undefined {
  return PROVIDER_CATALOGS[provider as AgentProviderId];
}
