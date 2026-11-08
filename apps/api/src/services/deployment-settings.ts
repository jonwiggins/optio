import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { deploymentSettings } from "../db/schema.js";

/**
 * Deployment-wide settings a deployment admin changes in the app (Settings →
 * Access), over the deployment's own default from the environment (the
 * chart's values). One row per key in `deployment_settings`; a key with no
 * row follows the environment. Read from the table every time (no cache):
 * the API may run several replicas, and a change must hold on all of them
 * at once; nothing reads these on a hot path.
 *
 * Keys today:
 *
 * | Key                   | Values                   | Environment default                                                   |
 * | --------------------- | ------------------------ | --------------------------------------------------------------------- |
 * | `workspaces.creation` | `"admins"`, `"everyone"` | `OPTIO_WORKSPACE_CREATION` (chart `workspaces.creation`), `everyone`  |
 * | `onboarding.enabled`  | `true`, `false`          | `OPTIO_ONBOARDING` (chart `onboarding.enabled`), `false`              |
 *
 * Sign-in session and CLI key lifetimes are limits (services/credential-lifetimes.ts).
 *
 * Other deployment-wide settings live here too:
 * `getDeploymentSetting(key)` / `setDeploymentSetting(key, value, userId)`,
 * an on / off behaviour is a `DeploymentSwitch` (`switchPolicy`,
 * `switchEnabled`), and a whole-number limit a `DeploymentLimit` (`limitPolicy`,
 * `limitValue`).
 */

/** The stored value of `key`, or undefined when it has none (follow the environment). */
export async function getDeploymentSetting<T = unknown>(key: string): Promise<T | undefined> {
  const [row] = await db
    .select({ value: deploymentSettings.value })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.key, key));
  return row ? (row.value as T) : undefined;
}

/**
 * `getDeploymentSetting`, but a read that fails (no database reachable) is
 * "nothing stored": the environment's default applies.
 */
async function storedOrUndefined(key: string): Promise<unknown> {
  try {
    return await getDeploymentSetting(key);
  } catch {
    return undefined;
  }
}

/** Store `value` for `key` (null: remove it, so the environment's default applies). */
export async function setDeploymentSetting(
  key: string,
  value: unknown,
  updatedBy: string | null,
): Promise<void> {
  if (value === null || value === undefined) {
    await db.delete(deploymentSettings).where(eq(deploymentSettings.key, key));
  } else {
    await db
      .insert(deploymentSettings)
      .values({ key, value, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: deploymentSettings.key,
        set: { value, updatedBy, updatedAt: new Date() },
      });
  }
  switchCache.delete(key);
}

/** Where a setting's value comes from: saved in the app, or the deployment's environment. */
type SettingSource = "app" | "environment";

// ── workspaces.creation ─────────────────────────────────────────────────────

export const WORKSPACE_CREATION_KEY = "workspaces.creation";
type WorkspaceCreation = "admins" | "everyone";

function isWorkspaceCreation(v: unknown): v is WorkspaceCreation {
  return v === "admins" || v === "everyone";
}

/** The environment's answer: `admins` only when it says so, else `everyone`. */
function envWorkspaceCreation(env: NodeJS.ProcessEnv = process.env): WorkspaceCreation {
  return env.OPTIO_WORKSPACE_CREATION?.trim().toLowerCase() === "admins" ? "admins" : "everyone";
}

export interface WorkspaceCreationPolicy {
  /** Who may create a workspace now. */
  value: WorkspaceCreation;
  source: SettingSource;
  /** The environment's default (what "follow the deployment" means). */
  environment: WorkspaceCreation;
}

export async function workspaceCreationPolicy(): Promise<WorkspaceCreationPolicy> {
  const environment = envWorkspaceCreation();
  // An unreadable saved policy must not grant creation via a permissive default.
  const stored = await getDeploymentSetting(WORKSPACE_CREATION_KEY);
  return isWorkspaceCreation(stored)
    ? { value: stored, source: "app", environment }
    : { value: environment, source: "environment", environment };
}

// ── On / off switches ───────────────────────────────────────────────────────
//
// Behaviours a deployment admin turns on in the app (Settings → Access), over
// the deployment's own default from the environment; off unless one of them
// says so. A switch is read on many requests, so `switchEnabled` remembers
// the answer for a few seconds (`SWITCH_CACHE_MS`): another replica sees a
// change within that. A feature declares its switch once and passes it to
// these helpers:
//
//   export const MY_SWITCH: DeploymentSwitch = { key: "my.feature", env: "OPTIO_MY_FEATURE" };
//   export const myFeatureOn = () => switchEnabled(MY_SWITCH);

/** An on / off deployment setting: its key in the table and the env var that gives its default. */
export interface DeploymentSwitch {
  readonly key: string;
  readonly env: string;
}

export interface SwitchPolicy {
  /** On now. */
  value: boolean;
  source: SettingSource;
  /** The environment's default (what "follow the deployment" means). */
  environment: boolean;
}

/** The environment's answer for a switch: on only when it says true. */
export function envSwitch(sw: DeploymentSwitch, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[sw.env] ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(raw);
}

/** The switch's value, where it comes from and the environment's default (the settings page). */
export async function switchPolicy(sw: DeploymentSwitch): Promise<SwitchPolicy> {
  const environment = envSwitch(sw);
  const stored = await storedOrUndefined(sw.key);
  return typeof stored === "boolean"
    ? { value: stored, source: "app", environment }
    : { value: environment, source: "environment", environment };
}

const SWITCH_CACHE_MS = 5_000;
/** The saved value of each switch (undefined: none saved), remembered briefly. */
const switchCache = new Map<string, { stored: unknown; until: number }>();

/** The saved value of `key`, remembered for `SWITCH_CACHE_MS` (the hot path). */
async function storedRemembered(key: string): Promise<unknown> {
  const now = Date.now();
  let hit = switchCache.get(key);
  if (!hit || hit.until <= now) {
    hit = { stored: await storedOrUndefined(key), until: now + SWITCH_CACHE_MS };
    switchCache.set(key, hit);
  }
  return hit.stored;
}

// ── Limits ──────────────────────────────────────────────────────────────────
//
// A whole number a deployment admin may set (Settings → Access), over the
// environment's default; no limit unless one of them sets one. 0 is "no
// limit": saved in the app it overrides a limit from the environment. A value
// outside `min`..`max` (or not a whole number) counts as unset.

/** A numeric deployment setting: its key, the env var giving its default, and its bounds. */
export interface DeploymentLimit {
  readonly key: string;
  readonly env: string;
  readonly min: number;
  readonly max: number;
}

export interface LimitPolicy {
  /** The limit now; null: none. */
  value: number | null;
  source: SettingSource;
  /** The environment's default (what "follow the deployment" means); null: none. */
  environment: number | null;
}

/** A limit's value as stored or set: a whole number in bounds, or 0 for none. */
export function isLimitValue(limit: DeploymentLimit, v: unknown): v is number {
  return (
    typeof v === "number" && Number.isInteger(v) && (v === 0 || (v >= limit.min && v <= limit.max))
  );
}

/** The environment's answer for a limit; null when unset, 0 or invalid. */
function envLimit(limit: DeploymentLimit, env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env[limit.env] ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return isLimitValue(limit, n) && n > 0 ? n : null;
}

function limitFrom(limit: DeploymentLimit, stored: unknown): LimitPolicy {
  const environment = envLimit(limit);
  return isLimitValue(limit, stored)
    ? { value: stored === 0 ? null : stored, source: "app", environment }
    : { value: environment, source: "environment", environment };
}

/** The limit, where it comes from and the environment's default (the settings page). */
export async function limitPolicy(limit: DeploymentLimit): Promise<LimitPolicy> {
  return limitFrom(limit, await storedOrUndefined(limit.key));
}

/** The limit now (null: none), remembered for `SWITCH_CACHE_MS` (the hot path). */
export async function limitValue(limit: DeploymentLimit): Promise<number | null> {
  return limitFrom(limit, await storedRemembered(limit.key)).value;
}

/** Forget every remembered switch (tests). */
export function forgetSwitches(): void {
  switchCache.clear();
}

// ── onboarding.enabled ──────────────────────────────────────────────────────

/**
 * The getting-started checklist on the Overview and Help → Using Optio in
 * the account menu (docs/using-optio.md). Web only: nothing on the server
 * changes with it. Off by default.
 */
export const ONBOARDING: DeploymentSwitch = {
  key: "onboarding.enabled",
  env: "OPTIO_ONBOARDING",
};
