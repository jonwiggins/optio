/**
 * Which identity authority a comment's host is (docs/gitlab-bot.md "Who
 * Optio works as"). Pure.
 *
 * The sign-in host is the GitHub or GitLab Optio signs people in with:
 * github.com, or the GitLab at GITLAB_OAUTH_BASE_URL. There a comment's
 * author id is the same authority's id as a linked sign-in, and that
 * GitLab's emails are the ones Optio's sign-in already trusts. Any other
 * GitLab is only trusted for what it says about its projects: a
 * self-managed GitLab with email confirmation off lets a person show any
 * address as their public email, so its emails never name an Optio person.
 */
export type IdentityPlatform = "github" | "gitlab";

/** The sign-in host for a platform, lower case, or null when it can't be read. */
export function signInHost(platform: IdentityPlatform): string | null {
  if (platform === "github") return "github.com";
  try {
    return new URL(process.env.GITLAB_OAUTH_BASE_URL || "https://gitlab.com").host.toLowerCase();
  } catch {
    return null;
  }
}

/** Whether a comment on `host` comes from the platform's sign-in authority. */
export function isSignInHost(platform: IdentityPlatform, host: string): boolean {
  const signIn = signInHost(platform);
  return !!signIn && host.toLowerCase() === signIn;
}

/**
 * The sign-in account a comment's author would have: GitHub's on
 * github.com, GitLab's on the GitLab sign-in uses; null elsewhere.
 */
export function linkedAccount(
  platform: IdentityPlatform,
  host: string,
  authorId: number | null,
): { provider: IdentityPlatform; externalId: string } | null {
  if (authorId === null) return null;
  return isSignInHost(platform, host) ? { provider: platform, externalId: String(authorId) } : null;
}

/**
 * Whether the author's public email may name an Optio person. GitHub shows
 * only confirmed addresses; a GitLab only on the sign-in host.
 */
export function publicEmailTrusted(platform: IdentityPlatform, host: string): boolean {
  return platform === "github" || isSignInHost(platform, host);
}
