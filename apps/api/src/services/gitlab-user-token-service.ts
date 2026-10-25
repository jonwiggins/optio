import {
  deleteSecret,
  deleteSecretsIfUnchanged,
  retrieveSecret,
  retrieveSecretVersioned,
  storeSecret,
} from "./secret-service.js";
import { LeaseLostError, withLease } from "./lease-service.js";
import { getCallbackUrl } from "./oauth/provider.js";
import { gitlabUserTokensEnabled } from "./oauth/gitlab.js";
import { logger } from "../logger.js";

/**
 * "Use my GitLab account for my work" (docs/sign-in.md), the counterpart of
 * the GitHub App user tokens github-token-service.ts keeps: opt-in with
 * `GITLAB_OAUTH_STORE_USER_TOKEN=true` (chart
 * `auth.gitlab.storeUserToken`). GitLab sign-in then asks for the `api`
 * scope too and keeps the person's access and refresh tokens (GitLab's
 * expire in two hours) as their own secrets, refreshed five minutes before
 * they expire. git-token-service.ts uses them for that person's work on
 * the GitLab sign-in uses (`GITLAB_OAUTH_BASE_URL`), after a GitLab token
 * the person saved themselves and before the organization's.
 *
 * Off, sign-in asks for `read_user` only and nothing is stored, as before.
 */

export const ACCESS_TOKEN = "GITLAB_USER_OAUTH_ACCESS_TOKEN";
export const REFRESH_TOKEN = "GITLAB_USER_OAUTH_REFRESH_TOKEN";
export const EXPIRES_AT = "GITLAB_USER_OAUTH_EXPIRES_AT";

/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
const REFRESH_LEASE_TTL_MS = 30_000;
const REFRESH_WAIT_MS = 30_000;
const REFRESH_FETCH_TIMEOUT_MS = 15_000;
/** GitLab's access tokens live two hours unless it says otherwise. */
const DEFAULT_EXPIRES_IN_S = 7200;

const scopeOf = (userId: string) => `user:${userId}`;

export { gitlabUserTokensEnabled };

/** The GitLab sign-in uses. */
export function gitlabSignInBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GITLAB_OAUTH_BASE_URL || "https://gitlab.com").replace(/\/+$/, "");
}

function signInHost(): string | null {
  try {
    return new URL(gitlabSignInBaseUrl()).host.toLowerCase();
  } catch {
    return null;
  }
}

export async function storeUserGitLabTokens(
  userId: string,
  tokens: { accessToken: string; refreshToken: string; expiresIn?: number | null },
): Promise<void> {
  const scope = scopeOf(userId);
  const expiresAt = new Date(
    Date.now() + (tokens.expiresIn || DEFAULT_EXPIRES_IN_S) * 1000,
  ).toISOString();
  await Promise.all([
    storeSecret(ACCESS_TOKEN, tokens.accessToken, scope),
    storeSecret(REFRESH_TOKEN, tokens.refreshToken, scope),
    storeSecret(EXPIRES_AT, expiresAt, scope),
  ]);
}

export async function deleteUserGitLabTokens(userId: string): Promise<void> {
  const scope = scopeOf(userId);
  await Promise.all([
    deleteSecret(ACCESS_TOKEN, scope).catch(() => {}),
    deleteSecret(REFRESH_TOKEN, scope).catch(() => {}),
    deleteSecret(EXPIRES_AT, scope).catch(() => {}),
  ]);
}

/** The stored access token while it has more than `marginMs` to live, else null. */
async function storedToken(userId: string, marginMs: number): Promise<string | null> {
  try {
    const scope = scopeOf(userId);
    const accessToken = await retrieveSecret(ACCESS_TOKEN, scope);
    const expiresAt = await retrieveSecret(EXPIRES_AT, scope);
    return Date.now() < new Date(expiresAt).getTime() - marginMs ? accessToken : null;
  } catch {
    return null;
  }
}

const refreshing = new Map<string, Promise<string | null>>();

/**
 * The person's GitLab token from sign-in for `host`, refreshed when it is
 * about to expire; null when the option is off, the host isn't the one
 * sign-in uses, nothing is stored, or the refresh failed.
 */
export async function getUserGitLabToken(
  userId: string,
  host: string | null | undefined,
): Promise<string | null> {
  if (!gitlabUserTokensEnabled() || !host) return null;
  const own = signInHost();
  if (!own || host.trim().toLowerCase() !== own) return null;
  const fresh = await storedToken(userId, REFRESH_MARGIN_MS);
  if (fresh) return fresh;
  // Nothing stored at all: no refresh to try.
  try {
    await retrieveSecret(REFRESH_TOKEN, scopeOf(userId));
  } catch {
    return null;
  }
  const running = refreshing.get(userId);
  if (running) return running;
  const p = refreshLeased(userId).finally(() => refreshing.delete(userId));
  refreshing.set(userId, p);
  return p;
}

/**
 * Refresh under the lease `gitlab-refresh:<userId>`: GitLab rotates the
 * refresh token on use, so two instances refreshing one person at once
 * would strand one of them. Inside, the stored token is read again first
 * (another instance may just have refreshed it).
 */
export async function refreshLeased(userId: string, holder?: string): Promise<string | null> {
  try {
    const result = await withLease(
      `gitlab-refresh:${userId}`,
      async (signal) => {
        const fresh = await storedToken(userId, REFRESH_MARGIN_MS);
        if (fresh) return { token: fresh };
        return { token: await refreshOnce(userId, signal) };
      },
      {
        ttlMs: REFRESH_LEASE_TTL_MS,
        wait: { timeoutMs: REFRESH_WAIT_MS, pollMs: 250 },
        ...(holder ? { holder } : {}),
      },
    );
    if (result) return result.token;
    logger.warn({ userId }, "Timed out waiting for another instance's GitLab token refresh");
  } catch (err) {
    if (!(err instanceof LeaseLostError)) throw err;
    logger.warn({ userId }, "GitLab token refresh outlived its lease");
  }
  return storedToken(userId, 0);
}

/** One refresh against GitLab; the stored tokens go only when GitLab says the grant is gone. */
async function refreshOnce(userId: string, signal: AbortSignal): Promise<string | null> {
  const scope = scopeOf(userId);
  try {
    const refresh = await retrieveSecretVersioned(REFRESH_TOKEN, scope);
    const res = await fetch(`${gitlabSignInBaseUrl()}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITLAB_OAUTH_CLIENT_ID ?? "",
        client_secret: process.env.GITLAB_OAUTH_CLIENT_SECRET ?? "",
        grant_type: "refresh_token",
        refresh_token: refresh.value,
        redirect_uri: getCallbackUrl("gitlab"),
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS)]),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.error) {
      const code = String(data.error ?? res.status);
      // A revoked or expired grant: the stored tokens are useless.
      if (code === "invalid_grant") {
        const deleted = await deleteSecretsIfUnchanged(
          [ACCESS_TOKEN, REFRESH_TOKEN, EXPIRES_AT],
          scope,
          { name: REFRESH_TOKEN, version: refresh.version },
        );
        logger.warn(
          { userId, deleted },
          "GitLab refused the refresh token (revoked or expired): signing in again stores a new one",
        );
      }
      throw new Error(`GitLab token refresh failed: ${code}`);
    }
    const accessToken = String(data.access_token ?? "");
    const refreshToken = String(data.refresh_token ?? "");
    if (!accessToken || !refreshToken) throw new Error("GitLab sent no token");
    await storeUserGitLabTokens(userId, {
      accessToken,
      refreshToken,
      expiresIn: typeof data.expires_in === "number" ? data.expires_in : null,
    });
    return accessToken;
  } catch (err) {
    logger.warn({ userId, err }, "GitLab user token refresh failed");
    return null;
  }
}
