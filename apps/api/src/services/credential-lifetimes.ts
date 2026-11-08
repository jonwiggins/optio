import { limitValue, type DeploymentLimit } from "./deployment-settings.js";

/**
 * Optional lifetimes for sign-in sessions and the API keys a CLI login
 * creates. Each is a deployment limit (services/deployment-settings.ts): set by
 * the environment (the chart's `auth.sessions` / `auth.cliKeyMaxDays`) or by a
 * deployment admin in Settings → Access, which wins. With none set, nothing
 * changes: a session lasts 30 days at most and ends after 7 days unused, and a
 * CLI key never expires.
 *
 * - **Session max lifetime** (`OPTIO_SESSION_MAX_HOURS`): a session ends this
 *   long after sign-in, however active. Lowering it applies to existing
 *   sessions at once.
 * - **Session idle timeout** (`OPTIO_SESSION_IDLE_MINUTES`): a session unused
 *   this long ends. Counted from its last use (`sessions.last_seen_at`), so it
 *   too applies to existing sessions.
 * - **CLI key lifetime** (`OPTIO_CLI_KEY_MAX_DAYS`): a key the CLI login
 *   creates expires this long after it is made. Keys made before are not
 *   changed; a deployment admin can revoke them.
 */

/** The built-in session limits (what "no limit set" means). */
const DEFAULT_SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_SESSION_SLIDING_MS = 7 * 24 * 60 * 60 * 1000;

export const SESSION_MAX_HOURS: DeploymentLimit = {
  key: "sessions.maxHours",
  env: "OPTIO_SESSION_MAX_HOURS",
  min: 1,
  max: 720, // the built-in 30 days: the setting only shortens it
};

export const SESSION_IDLE_MINUTES: DeploymentLimit = {
  key: "sessions.idleMinutes",
  env: "OPTIO_SESSION_IDLE_MINUTES",
  min: 5,
  max: 10_080, // the built-in 7 days
};

export const CLI_KEY_MAX_DAYS: DeploymentLimit = {
  key: "apiKeys.cliMaxDays",
  env: "OPTIO_CLI_KEY_MAX_DAYS",
  min: 1,
  max: 3650,
};

export interface SessionLifetimes {
  /** A session ends this long after it was created. */
  maxMs: number;
  /** A session unused this long ends; null: only the built-in 7-day window. */
  idleMs: number | null;
}

export async function sessionLifetimes(): Promise<SessionLifetimes> {
  const [maxHours, idleMinutes] = await Promise.all([
    limitValue(SESSION_MAX_HOURS),
    limitValue(SESSION_IDLE_MINUTES),
  ]);
  return {
    maxMs: maxHours === null ? DEFAULT_SESSION_MAX_MS : maxHours * 60 * 60 * 1000,
    idleMs: idleMinutes === null ? null : idleMinutes * 60 * 1000,
  };
}

/** When a key the CLI login creates now should expire; null: never. */
export async function cliKeyExpiry(now: Date = new Date()): Promise<Date | null> {
  const days = await limitValue(CLI_KEY_MAX_DAYS);
  return days === null ? null : new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
