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
  | "openclaw"
  | "cursor";

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
  /** One-line description, when the source gives one (Codex's model catalog does). */
  description?: string;
  /**
   * The reasoning efforts this model accepts, in order, for providers that
   * scope effort per model (Codex). An effort field with `modelEfforts`
   * offers only these while this model is selected.
   */
  efforts?: string[];
  /** The effort the CLI uses for this model when none is set. */
  defaultEffort?: string;
}

/**
 * A model entry returned by a provider's list-models API. `displayName` is
 * the provider's human-readable label (e.g. Anthropic's `display_name`).
 * Codex's own catalog (read by the Optio Local daemon) also carries a
 * description and the model's reasoning efforts.
 */
export interface LiveModel {
  id: string;
  displayName?: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
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
  /**
   * Where the field applies: `pod` (a run in an Optio pod) and/or `local`
   * (a run on the user's machine, where the Optio Local daemon passes it to
   * the agent CLI). Default `["pod"]` — most fields only reach pod runs.
   */
  runsOn?: Array<"pod" | "local">;
  /**
   * For fields that reach a run on a machine: the agent spec field the value
   * becomes there (`LocalTerminalSpec`'s `effort` / `permissionMode`).
   */
  localParam?: "effort" | "permissionMode";
  /**
   * An effort field whose choices depend on the model: while a model with
   * `efforts` is selected, only those are offered (see `ModelOption.efforts`).
   */
  modelEfforts?: boolean;
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
