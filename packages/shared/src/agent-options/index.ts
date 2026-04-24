import { ANTHROPIC_CATALOG } from "./anthropic.js";
import { OPENAI_CATALOG } from "./openai.js";
import { GEMINI_CATALOG } from "./gemini.js";
import { COPILOT_CATALOG } from "./copilot.js";
import { OPENCODE_CATALOG } from "./opencode.js";
import { OPENCLAW_CATALOG } from "./openclaw.js";
import type { AgentProviderId, ModelOption, ProviderCatalog } from "./types.js";

export type {
  AgentProviderId,
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

/** All providers, keyed by id. */
export const PROVIDER_CATALOGS: Record<AgentProviderId, ProviderCatalog> = {
  anthropic: ANTHROPIC_CATALOG,
  openai: OPENAI_CATALOG,
  gemini: GEMINI_CATALOG,
  copilot: COPILOT_CATALOG,
  opencode: OPENCODE_CATALOG,
  openclaw: OPENCLAW_CATALOG,
};

export const ALL_PROVIDER_IDS: readonly AgentProviderId[] = [
  "anthropic",
  "openai",
  "gemini",
  "copilot",
  "opencode",
  "openclaw",
];

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
 * Merge a list of live model ids (from a provider's list-models API) into the
 * hardcoded baseline. Live ids not present in the baseline are appended;
 * existing entries are preserved so we don't lose labels/family metadata.
 */
export function mergeLiveModels(catalog: ProviderCatalog, liveIds: string[]): ProviderCatalog {
  const known = new Set(catalog.models.map((m) => m.id));
  const additions: ModelOption[] = [];
  for (const id of liveIds) {
    if (!id || known.has(id)) continue;
    known.add(id);
    additions.push({ id, label: id, source: "live" });
  }
  if (additions.length === 0) return catalog;
  return {
    ...catalog,
    models: [...catalog.models, ...additions],
  };
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
