import { eq } from "drizzle-orm";
import type { GitPlatform, GitPlatformType, RepoIdentifier } from "@optio/shared";
import {
  currentFeatures,
  knownHostPlatform,
  normalizeRepoUrl,
  parseRepoUrl,
  resolveRepoPlatform,
} from "@optio/shared";
import { db } from "../db/client.js";
import { repos } from "../db/schema.js";
import { getGitHubToken } from "./github-token-service.js";
import { retrieveSecret, retrieveSecretWithFallback } from "./secret-service.js";
import {
  PUBLIC_GITLAB,
  namedGitLabHosts,
  normalizeGitLabHost,
} from "./credential-health/gitlab-hosts.js";
import { getCodeCommitCredentials } from "./codecommit-credential-service.js";
import { getUserGitLabToken, gitlabUserTokensEnabled } from "./gitlab-user-token-service.js";
import { createGitPlatform } from "./git-platform/index.js";
import { logger } from "../logger.js";

import { refreshGitLabInstances } from "./gitlab-instance-service.js";
import { runtimeGitLabInstance } from "./gitlab-instance-runtime.js";

export interface GitTokenContext {
  userId?: string;
  workspaceId?: string | null;
  /** The work's team: its GITLAB_TOKEN is tried instead of the person's (docs/teams.md). */
  ownerTeamId?: string | null;
  server?: boolean;
  /**
   * GitLab: only the team's or the person's own GITLAB_TOKEN, never the
   * organization's or the env var's (what a team or a person set up on its
   * own, like a ticket provider, reaches only what its owner may see).
   */
  ownOnly?: boolean;
  /**
   * The GitLab host the token is for: at each scope a token saved for that
   * host (`gitLabTokenNameForHost`) comes before the plain GITLAB_TOKEN, so
   * gitlab.com and a self-managed GitLab can each have their own.
   */
  host?: string | null;
}

/**
 * The secret (and env var) name of a GitLab token for one host:
 * `GITLAB_TOKEN_` and the host in capitals with every other character an
 * underscore — `git.example.com:8443` → `GITLAB_TOKEN_GIT_CORP_EXAMPLE_8443`.
 */
export function gitLabTokenNameForHost(host: string): string {
  return `GITLAB_TOKEN_${host
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * Resolve a git platform token for the given platform and context.
 * GitHub: delegates to the existing github-token-service (App → user OAuth → PAT).
 * GitLab: one secret name, `GITLAB_TOKEN`, at every scope — the team's (when
 * the work is a team's), else the person's own, then the workspace's / the
 * organization's, then the `GITLAB_TOKEN` env var. A personal token saved
 * under the older name `GITLAB_USER_ACCESS_TOKEN` is still honoured, and
 * after the person's saved tokens comes the one GitLab sign-in keeps when
 * the deployment opted in (gitlab-user-token-service.ts). With a
 * `host`, a token saved for that host comes first at each scope.
 * CodeCommit: returns a JSON-encoded AWS credential blob (or "workload-identity"
 * sentinel) — see codecommit-credential-service.
 */
export async function getGitToken(
  platform: GitPlatformType,
  context: GitTokenContext,
): Promise<string> {
  if (platform === "github") {
    if (context.server) return getGitHubToken({ server: true, workspaceId: context.workspaceId });
    if (context.userId)
      return getGitHubToken({ userId: context.userId, workspaceId: context.workspaceId });
    return getGitHubToken({ server: true, workspaceId: context.workspaceId });
  }

  if (platform === "codecommit") {
    return getCodeCommitCredentials(context.workspaceId);
  }

  // GitLab: one name, GITLAB_TOKEN, at every scope — the name pods get it as
  // (git-access-env.ts). A team's work: the team's token, never its
  // creator's own; anyone else's: the person's own (or one saved under the
  // older GITLAB_USER_ACCESS_TOKEN). Then the workspace's / the
  // organization's, then the env var — the order a pod's secrets follow too
  // (secret-service.ts `retrieveSecretWithFallback`).
  const userId = context.server ? null : (context.userId ?? null);
  const teamId = context.ownerTeamId ?? null;
  const hostName = context.host ? gitLabTokenNameForHost(context.host) : null;
  const names = hostName ? [hostName, "GITLAB_TOKEN"] : ["GITLAB_TOKEN"];
  const lookups: Array<() => Promise<string>> = [];
  if (teamId) {
    for (const name of names) {
      lookups.push(() => retrieveSecret(name, "team", context.workspaceId, undefined, teamId));
    }
  } else if (userId) {
    for (const name of names) {
      lookups.push(() => retrieveSecret(name, "user", undefined, userId));
    }
    lookups.push(() =>
      retrieveSecretWithFallback("GITLAB_USER_ACCESS_TOKEN", `user:${userId}`, context.workspaceId),
    );
    // The person's token from GitLab sign-in (opt-in, refreshed), on the
    // GitLab sign-in uses only.
    if (gitlabUserTokensEnabled()) {
      lookups.push(async () => {
        const token = await getUserGitLabToken(userId, context.host);
        if (!token) throw new Error("No GitLab token from sign-in");
        return token;
      });
    }
  }
  const ownOnly = !!context.ownOnly && (!!teamId || !!userId);
  if (!ownOnly) {
    if (context.host) {
      lookups.push(async () => {
        await refreshGitLabInstances().catch(() => {});
        const token = runtimeGitLabInstance(context.host!)?.token;
        if (!token) throw new Error("No instance token");
        return token;
      });
    }
    for (const name of names) {
      lookups.push(() => retrieveSecretWithFallback(name, "global", context.workspaceId));
    }
  }
  for (const lookup of lookups) {
    try {
      return await lookup();
    } catch {
      // Not at this scope — try the next.
    }
  }
  if (ownOnly) {
    throw new Error(
      `No GitLab token of the ${teamId ? "team's" : "person's"} own. Add a GITLAB_TOKEN secret for ${teamId ? "the team" : "them"}.`,
    );
  }
  logger.debug({ userId, ownerTeamId: teamId }, "No GitLab token secret; trying the env var");
  const envToken = (hostName ? process.env[hostName] : undefined) || process.env.GITLAB_TOKEN;
  if (envToken) return envToken;
  throw new Error(
    "No GitLab token available. Add a GITLAB_TOKEN secret or set the GITLAB_TOKEN environment variable.",
  );
}

/**
 * Whether a GITLAB_TOKEN may go to `host` when only a setting names it (a
 * GitLab ticket provider without a token of its own): gitlab.com where the
 * profile allows it, a host a deployment admin named (GITLAB_HOST,
 * GITLAB_HOSTS), or the host of a GitLab repo added to `workspaceId` (any
 * workspace's when it is null). A port or a path prefix doesn't count.
 */
export async function isKnownGitLabHost(
  host: string | null | undefined,
  workspaceId: string | null,
): Promise<boolean> {
  const bare = (h: string | null | undefined) => normalizeGitLabHost(h).replace(/:\d+$/, "");
  const target = bare(host);
  if (!target) return false;
  // gitlab.com, unless agents reach their models through a gateway only (gitlab-hosts.ts).
  const full = currentFeatures().modelAccess !== "gateway";
  const saved = await retrieveSecret("GITLAB_HOST", "global").catch(() => null);
  const env = (process.env.GITLAB_HOSTS ?? process.env.OPTIO_GITLAB_HOSTS ?? "").split(",");
  const named = namedGitLabHosts([saved, ...env], full).map(bare);
  if (full) named.push(PUBLIC_GITLAB);
  if (named.includes(target)) return true;
  try {
    const rows = await db
      .select({ repoUrl: repos.repoUrl, workspaceId: repos.workspaceId })
      .from(repos)
      .where(eq(repos.gitPlatform, "gitlab"));
    return rows.some(
      (r) =>
        (!workspaceId || r.workspaceId === workspaceId) &&
        bare(parseRepoUrl(r.repoUrl, "gitlab")?.host) === target,
    );
  } catch {
    return false;
  }
}

/**
 * The platform recorded for an added repo whose host nothing names (a
 * self-hosted GitLab added as GitLab, say). Null for a known host, a repo
 * that isn't added, or a failed lookup — the URL's guess stands then.
 */
async function recordedRepoPlatform(repoUrl: string): Promise<string | null> {
  const ri = parseRepoUrl(repoUrl);
  if (!ri || knownHostPlatform(ri.host)) return null;
  try {
    const [row] = await db
      .select({ gitPlatform: repos.gitPlatform })
      .from(repos)
      .where(eq(repos.repoUrl, normalizeRepoUrl(repoUrl)))
      .limit(1);
    return row?.gitPlatform ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse a repo URL, resolve the appropriate token, and create a GitPlatform instance.
 * This is the primary entry point for consumers that need to interact with a git platform.
 * The platform is the host's when the host is a known one, else the caller's
 * `platformHint` (the repo row's), else the one recorded for the repo.
 */
export async function getGitPlatformForRepo(
  repoUrl: string,
  context: GitTokenContext & {
    platformHint?: GitPlatformType;
    /**
     * The work's GitLab token scope (its workspace's, its team's
     * GITLAB_TOKEN), laid over `context` only when the repo is GitLab's:
     * GitHub and CodeCommit keep the caller's own context.
     */
    gitlabScope?: Pick<GitTokenContext, "workspaceId" | "ownerTeamId">;
  },
): Promise<{ platform: GitPlatform; ri: RepoIdentifier }> {
  await refreshGitLabInstances().catch(() => {});
  const { platformHint, gitlabScope, ...tokenContext } = context;
  const platformType = resolveRepoPlatform(
    repoUrl,
    platformHint ?? (await recordedRepoPlatform(repoUrl)),
  );
  const ri = platformType ? parseRepoUrl(repoUrl, platformType) : null;
  if (!ri) throw new Error(`Cannot parse repo URL: ${repoUrl}`);

  const token = await getGitToken(
    ri.platform,
    ri.platform === "gitlab" ? { ...tokenContext, ...gitlabScope, host: ri.host } : tokenContext,
  );
  const platform = createGitPlatform(ri.platform, token);

  return { platform, ri };
}
