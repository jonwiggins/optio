import { refreshGitLabInstances } from "./gitlab-instance-service.js";
import { runtimeGitLabInstance } from "./gitlab-instance-runtime.js";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { repos } from "../db/schema.js";
import type { GitPlatform, GitPlatformType, RepoIdentifier } from "@optio/shared";
import {
  parseRepoUrl,
  knownHostPlatform,
  normalizeRepoUrl,
  resolveRepoPlatform,
} from "@optio/shared";
import { getGitHubToken } from "./github-token-service.js";
import { retrieveSecret, retrieveSecretWithFallback } from "./secret-service.js";
import { getCodeCommitCredentials } from "./codecommit-credential-service.js";
import { createGitPlatform } from "./git-platform/index.js";
import { logger } from "../logger.js";

export interface GitTokenContext {
  userId?: string;
  workspaceId?: string | null;
  server?: boolean;
  /** The GitLab host whose token is being requested. */
  host?: string | null;
}

/**
 * Resolve a git platform token for the given platform and context.
 * GitHub: delegates to the existing github-token-service (App → user OAuth → PAT).
 * GitLab: host-specific token, then plain token, at the personal / workspace / global scopes.
 * CodeCommit: returns a JSON-encoded AWS credential blob (or "workload-identity"
 * sentinel) — see codecommit-credential-service.
 */
export function gitLabTokenNameForHost(host: string): string {
  return `GITLAB_TOKEN_${host
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}`;
}

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

  // The person's own token, then the workspace's and organization's,
  // then the environment. Prefer the host-specific name at each scope.
  const userId = context.server ? null : (context.userId ?? null);
  const hostName = context.host ? gitLabTokenNameForHost(context.host) : null;
  const names = hostName ? [hostName, "GITLAB_TOKEN"] : ["GITLAB_TOKEN"];
  const lookups: Array<() => Promise<string>> = [];
  if (userId) {
    for (const name of names) {
      lookups.push(() => retrieveSecret(name, "user", undefined, userId));
    }
    lookups.push(() =>
      retrieveSecretWithFallback("GITLAB_USER_ACCESS_TOKEN", `user:${userId}`, context.workspaceId),
    );
  }
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
  for (const lookup of lookups) {
    try {
      return await lookup();
    } catch {
      // Not at this scope — try the next.
    }
  }
  const envToken = (hostName ? process.env[hostName] : undefined) || process.env.GITLAB_TOKEN;
  if (envToken) return envToken;
  throw new Error(
    "No GitLab token available. Add a GITLAB_TOKEN secret or set the GITLAB_TOKEN environment variable.",
  );
}

/** Hosts named in comma-separated env vars, lower-cased. */
function envHosts(...names: string[]): string[] {
  return names
    .flatMap((name) => (process.env[name] ?? "").split(","))
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Hosts the deployment's git credentials may be sent to without a lookup:
 * github.com, gitlab.com, and the hosts an operator listed (`GITLAB_HOSTS` /
 * `OPTIO_GITLAB_HOSTS`; `GITHUB_HOSTS` / `OPTIO_GITHUB_HOSTS` for GitHub
 * Enterprise).
 */
export function isListedGitHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "github.com" || h === "gitlab.com") return true;
  return envHosts(
    "GITLAB_HOSTS",
    "OPTIO_GITLAB_HOSTS",
    "GITHUB_HOSTS",
    "OPTIO_GITHUB_HOSTS",
  ).includes(h);
}

/**
 * May the API attach the deployment's git token to API calls for this repo?
 * The API host comes from the repo / PR URL — any host other than
 * github.com is taken for GitHub Enterprise (`https://<host>/api/v3`), any
 * host containing "gitlab" for GitLab — and those URLs reach here from people
 * (ad-hoc tasks, `/api/pull-requests/status?prUrl=`) and from agents (the PR
 * URL an agent printed). Only built-in or deployment-configured hosts get
 * tokens. Workspace admins may register repositories, but registration is
 * not permission to receive deployment credentials. CodeCommit is reached
 * through the AWS SDK by region, never by the URL's host.
 */
export async function isTrustedGitHost(
  ri: Pick<RepoIdentifier, "host" | "platform">,
): Promise<boolean> {
  if (ri.platform === "codecommit") return true;
  return isListedGitHost(ri.host) || (ri.platform === "gitlab" && !!runtimeGitLabInstance(ri.host));
}

/** The saved platform for an added repo on an otherwise unknown host. */
async function recordedRepoPlatform(
  repoUrl: string,
  workspaceId?: string | null,
): Promise<string | null> {
  const ri = parseRepoUrl(repoUrl);
  if (!ri || knownHostPlatform(ri.host)) return null;
  try {
    const [row] = await db
      .select({ gitPlatform: repos.gitPlatform })
      .from(repos)
      .where(
        and(
          eq(repos.repoUrl, normalizeRepoUrl(repoUrl)),
          workspaceId ? eq(repos.workspaceId, workspaceId) : isNull(repos.workspaceId),
        ),
      )
      .limit(1);
    return row?.gitPlatform ?? null;
  } catch {
    return null;
  }
}

/** Parse the repository and resolve credentials in the caller's scope. */
export async function getGitPlatformForRepo(
  repoUrl: string,
  context: GitTokenContext & {
    platformHint?: GitPlatformType;
  },
): Promise<{ platform: GitPlatform; ri: RepoIdentifier; token: string }> {
  if (parseRepoUrl(repoUrl)?.host !== "github.com") await refreshGitLabInstances().catch(() => {});
  const { platformHint, ...tokenContext } = context;
  const platformType = resolveRepoPlatform(
    repoUrl,
    platformHint ?? (await recordedRepoPlatform(repoUrl, context.workspaceId)),
  );
  const ri = platformType ? parseRepoUrl(repoUrl, platformType) : null;
  if (!ri) throw new Error(`Cannot parse repo URL: ${repoUrl}`);

  if (!(await isTrustedGitHost(ri))) {
    throw new Error(
      `Refusing to send git credentials to ${ri.host}: a deployment operator must list ` +
        "the host in GITHUB_HOSTS / GITLAB_HOSTS",
    );
  }

  const token = await getGitToken(
    ri.platform,
    ri.platform === "gitlab" ? { ...tokenContext, host: ri.host } : tokenContext,
  );
  const platform = createGitPlatform(ri.platform, token);

  return { platform, ri, token };
}
