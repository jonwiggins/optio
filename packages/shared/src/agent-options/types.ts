/**
 * Shared types for per-provider agent options (models + runtime params).
 *
 * One `ProviderCatalog` per provider describes the full picker UI:
 *   - `models` — selectable model IDs grouped by family, with the "latest"
 *     of each family flagged (used by alias resolution and by the UI to pick
 *     sensible defaults).
 *   - `aliases` — short tokens (e.g. "opus", "sonnet") that resolve to the
 *     latest dated id of a family at request time. Old DB rows continue to
 *     work even after new dated models ship.
 *   - `options` — other runtime enums (context window, thinking, effort,
 *     approval mode, agent preset, etc.).
 *   - `freeText` — fields that take arbitrary user input (e.g. OpenCode
 *     model strings like `anthropic/claude-sonnet-4`, OpenCode base URL).
 *
 * The shape is stable across providers so the frontend can render any
 * provider with a single `<AgentOptionsPicker>` component.
 */

export type AgentProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "copilot"
  | "opencode"
  | "openclaw";

export interface ModelOption {
  /** The canonical model id passed to the provider (e.g. "claude-opus-4-7"). */
  id: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Family this model belongs to — aliases resolve to latest-of-family. */
  family?: string;
  /** True if this is the latest (preferred) model in its family. */
  latest?: boolean;
  /** True if this model is currently in preview. */
  preview?: boolean;
  /** Where this option came from — hardcoded baseline or live API probe. */
  source?: "baseline" | "live";
}

export interface OptionChoice {
  value: string;
  label: string;
  description?: string;
}

export interface OptionField {
  /** Field key matching the DB column/form field (e.g. "claudeEffort"). */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Control type. `select` = dropdown, `boolean` = checkbox, `text` = input. */
  kind: "select" | "boolean" | "text";
  /** Select choices (only for `kind: "select"`). */
  choices?: OptionChoice[];
  /** Default value applied when no repo override is set. */
  default?: string | boolean;
  /** Free-text placeholder. */
  placeholder?: string;
  /** Supplementary help text shown beneath the control. */
  helpText?: string;
}

export interface ProviderCatalog {
  provider: AgentProviderId;
  /** Human-readable name — "Claude Code", "OpenAI Codex", etc. */
  label: string;
  /**
   * DB column name that stores the selected model id. The `AgentOptionsPicker`
   * reads/writes this field on the repo record.
   */
  modelField: string;
  /** True if this provider's model field takes a free-text string instead of a select. */
  modelIsFreeText?: boolean;
  /** Placeholder for the free-text model field. */
  modelPlaceholder?: string;
  /** Help text rendered under the model field. */
  modelHelpText?: string;
  /** Alphabetical-ish display name for the model label in UI. */
  models: ModelOption[];
  /** Short aliases like `opus` → `claude-opus-4-7`. */
  aliases: Record<string, string>;
  /** Additional option fields (context window, effort, etc.). */
  options: OptionField[];
  /**
   * True if the provider has a public list-models API the backend can call
   * to augment the hardcoded baseline. Copilot/OpenCode/OpenClaw are false.
   */
  liveRefreshSupported: boolean;
}
