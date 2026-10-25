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
 * | Key                  | Values                  | Environment default                                   |
 * | -------------------- | ----------------------- | ----------------------------------------------------- |
 * | `workspaces.creation`| `"admins"`, `"everyone"`| `OPTIO_WORKSPACE_CREATION` (chart `workspaces.creation`), `everyone` |
 *
 * Other deployment-wide settings live here too:
 * `getDeploymentSetting(key)` / `setDeploymentSetting(key, value, userId)`.
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

// ── workspaces.creation ─────────────────────────────────────────────────────

export const WORKSPACE_CREATION_KEY = "workspaces.creation";
export type WorkspaceCreation = "admins" | "everyone";

export function isWorkspaceCreation(v: unknown): v is WorkspaceCreation {
  return v === "admins" || v === "everyone";
}

/** The environment's answer: `admins` only when it says so, else `everyone`. */
export function envWorkspaceCreation(): WorkspaceCreation {
  return process.env.OPTIO_WORKSPACE_CREATION?.trim().toLowerCase() === "admins"
    ? "admins"
    : "everyone";
}

export interface WorkspaceCreationPolicy {
  /** Who may create a workspace now. */
  value: WorkspaceCreation;
  /** Where it comes from: saved in the app, or the deployment's environment. */
  source: "app" | "environment";
  /** The environment's default (what "follow the deployment" means). */
  environment: WorkspaceCreation;
}

export async function workspaceCreationPolicy(): Promise<WorkspaceCreationPolicy> {
  const environment = envWorkspaceCreation();
  const stored = await storedOrUndefined(WORKSPACE_CREATION_KEY);
  return isWorkspaceCreation(stored)
    ? { value: stored, source: "app", environment }
    : { value: environment, source: "environment", environment };
}

// ── On / off switches ───────────────────────────────────────────────────────
//
// Behaviours a deployment admin turns on in the app (Settings → Access), over
// the deployment's own default from the environment; off unless one of them
// says so. Each is read on many requests, so the answer is remembered for a
// few seconds (`SWITCH_CACHE_MS`): another replica sees a change within that.

/** Teams (docs/teams.md): a third scope next to the organization and one person. */
export const TEAMS_KEY = "teams.enabled";
/** Automatic merging needs the checkbox AND the confirmation dialog (docs/tasks.md). */
export const MERGE_CONFIRMATION_KEY = "merge.confirmation";
/**
 * The getting-started guide (docs/using-optio.md): the Overview's checklist
 * and Help → Using Optio in the account menu. Read by the web app only.
 */
export const ONBOARDING_KEY = "onboarding.enabled";

const SWITCH_ENV: Record<string, string> = {
  [TEAMS_KEY]: "OPTIO_TEAMS_ENABLED",
  [MERGE_CONFIRMATION_KEY]: "OPTIO_MERGE_CONFIRMATION",
  [ONBOARDING_KEY]: "OPTIO_ONBOARDING",
};

export interface SwitchPolicy {
  /** On now. */
  value: boolean;
  /** Where it comes from: saved in the app, or the deployment's environment. */
  source: "app" | "environment";
  /** The environment's default (what "follow the deployment" means). */
  environment: boolean;
}

/** The environment's answer for a switch: on only when it says true. */
export function envSwitch(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[SWITCH_ENV[key] ?? ""] ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(raw);
}

export async function switchPolicy(key: string): Promise<SwitchPolicy> {
  const environment = envSwitch(key);
  const stored = await storedOrUndefined(key);
  return typeof stored === "boolean"
    ? { value: stored, source: "app", environment }
    : { value: environment, source: "environment", environment };
}

const SWITCH_CACHE_MS = 5_000;
/** The saved value of each switch (undefined: none saved), remembered briefly. */
const switchCache = new Map<string, { stored: unknown; until: number }>();

async function cachedSwitch(key: string): Promise<boolean> {
  const now = Date.now();
  let hit = switchCache.get(key);
  if (!hit || hit.until <= now) {
    hit = { stored: await storedOrUndefined(key), until: now + SWITCH_CACHE_MS };
    switchCache.set(key, hit);
  }
  return typeof hit.stored === "boolean" ? hit.stored : envSwitch(key);
}

/** Forget every remembered switch (tests). */
export function forgetSwitches(): void {
  switchCache.clear();
}

/** Whether teams are on for this deployment (off by default). */
export function teamsEnabled(): Promise<boolean> {
  return cachedSwitch(TEAMS_KEY);
}

/** Whether automatic merging needs the confirmation (off by default). */
export function mergeConfirmationRequired(): Promise<boolean> {
  return cachedSwitch(MERGE_CONFIRMATION_KEY);
}

/** Whether the getting-started guide shows (off by default). */
export function onboardingEnabled(): Promise<boolean> {
  return cachedSwitch(ONBOARDING_KEY);
}
