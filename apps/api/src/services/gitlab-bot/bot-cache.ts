/**
 * Who Optio's bot is per GitLab or GitHub API (settings.ts `botIdentity`,
 * `githubBotIdentity` fill it), in memory for ten minutes. A module of its own, with no imports, so
 * the webhook receiver's quick check (ingress.ts) stays light.
 */

export interface BotIdentity {
  username: string;
  /** GitLab's id for the token's user; null when an admin named the bot, and on GitHub. */
  id: number | null;
  source: "app" | "environment" | "token";
}

export interface CachedIdentity {
  at: number;
  identity: BotIdentity | null;
  error: string | null;
}

/** Keyed `<apiBaseUrl>|<workspaceId>` (GitLab), `github:<apiBaseUrl>|` (GitHub). */
export const botIdentityCache = new Map<string, CachedIdentity>();

/** The cached bot username for a GitLab API, without asking GitLab. */
export function cachedBotUsername(apiBaseUrl: string): string | null {
  for (const [key, v] of botIdentityCache) {
    if (key.startsWith(`${apiBaseUrl}|`) && v.identity) return v.identity.username;
  }
  return null;
}
