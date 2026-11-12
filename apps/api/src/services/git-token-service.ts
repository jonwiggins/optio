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
import {
  gitLabTokenNameForHost,
  mayUseDeploymentGitLab,
  normalizeGitLabHost,
  workspaceGitLabHosts,
  workspaceGitLabToken,
} from "./workspace-gitlab-service.js";

export interface GitTokenContext {
  userId?: string;
  workspaceId?: string | null;
  server?: boolean;
  /** The GitLab host whose token is being requested. */
  host?: string | null;
}

export { gitLabTokenNameForHost } from "./workspace-gitlab-service.js";

/**
 * Resolve a git platform token for the given platform and context.
 * GitHub: delegates to the existing github-token-service (App → user OAuth → PAT).
 * GitLab: see `getGitLabToken`.
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

  return getGitLabToken(context);
}

/**
 * A GitLab token for `context.host` (else the workspace's default server),
 * first found of:
 *
 *   1. the person's own (`GITLAB_TOKEN_<HOST>`, `GITLAB_TOKEN`, the legacy
 *      `GITLAB_USER_ACCESS_TOKEN`) — not for server operations;
 *   2. the workspace's own, set under Workspace Settings → GitLab — read for
 *      that workspace alone;
 *   3. the deployment's (global secrets, then the API's environment), only
 *      where `mayUseDeploymentGitLab` allows it: callers with no workspace,
 *      the founding workspace, or every workspace with the operator's
 *      OPTIO_GITLAB_SHARE_DEPLOYMENT_CREDENTIALS switch.
 *
 * So one workspace's token never serves another, and the deployment's never
 * overrides a workspace's own.
 */
async function getGitLabToken(context: GitTokenContext): Promise<string> {
  const userId = context.server ? null : (context.userId ?? null);
  const workspaceId = context.workspaceId ?? null;
  const host =
    normalizeGitLabHost(context.host) ?? (await workspaceGitLabHosts(workspaceId))[0] ?? null;
  const hostName = host ? gitLabTokenNameForHost(host) : null;
  const names = hostName ? [hostName, "GITLAB_TOKEN"] : ["GITLAB_TOKEN"];

  const lookups: Array<() => Promise<string | null>> = [];
  if (userId) {
    for (const name of names) {
      lookups.push(() => retrieveSecret(name, "user", undefined, userId));
    }
    lookups.push(() =>
      retrieveSecretWithFallback("GITLAB_USER_ACCESS_TOKEN", `user:${userId}`, workspaceId),
    );
  }
  if (workspaceId && host) {
    lookups.push(() => workspaceGitLabToken(workspaceId, host));
  }
  const deployment = await mayUseDeploymentGitLab(workspaceId);
  if (deployment) {
    for (const name of names) {
      lookups.push(() => retrieveSecretWithFallback(name, "global", workspaceId));
    }
  }
  for (const lookup of lookups) {
    try {
      const token = await lookup();
      if (token) return token;
    } catch {
      // Not at this scope — try the next.
    }
  }
  if (deployment) {
    const envToken = (hostName ? process.env[hostName] : undefined) || process.env.GITLAB_TOKEN;
    if (envToken) return envToken;
  }
  throw new Error(
    workspaceId && !deployment
      ? `No GitLab token for ${host ?? "GitLab"} in this workspace. A workspace admin adds one under Workspace Settings → GitLab.`
      : "No GitLab token available. Add one under Workspace Settings → GitLab, or set the GITLAB_TOKEN environment variable.",
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
  return isListedGitHost(ri.host);
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
