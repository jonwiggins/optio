/**
 * What this deployment of Optio offers (docs/feature-lists.md).
 *
 * Five lists — agent runtimes, git platforms, trigger types, ticket sources
 * and built-in connection providers. Every list is unset by default, and
 * unset means everything, so a deployment that sets nothing offers every
 * runtime, platform, trigger, source and connection, as before. An admin
 * narrows a list with a comma-separated env var (the chart's `features`
 * values render them):
 *
 *   OPTIO_RUNTIMES=claude-code,opencode
 *   OPTIO_GIT_PLATFORMS=gitlab
 *   OPTIO_TRIGGERS=manual,schedule,webhook,ticket,gitlab,jira
 *   OPTIO_TICKET_SOURCES=gitlab,jira
 *   OPTIO_CONNECTION_PROVIDERS=postgres,filesystem,custom-http,custom-mcp
 *
 * Values are matched trimmed and case-insensitively; a value Optio doesn't
 * know is ignored (`featureEnvWarnings` says which, once, at boot). One
 * check, `featureAllows`, gates the pickers, the routes and the trigger
 * receivers; `featureFilter` narrows a list. The web reads the same answer
 * from `GET /api/features` and, at first paint, `window.__OPTIO_CONFIG.features`.
 */

import type { AgentType } from "../agent-options/index.js";
import type { GitPlatformType } from "../types/git-platform.js";
import type { TriggerType } from "../types/triggers.js";

export const ALL_RUNTIMES = [
  "claude-code",
  "codex",
  "copilot",
  "opencode",
  "gemini",
  "openclaw",
  "cursor",
  "pi",
] as const satisfies readonly AgentType[];

export const ALL_GIT_PLATFORMS = [
  "github",
  "gitlab",
  "codecommit",
] as const satisfies readonly GitPlatformType[];

export const ALL_TRIGGERS = [
  "manual",
  "schedule",
  "webhook",
  "ticket",
  "github",
  "gitlab",
  "slack",
  "linear",
  "jira",
  "pylon",
  "pagerduty",
  "sentry",
  "alertmanager",
  "datadog",
] as const satisfies readonly TriggerType[];

export const ALL_TICKET_SOURCES = ["github", "gitlab", "jira", "linear", "notion"] as const;

/** The built-in connection providers' slugs, as the Connections catalog names them. */
export const ALL_CONNECTION_PROVIDERS = [
  "notion",
  "github",
  "gitlab",
  "slack",
  "linear",
  "postgres",
  "sentry",
  "filesystem",
  "aws",
  "pylon",
  "pagerduty",
  "custom-http",
  "custom-mcp",
] as const;

/** The features that are lists of values (`featureAllows` / `featureFilter`). */
export type FeatureList =
  "runtimes" | "gitPlatforms" | "triggers" | "ticketSources" | "connectionProviders";

export const FEATURE_LISTS: readonly FeatureList[] = [
  "runtimes",
  "gitPlatforms",
  "triggers",
  "ticketSources",
  "connectionProviders",
];

/** Every value each list knows: what an unset list offers. */
export const ALL_FEATURES: Readonly<Record<FeatureList, readonly string[]>> = {
  runtimes: ALL_RUNTIMES,
  gitPlatforms: ALL_GIT_PLATFORMS,
  triggers: ALL_TRIGGERS,
  ticketSources: ALL_TICKET_SOURCES,
  connectionProviders: ALL_CONNECTION_PROVIDERS,
};

/** The env var that narrows each list. */
export const FEATURE_ENV: Readonly<Record<FeatureList, string>> = {
  runtimes: "OPTIO_RUNTIMES",
  gitPlatforms: "OPTIO_GIT_PLATFORMS",
  triggers: "OPTIO_TRIGGERS",
  ticketSources: "OPTIO_TICKET_SOURCES",
  connectionProviders: "OPTIO_CONNECTION_PROVIDERS",
};

/** Every env var `featuresFromEnv` reads. */
export const FEATURE_SETTINGS: readonly string[] = [
  ...FEATURE_LISTS.map((feature) => FEATURE_ENV[feature]),
  "OPTIO_MODEL_ACCESS",
];

export type ModelAccess = "any" | "gateway";
export const MODEL_ACCESS_VALUES: readonly ModelAccess[] = ["any", "gateway"];

export interface DeploymentFeatures {
  /** `OPTIO_MODEL_ACCESS`: `any` (the default) or `gateway`. */
  modelAccess: ModelAccess;
  /** Agent runtimes offered (`AgentType`s). */
  runtimes: string[];
  /** Git platforms repos may be on (`GitPlatformType`s). */
  gitPlatforms: string[];
  /** Trigger types work may have (`TriggerType`s). */
  triggers: string[];
  /** Ticket sources (`TicketSource`s). */
  ticketSources: string[];
  /** Built-in connection provider slugs offered in the Connections catalog. */
  connectionProviders: string[];
}

type Env = Record<string, string | undefined>;

function processEnv(): Env {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

function tokens(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * One list from `env`: the values it names that Optio knows, in the full
 * list's order; else everything.
 */
function listFromEnv(feature: FeatureList, env: Env): string[] {
  const all = ALL_FEATURES[feature];
  const named = new Set(tokens(env[FEATURE_ENV[feature]]));
  const known = all.filter((v) => named.has(v));
  return known.length > 0 ? known : [...all];
}

/** Whether `env` sets any feature setting (none: everything, as before). */
export function featureSettingsGiven(env: Env = processEnv()): boolean {
  return FEATURE_SETTINGS.some((name) => Boolean(env[name]?.trim()));
}

/** The features `env` describes (unset = everything). */
export function featuresFromEnv(env: Env = processEnv()): DeploymentFeatures {
  return {
    runtimes: listFromEnv("runtimes", env),
    gitPlatforms: listFromEnv("gitPlatforms", env),
    triggers: listFromEnv("triggers", env),
    ticketSources: listFromEnv("ticketSources", env),
    connectionProviders: listFromEnv("connectionProviders", env),
    modelAccess: env.OPTIO_MODEL_ACCESS?.trim().toLowerCase() === "gateway" ? "gateway" : "any",
  };
}

/**
 * What in `env` Optio ignores, one line each: values a list doesn't know,
 * or a list that names nothing it knows. The API logs them once at boot.
 */
export function featureEnvWarnings(env: Env = processEnv()): string[] {
  const out: string[] = [];
  for (const feature of FEATURE_LISTS) {
    const name = FEATURE_ENV[feature];
    const named = tokens(env[name]);
    if (named.length === 0) continue;
    const all = ALL_FEATURES[feature];
    const unknown = named.filter((v) => !all.includes(v));
    if (unknown.length === 0) continue;
    out.push(
      unknown.length === named.length
        ? `${name} names nothing Optio knows (${unknown.join(", ")}); it is ignored. Known: ${all.join(", ")}`
        : `${name}: ignoring ${unknown.join(", ")}. Known: ${all.join(", ")}`,
    );
  }
  const access = env.OPTIO_MODEL_ACCESS?.trim().toLowerCase();
  if (access && !(MODEL_ACCESS_VALUES as readonly string[]).includes(access)) {
    out.push(`OPTIO_MODEL_ACCESS=${env.OPTIO_MODEL_ACCESS} is not any or gateway; using any`);
  }
  return out;
}

/**
 * `raw` (an API answer, or what the web layout injected) as features: a
 * list that is missing or names nothing known is everything, as unset.
 */
export function normalizeFeatures(raw: unknown): DeploymentFeatures {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (feature: FeatureList): string[] => {
    const all = ALL_FEATURES[feature];
    const given = Array.isArray(r[feature])
      ? (r[feature] as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const known = all.filter((v) => given.includes(v));
    return known.length > 0 ? known : [...all];
  };
  return {
    runtimes: list("runtimes"),
    gitPlatforms: list("gitPlatforms"),
    triggers: list("triggers"),
    ticketSources: list("ticketSources"),
    connectionProviders: list("connectionProviders"),
    modelAccess: r.modelAccess === "gateway" ? "gateway" : "any",
  };
}

/**
 * The features this process runs with: the server's env, or in a browser
 * what the web layout injected (`window.__OPTIO_CONFIG.features`).
 */
export function currentFeatures(): DeploymentFeatures {
  // `window` without the DOM types: this package compiles for Node too.
  const browser = (globalThis as { window?: { __OPTIO_CONFIG?: { features?: unknown } } }).window;
  if (browser) return normalizeFeatures(browser.__OPTIO_CONFIG?.features);
  return featuresFromEnv();
}

/** Whether `features` offers `value` in `feature` (a value Optio doesn't know is refused). */
export function featureAllows(
  feature: FeatureList,
  value: string,
  features: DeploymentFeatures = currentFeatures(),
): boolean {
  return features[feature].includes(value);
}

/** `list` narrowed to what `features` offers, in `list`'s order. */
export function featureFilter<T extends string>(
  feature: FeatureList,
  list: readonly T[],
  features: DeploymentFeatures = currentFeatures(),
): T[] {
  return list.filter((v) => featureAllows(feature, v, features));
}

/** Whether `feature` offers less than everything Optio knows (an admin narrowed it). */
export function featureNarrowed(
  feature: FeatureList,
  features: DeploymentFeatures = currentFeatures(),
): boolean {
  return ALL_FEATURES[feature].some((v) => !features[feature].includes(v));
}
