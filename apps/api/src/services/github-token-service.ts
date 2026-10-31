import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import {
  retrieveSecret,
  retrieveSecretVersioned,
  retrieveSecretWithFallback,
  storeSecret,
  deleteSecret,
  deleteSecretsIfUnchanged,
} from "./secret-service.js";
import {
  isGitHubAppConfigured,
  getInstallationToken,
  type InstallationRepo,
} from "./github-app-service.js";
import { LeaseLostError, withLease } from "./lease-service.js";
import { logger } from "../logger.js";

const refreshLocks = new Map<string, Promise<string | null>>();
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000;

/**
 * `repo` limits an installation token to that one repository: set it
 * whenever the token is for a pod (a prompt-injected agent must not get
 * every repository of the installation).
 */
export type GitHubTokenContext =
  | { taskId: string }
  /** A team's work: the team's GITHUB_TOKEN, else the server's; never its creator's own. */
  | { teamId: string; workspaceId: string | null; repo?: InstallationRepo }
  | { userId: string; workspaceId?: string | null; repo?: InstallationRepo }
  | { server: true; workspaceId?: string | null; repo?: InstallationRepo };

export async function getGitHubToken(context: GitHubTokenContext): Promise<string> {
  if ("server" in context) return getServerToken(context.workspaceId, context.repo);
  if ("taskId" in context) return getTokenForTask(context.taskId);
  if ("teamId" in context)
    return getTokenForTeam(context.teamId, context.workspaceId, context.repo);
  return getTokenForUser(context.userId, context.workspaceId, context.repo);
}

async function getServerToken(
  workspaceId?: string | null,
  repo?: InstallationRepo,
): Promise<string> {
  if (isGitHubAppConfigured()) {
    try {
      return await getInstallationToken(repo);
    } catch (err) {
      logger.warn({ err }, "Installation token failed, falling back to PAT");
      return getPatFallback(workspaceId);
    }
  }
  return getPatFallback(workspaceId);
}

async function getTokenForTeam(
  teamId: string,
  workspaceId: string | null,
  repo?: InstallationRepo,
): Promise<string> {
  const own = await retrieveSecret("GITHUB_TOKEN", "team", workspaceId, undefined, teamId).catch(
    () => null,
  );
  return own ?? getServerToken(workspaceId, repo);
}

async function getTokenForTask(taskId: string): Promise<string> {
  const [task] = await db
    .select({
      createdBy: tasks.createdBy,
      workspaceId: tasks.workspaceId,
      ownerTeamId: tasks.ownerTeamId,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  // A team's task: the team's token, never its creator's own.
  if (task?.ownerTeamId) return getTokenForTeam(task.ownerTeamId, task.workspaceId);

  if (!task?.createdBy) {
    // No user associated — use server/installation token (e.g., system-created tasks)
    return getServerToken();
  }
  return getTokenForUser(task.createdBy, task.workspaceId);
}

const ACCESS_TOKEN = "GITHUB_USER_ACCESS_TOKEN";
const REFRESH_TOKEN = "GITHUB_USER_REFRESH_TOKEN";
const EXPIRES_AT = "GITHUB_USER_TOKEN_EXPIRES_AT";

async function getTokenForUser(
  userId: string,
  workspaceId?: string | null,
  repo?: InstallationRepo,
): Promise<string> {
  let refreshed: string | null = null;
  try {
    const accessToken = await retrieveSecret(ACCESS_TOKEN, `user:${userId}`);
    const expiresAt = await retrieveSecret(EXPIRES_AT, `user:${userId}`);

    const expiryTime = new Date(expiresAt).getTime();
    if (Date.now() < expiryTime - TOKEN_REFRESH_BUFFER_MS) {
      return accessToken;
    }
    // Awaited here, so a refresh that rejects lands in the catch below.
    refreshed = await refreshUserToken(userId, workspaceId);
  } catch (err) {
    logger.warn({ userId, err }, "No usable user token, falling back to PAT");
  }
  return refreshed ?? getPatFallback(workspaceId, userId, repo);
}

/** Within one instance, concurrent refreshes of a user share one promise. */
async function refreshUserToken(
  userId: string,
  workspaceId?: string | null,
): Promise<string | null> {
  const existing = refreshLocks.get(userId);
  if (existing) return existing;

  const refreshPromise = refreshUserTokenLeased(userId, workspaceId);
  refreshLocks.set(userId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    refreshLocks.delete(userId);
  }
}

const REFRESH_LEASE_TTL_MS = 30_000;
const REFRESH_WAIT_MS = 30_000;
const REFRESH_FETCH_TIMEOUT_MS = 15_000;

/**
 * Refreshes a user's token under the lease `github-refresh:<userId>`, the
 * only way it is ever refreshed. GitHub rotates the refresh token on use,
 * so two instances refreshing one user at once would strand one of them
 * with a dead refresh token. An instance that finds the lease held waits
 * for it; inside, it first re-reads the stored token and returns it when it
 * is fresh (another instance just refreshed). When the wait times out, or
 * the lease is lost under the refresh, it returns the stored token while it
 * still works, else null — the caller falls back to the PAT; it never
 * refreshes without the lease. Null also when the refresh itself failed.
 *
 * `holder` lets a test play two instances in one process.
 */
export async function refreshUserTokenLeased(
  userId: string,
  workspaceId?: string | null,
  holder?: string,
): Promise<string | null> {
  try {
    const result = await withLease(
      `github-refresh:${userId}`,
      async (signal) => {
        const fresh = await storedToken(userId, TOKEN_REFRESH_BUFFER_MS);
        if (fresh) return { token: fresh };
        return { token: await doRefreshUserToken(userId, signal) };
      },
      {
        ttlMs: REFRESH_LEASE_TTL_MS,
        wait: { timeoutMs: REFRESH_WAIT_MS, pollMs: 250 },
        ...(holder ? { holder } : {}),
      },
    );
    if (result) return result.token;
    logger.warn({ userId }, "Timed out waiting for another instance's GitHub token refresh");
  } catch (err) {
    if (!(err instanceof LeaseLostError)) throw err;
    logger.warn({ userId }, "GitHub token refresh outlived its lease");
  }
  return storedToken(userId, 0);
}

/** The user's stored access token while it has more than `marginMs` to live, else null. */
async function storedToken(userId: string, marginMs: number): Promise<string | null> {
  try {
    const accessToken = await retrieveSecret(ACCESS_TOKEN, `user:${userId}`);
    const expiresAt = await retrieveSecret(EXPIRES_AT, `user:${userId}`);
    return Date.now() < new Date(expiresAt).getTime() - marginMs ? accessToken : null;
  } catch {
    return null;
  }
}

/**
 * One refresh against GitHub (called under the lease). Null when it
 * failed; the stored tokens are deleted only on a definitive revocation,
 * and only while the refresh token is still the one this refresh used.
 */
async function doRefreshUserToken(userId: string, signal: AbortSignal): Promise<string | null> {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  const scope = `user:${userId}`;

  if (!clientId || !clientSecret) {
    await deleteUserGitHubTokens(userId);
    return null;
  }

  try {
    const refresh = await retrieveSecretVersioned(REFRESH_TOKEN, scope);

    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refresh.value,
      }),
      // A hung call must not hold the lease.
      signal: AbortSignal.any([signal, AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS)]),
    });

    if (!res.ok) throw new Error(`GitHub token refresh failed: ${res.status}`);

    const data = (await res.json()) as Record<string, string | number>;
    if (data.error) {
      const errorCode = String(data.error);
      // Only delete tokens on definitive revocation — not transient failures —
      // and only if nobody stored a newer refresh token meanwhile.
      if (errorCode === "bad_refresh_token" || errorCode === "incorrect_client_credentials") {
        const deleted = await deleteSecretsIfUnchanged(
          [ACCESS_TOKEN, REFRESH_TOKEN, EXPIRES_AT],
          scope,
          { name: REFRESH_TOKEN, version: refresh.version },
        );
        if (deleted) {
          logger.error({ userId, errorCode }, "GitHub token revoked, deleted stored tokens");
        } else {
          logger.warn({ userId, errorCode }, "GitHub refused a refresh token already replaced");
        }
      }
      throw new Error(`GitHub token refresh error: ${errorCode}`);
    }

    const newAccessToken = data.access_token as string;
    const newRefreshToken = data.refresh_token as string;
    const expiresIn = (data.expires_in as number) ?? 28800;

    await storeUserGitHubTokens(userId, {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn,
    });

    return newAccessToken;
  } catch (err) {
    // Don't delete tokens on transient errors (network, 5xx, timeout) — only
    // the definitive revocation cases above delete them before re-throwing.
    logger.warn({ userId, err }, "Token refresh failed, falling back to PAT");
    return null;
  }
}

/**
 * Last-resort fallback: try to retrieve a manually-configured GITHUB_TOKEN PAT.
 * Returns the token if found, throws a descriptive error if not.
 */
async function getPatFallback(
  workspaceId?: string | null,
  userId?: string,
  repo?: InstallationRepo,
): Promise<string> {
  try {
    return await retrieveSecretWithFallback("GITHUB_TOKEN", "global", workspaceId, userId);
  } catch {
    if (userId && isGitHubAppConfigured()) return getInstallationToken(repo);
    throw new Error(
      "No GitHub token available. Configure a GitHub App (recommended) or add a GITHUB_TOKEN secret.",
    );
  }
}

export async function storeUserGitHubTokens(
  userId: string,
  tokens: { accessToken: string; refreshToken: string; expiresIn: number },
): Promise<void> {
  const scope = `user:${userId}`;
  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
  await Promise.all([
    storeSecret("GITHUB_USER_ACCESS_TOKEN", tokens.accessToken, scope),
    storeSecret("GITHUB_USER_REFRESH_TOKEN", tokens.refreshToken, scope),
    storeSecret("GITHUB_USER_TOKEN_EXPIRES_AT", expiresAt, scope),
  ]);
}

export async function deleteUserGitHubTokens(userId: string): Promise<void> {
  const scope = `user:${userId}`;
  await Promise.all([
    deleteSecret("GITHUB_USER_ACCESS_TOKEN", scope),
    deleteSecret("GITHUB_USER_REFRESH_TOKEN", scope),
    deleteSecret("GITHUB_USER_TOKEN_EXPIRES_AT", scope),
  ]);
}
