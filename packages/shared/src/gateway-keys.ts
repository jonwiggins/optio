/**
 * Gateway keys made by Optio (docs/model-gateway.md "Keys Optio makes"): how
 * people and teams get a token for a model gateway, per gateway.
 *
 * - `personalPasted`: people and team admins paste a key they got from the
 *   gateway themselves (Settings → My tokens, Teams → a team → Tokens).
 * - `optioIssued`: Optio makes the key on the gateway with the gateway's
 *   admin key (LiteLLM, OpenRouter, Portkey: the types whose `managedKeys`
 *   capability is on; model-gateways.ts), with a budget, an expiry and, where
 *   the gateway can, the catalog's models, and rotates and revokes it.
 *
 * An admin chooses per gateway; at least one is on. When both are, a person
 * may paste their own or press "Get my token".
 */

export interface GatewayKeyModes {
  personalPasted: boolean;
  optioIssued: boolean;
}

/** A gateway saved before key modes existed: pasting only, as before. */
export const DEFAULT_GATEWAY_KEY_MODES: Readonly<GatewayKeyModes> = {
  personalPasted: true,
  optioIssued: false,
};

/** What a key Optio makes gets, unless an admin says otherwise. */
export interface GatewayKeyDefaults {
  /** USD a person's key may spend per budget period; null = no cap. */
  maxBudget: number | null;
  /**
   * When the spend resets, as a duration ("30d", "1mo"); null = never. A
   * gateway that takes only some periods gets the nearest it takes
   * (`gatewayBudgetPeriodFor`).
   */
  budgetDuration: string | null;
  /**
   * The models a key may call; empty = every model in the gateway's catalog.
   * Only where the gateway limits a key's models (`keyModels`).
   */
  models: string[];
  /** How long a key lives ("90d"); null = until rotated or revoked. */
  keyDuration: string | null;
  /** A new team key's budget, and the most a team admin may set; null = no cap. */
  teamMaxBudget: number | null;
  /** When a team's spend resets; null = never. */
  teamBudgetDuration: string | null;
  /** Portkey: the workspace keys are made in (absent = the admin key's own). */
  workspace?: string | null;
}

export const DEFAULT_GATEWAY_KEY_DEFAULTS: Readonly<GatewayKeyDefaults> = {
  maxBudget: null,
  budgetDuration: "30d",
  models: [],
  keyDuration: null,
  teamMaxBudget: null,
  teamBudgetDuration: "30d",
};

/** The share of a budget at which Optio warns, and at which it says the budget is spent. */
export const GATEWAY_BUDGET_WARN_AT = 0.8;
export const GATEWAY_BUDGET_EXCEEDED_AT = 1;

const DURATION = /^[1-9]\d{0,3}(s|m|h|d|w|mo)$/;

/** A duration as LiteLLM writes it: a number and s, m, h, d, w or mo ("30d", "1mo", "12h"). */
export function isValidGatewayDuration(value: string): boolean {
  return DURATION.test(value.trim());
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** The modes a stored `key_modes` value means (null / garbage = pasting only). */
export function gatewayKeyModesOf(raw: unknown): GatewayKeyModes {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const modes = {
    personalPasted: bool(r.personalPasted, DEFAULT_GATEWAY_KEY_MODES.personalPasted),
    optioIssued: bool(r.optioIssued, DEFAULT_GATEWAY_KEY_MODES.optioIssued),
  };
  // Never both off: a stored value that says so means the old behaviour.
  return modes.personalPasted || modes.optioIssued ? modes : { ...DEFAULT_GATEWAY_KEY_MODES };
}

function amount(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function duration(v: unknown, fallback: string | null): string | null {
  if (v === null) return null;
  return typeof v === "string" && isValidGatewayDuration(v) ? v.trim() : fallback;
}

/** The defaults a stored `key_defaults` value means, filled in where it says nothing. */
export function gatewayKeyDefaultsOf(raw: unknown): GatewayKeyDefaults {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_GATEWAY_KEY_DEFAULTS;
  return {
    maxBudget: "maxBudget" in r ? amount(r.maxBudget) : d.maxBudget,
    budgetDuration: "budgetDuration" in r ? duration(r.budgetDuration, null) : d.budgetDuration,
    models: Array.isArray(r.models)
      ? [...new Set(r.models.filter((m): m is string => typeof m === "string" && !!m.trim()))]
      : [],
    keyDuration: "keyDuration" in r ? duration(r.keyDuration, null) : d.keyDuration,
    teamMaxBudget: "teamMaxBudget" in r ? amount(r.teamMaxBudget) : d.teamMaxBudget,
    teamBudgetDuration:
      "teamBudgetDuration" in r ? duration(r.teamBudgetDuration, null) : d.teamBudgetDuration,
    ...(typeof r.workspace === "string" && r.workspace.trim()
      ? { workspace: r.workspace.trim() }
      : {}),
  };
}

/**
 * The part of a key alias that names a person or a team: lower case,
 * letters, digits, dots, dashes and underscores, at most 40 characters
 * ("Bob Smith <bob.smith@corp>" → "bob.smith").
 */
export function gatewayKeyAliasPart(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 40)
    .replace(/[-._]+$/g, "");
  return cleaned || "user";
}

/** `optio-<user>`: the alias of a person's key, from their email's local part (else their name). */
export function personalGatewayKeyAlias(person: { email?: string | null; name?: string | null }) {
  const local = person.email?.split("@")[0]?.trim();
  return `optio-${gatewayKeyAliasPart(local || person.name || "user")}`;
}

/** `optio-team-<team>`: the alias of a team's key. */
export function teamGatewayKeyAlias(teamName: string): string {
  return `optio-team-${gatewayKeyAliasPart(teamName)}`;
}
