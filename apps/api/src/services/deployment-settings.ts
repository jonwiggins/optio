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
 *
 * Other deployment-wide settings live here too:
 * `getDeploymentSetting(key)` / `setDeploymentSetting(key, value, userId)`,
 * and an on / off behaviour is a `DeploymentSwitch` (`switchPolicy`,
 * `switchEnabled`).
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
export type SettingSource = "app" | "environment";

// ── workspaces.creation ─────────────────────────────────────────────────────

export const WORKSPACE_CREATION_KEY = "workspaces.creation";
export type WorkspaceCreation = "admins" | "everyone";

export function isWorkspaceCreation(v: unknown): v is WorkspaceCreation {
  return v === "admins" || v === "everyone";
}

/** The environment's answer: `admins` only when it says so, else `everyone`. */
export function envWorkspaceCreation(env: NodeJS.ProcessEnv = process.env): WorkspaceCreation {
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

/** Whether the switch is on now, remembered for `SWITCH_CACHE_MS` (the hot path). */
export async function switchEnabled(sw: DeploymentSwitch): Promise<boolean> {
  const now = Date.now();
  let hit = switchCache.get(sw.key);
  if (!hit || hit.until <= now) {
    hit = { stored: await storedOrUndefined(sw.key), until: now + SWITCH_CACHE_MS };
    switchCache.set(sw.key, hit);
  }
  return typeof hit.stored === "boolean" ? hit.stored : envSwitch(sw);
}

/** Forget every remembered switch (tests). */
export function forgetSwitches(): void {
  switchCache.clear();
}
