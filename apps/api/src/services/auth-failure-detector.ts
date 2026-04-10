import { and, gt, ilike, or, sql, inArray, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { taskLogs, secrets, authEvents } from "../db/schema.js";

/**
 * Substrings (case-insensitive) that indicate an authentication failure bubbling
 * up from claude or the Anthropic API. Picked to cover:
 *  - stream-json `{"type":"error","error":{"type":"authentication_error",...}}`
 *  - plain text `Failed to authenticate. API Error: 401 ...`
 *  - `invalid_api_key` from api-key mode
 *  - our own status endpoint's "OAuth token has expired" message
 *
 * Avoids matching the word "unauthorized" alone since that can appear in
 * unrelated github/git error output.
 */
export const AUTH_FAILURE_PATTERNS = [
  "api error: 401",
  "authentication_error",
  '"status":401',
  "invalid_api_key",
  "invalid api key",
  "oauth token has expired",
] as const;

/** GitHub-specific failure patterns for detecting bad GITHUB_TOKEN. */
export const GITHUB_FAILURE_PATTERNS = ["Bad credentials", "bad credentials"] as const;

/** Default lookback window for the banner trigger. */
export const RECENT_AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/** Secret names considered auth-related for each token type. */
const CLAUDE_SECRET_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
const GITHUB_SECRET_NAMES = ["GITHUB_TOKEN"];

export type AuthFailureStatus = {
  claude: boolean;
  github: boolean;
};

/**
 * Get the most recent updatedAt from secrets matching the given names.
 * Returns null if no matching secret exists.
 */
async function getSecretWatermark(secretNames: string[]): Promise<Date | null> {
  const rows = await db
    .select({ updatedAt: secrets.updatedAt })
    .from(secrets)
    .where(inArray(secrets.name, secretNames))
    .limit(1);
  // If multiple secrets match, use the most recent updatedAt
  if (rows.length === 0) return null;
  return rows[0].updatedAt;
}

/**
 * Compute the effective cutoff: max(now - windowMs, lastTokenUpdate).
 * If the token was recently updated, only consider failures after the update.
 */
function effectiveCutoff(windowMs: number, watermark: Date | null): Date {
  const windowCutoff = new Date(Date.now() - windowMs);
  if (!watermark) return windowCutoff;
  return watermark > windowCutoff ? watermark : windowCutoff;
}

/**
 * Check if any Claude auth failures exist in task_logs after the cutoff.
 */
async function hasClaudeFailuresInLogs(cutoff: Date): Promise<boolean> {
  const patternClauses = AUTH_FAILURE_PATTERNS.map((p) => ilike(taskLogs.content, `%${p}%`));
  const rows = await db
    .select({ exists: sql<number>`1` })
    .from(taskLogs)
    .where(and(gt(taskLogs.timestamp, cutoff), or(...patternClauses)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Check if any GitHub auth failures exist in the auth_events table after the cutoff.
 */
async function hasGithubFailuresInEvents(cutoff: Date): Promise<boolean> {
  const rows = await db
    .select({ exists: sql<number>`1` })
    .from(authEvents)
    .where(and(eq(authEvents.tokenType, "github"), gt(authEvents.createdAt, cutoff)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Check if any GitHub auth failures exist in task_logs after the cutoff.
 */
async function hasGithubFailuresInLogs(cutoff: Date): Promise<boolean> {
  const patternClauses = GITHUB_FAILURE_PATTERNS.map((p) => ilike(taskLogs.content, `%${p}%`));
  const rows = await db
    .select({ exists: sql<number>`1` })
    .from(taskLogs)
    .where(and(gt(taskLogs.timestamp, cutoff), or(...patternClauses)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Returns per-token-type auth failure status. Uses watermarks from
 * secrets.updatedAt to narrow the window: if a token was updated 2 minutes ago,
 * only failures from those 2 minutes count.
 */
export async function getRecentAuthFailures(
  windowMs: number = RECENT_AUTH_FAILURE_WINDOW_MS,
): Promise<AuthFailureStatus> {
  // Get watermarks in parallel
  const [claudeWatermark, githubWatermark] = await Promise.all([
    getSecretWatermark(CLAUDE_SECRET_NAMES),
    getSecretWatermark(GITHUB_SECRET_NAMES),
  ]);

  const claudeCutoff = effectiveCutoff(windowMs, claudeWatermark);
  const githubCutoff = effectiveCutoff(windowMs, githubWatermark);

  // Check failures in parallel
  const [claudeFailure, githubEventFailure, githubLogFailure] = await Promise.all([
    hasClaudeFailuresInLogs(claudeCutoff),
    hasGithubFailuresInEvents(githubCutoff),
    hasGithubFailuresInLogs(githubCutoff),
  ]);

  return {
    claude: claudeFailure,
    github: githubEventFailure || githubLogFailure,
  };
}

/**
 * Returns true if any task log line in the recent window contains an
 * authentication-failure marker. This is what the web dashboard uses to decide
 * whether to show the "OAuth token expired" banner — the usage endpoint alone
 * is unreliable because it can return 429 (rate limited) even when the
 * messages endpoint is returning 401.
 *
 * @deprecated Use getRecentAuthFailures() for per-token-type detection with watermarks.
 */
export async function hasRecentClaudeAuthFailure(
  windowMs: number = RECENT_AUTH_FAILURE_WINDOW_MS,
): Promise<boolean> {
  const result = await getRecentAuthFailures(windowMs);
  return result.claude;
}

/**
 * Record a GitHub auth failure event so it can be surfaced in the dashboard banner.
 * Call this from ticket-sync-worker, pr-watcher, or any non-task context that
 * encounters a GitHub 401.
 */
export async function recordAuthEvent(
  tokenType: "claude" | "github",
  errorMessage: string,
): Promise<void> {
  await db.insert(authEvents).values({ tokenType, errorMessage });
}
