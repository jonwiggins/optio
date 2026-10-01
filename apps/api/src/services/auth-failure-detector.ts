import { and, desc, gt, lt, ilike, isNull, or, sql, inArray, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { taskLogs, secrets, authEvents, workRuns } from "../db/schema.js";

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
 *
 * Multiple rows can match when the same secret name is stored at different
 * scopes/workspaces (e.g. a global GITHUB_TOKEN plus a workspace-scoped one,
 * or both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY). We want the latest
 * update across all of them so that any fresh save moves the watermark
 * forward and old failures get excluded from the window.
 */
async function getSecretWatermark(secretNames: string[]): Promise<Date | null> {
  const rows = await db
    .select({ updatedAt: secrets.updatedAt })
    .from(secrets)
    .where(inArray(secrets.name, secretNames))
    .orderBy(desc(secrets.updatedAt))
    .limit(1);
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
 * Only the logs of Optio's own coding work — Repo Tasks and PR reviews — say
 * whether Optio's credentials work. A persistent agent's or a Job's output
 * legitimately carries other services' "invalid api key" / "bad credentials"
 * errors (a Job worker records its own agent's 401s as auth events instead).
 */
const ownWorkLogs = () =>
  and(
    isNull(taskLogs.persistentAgentTurnId),
    sql`NOT EXISTS (SELECT 1 FROM ${workRuns} WHERE ${workRuns.id} = ${taskLogs.taskId} AND ${workRuns.kind} = 'standalone')`,
  );

/**
 * Check if any Claude auth failures exist in task_logs after the cutoff.
 */
async function hasClaudeFailuresInLogs(cutoff: Date): Promise<boolean> {
  const patternClauses = AUTH_FAILURE_PATTERNS.map((p) => ilike(taskLogs.content, `%${p}%`));
  const rows = await db
    .select({ exists: sql<number>`1` })
    .from(taskLogs)
    .where(and(gt(taskLogs.timestamp, cutoff), ownWorkLogs(), or(...patternClauses)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Check if any Claude auth failures exist in auth_events after the cutoff.
 * This is the mechanism by which Standalone Task runs surface auth failures:
 * their logs are left out of the log scans above, so the workflow worker
 * records a claude auth_event when it detects a 401 mid-run.
 */
async function hasClaudeFailuresInEvents(cutoff: Date): Promise<boolean> {
  const rows = await db
    .select({ exists: sql<number>`1` })
    .from(authEvents)
    .where(and(eq(authEvents.tokenType, "claude"), gt(authEvents.createdAt, cutoff)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Check if any GitHub auth failures exist in the auth_events table after the cutoff.
 * Only considers failures from the central token path (pr-watcher, legacy/null source).
 * Provider-specific failures (ticket-sync:*) are excluded — they don't reflect global
 * GITHUB_TOKEN health and are surfaced separately in the provider config UI.
 */
async function hasGithubFailuresInEvents(cutoff: Date): Promise<boolean> {
  const rows = await db
    .select({ exists: sql<number>`1` })
    .from(authEvents)
    .where(
      and(
        eq(authEvents.tokenType, "github"),
        gt(authEvents.createdAt, cutoff),
        or(sql`${authEvents.source} IS NULL`, sql`${authEvents.source} NOT LIKE 'ticket-sync:%'`),
      ),
    )
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
    .where(and(gt(taskLogs.timestamp, cutoff), ownWorkLogs(), or(...patternClauses)))
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
  const [claudeLogFailure, claudeEventFailure, githubEventFailure, githubLogFailure] =
    await Promise.all([
      hasClaudeFailuresInLogs(claudeCutoff),
      hasClaudeFailuresInEvents(claudeCutoff),
      hasGithubFailuresInEvents(githubCutoff),
      hasGithubFailuresInLogs(githubCutoff),
    ]);

  // Prune stale rows in the background to prevent unbounded table growth
  pruneStaleAuthEvents(windowMs).catch(() => {});

  return {
    claude: claudeLogFailure || claudeEventFailure,
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
 * Record an auth failure event so it can be surfaced in the dashboard.
 * @param source — identifies the caller, e.g. "pr-watcher" or "ticket-sync:<providerId>".
 *   The global GitHub banner only fires for non-ticket-sync sources.
 */
export async function recordAuthEvent(
  tokenType: "claude" | "github",
  errorMessage: string,
  source?: string,
): Promise<void> {
  await db.insert(authEvents).values({ tokenType, errorMessage, source });
}

/** Delete auth_events older than the lookback window to prevent unbounded table growth. */
async function pruneStaleAuthEvents(windowMs: number): Promise<void> {
  const cutoff = new Date(Date.now() - windowMs);
  await db.delete(authEvents).where(lt(authEvents.createdAt, cutoff));
}

export interface AuthFailureDetection {
  matched: boolean;
  pattern?: (typeof AUTH_FAILURE_PATTERNS)[number];
  /** Short, whitespace-normalized excerpt around the match, capped at ~240 chars. */
  excerpt?: string;
}

/**
 * Scan a raw log blob (accumulated agent stdout/stderr) for Claude auth failure
 * markers. Pure function; does no DB I/O. Returns the first matching pattern.
 *
 * Callers should use this to override a nominally-successful agent result when
 * the agent emitted a 401 mid-run — claude-code and similar CLIs often swallow
 * the error and exit 0, which would otherwise mark the run as completed.
 *
 * Lines that are stream-json `{"type":"user",...}` or `{"type":"assistant",...}`
 * events are skipped: they carry agent-internal content (tool_result file
 * dumps, Edit/Write input, the agent's own narration) which can contain
 * literal pattern text — e.g. a Read of a test fixture that asserts on an
 * `Invalid API key` response. Real claude-code auth failures arrive as plain
 * text from the runtime ("Failed to authenticate. API Error: 401 …"), not as
 * NDJSON events, so this filter only removes false positives.
 */
export function detectAuthFailureInLogs(logs: string): AuthFailureDetection {
  if (!logs) return { matched: false };
  for (const line of logs.split("\n")) {
    if (!line.trim()) continue;
    if (isAgentInternalEvent(line)) continue;
    const lower = line.toLowerCase();
    for (const pattern of AUTH_FAILURE_PATTERNS) {
      const idx = lower.indexOf(pattern);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 40);
      const end = Math.min(line.length, idx + pattern.length + 200);
      const excerpt = line.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 240);
      return { matched: true, pattern, excerpt };
    }
  }
  return { matched: false };
}

function isAgentInternalEvent(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("{")) return false;
  try {
    const event = JSON.parse(trimmed);
    return event?.type === "user" || event?.type === "assistant";
  } catch {
    return false;
  }
}
