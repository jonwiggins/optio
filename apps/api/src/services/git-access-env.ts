import { createHash } from "node:crypto";
import { refreshGitLabInstances } from "./gitlab-instance-service.js";
import { runtimeGitLabInstance } from "./gitlab-instance-runtime.js";
import type { GitPlatformType } from "@optio/shared";
/**
 * How a pod signs in to git — the same for every pod that clones or pushes: a
 * Repo Task, a review, a persistent agent with a repo.
 *
 * Repo pods use Optio's credential helper (a GitHub App installation token
 * from /api/internal/git-credentials, signed with an owner/workspace-derived
 * key). Persistent agents use a short-lived installation token. Without a GitHub App, both use the workspace's GitHub / GitLab
 * tokens.
 */
import {
  gitCredentialScope,
  gitCredentialKey,
  installationRepoFor,
} from "./git-credential-scope.js";
import { getInstallationToken, isGitHubAppConfigured } from "./github-app-service.js";
import { retrieveSecretWithFallback } from "./secret-service.js";
import { parseRepoUrl } from "@optio/shared";
import { getGitToken, isTrustedGitHost } from "./git-token-service.js";

export function requiredGitTokenSecret(platform: GitPlatformType | undefined): string | null {
  // Host-scoped secrets and API environment fallback are resolved best effort
  // below/the signed helper; requiring plain GITLAB_TOKEN breaks both setups.
  if (platform === "gitlab") return null;
  return isGitHubAppConfigured() ? null : "GITHUB_TOKEN";
}

const apiInternalUrl = () =>
  process.env.OPTIO_API_INTERNAL_URL ?? `http://localhost:${process.env.API_PORT ?? "4000"}`;

/** Setup-secret merges must not restore credentials for an unapproved destination. */
export async function restrictGitCredentialsToRepo(
  env: Record<string, string>,
  repoUrl: string | null,
): Promise<boolean> {
  if (!repoUrl) return true;
  const repo = parseRepoUrl(repoUrl);
  if (repo && (await isTrustedGitHost(repo))) return true;
  for (const key of [
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "GITLAB_HOST",
    "OPTIO_GIT_CREDENTIAL_URL",
    "OPTIO_GIT_TASK_CREDENTIAL_URL",
    "OPTIO_CREDENTIAL_SECRET",
  ])
    delete env[key];
  return false;
}

/**
 * Add git sign-in to a pod's env, in place. A token the env already has (the
 * caller's own pick) wins over the workspace's. `runId` scopes the per-run
 * credential URL (user-scoped git operations at exec time); `helper: false`
 * signs in with a token instead of the credential helper. `repoUrl` is the
 * one repo the pod works in: every GitHub App installation token it gets is
 * limited to that repo (null: a pod with no repo — the installation's).
 */
export async function applyGitAccess(
  env: Record<string, string>,
  opts: {
    workspaceId: string | null;
    ownerUserId?: string | null;
    repoUrl: string | null;
    runId?: string;
    helper?: boolean;
  },
): Promise<void> {
  if (opts.repoUrl && parseRepoUrl(opts.repoUrl)?.host !== "github.com")
    await refreshGitLabInstances().catch(() => {});
  if (!(await restrictGitCredentialsToRepo(env, opts.repoUrl))) return;
  const repo = opts.repoUrl ? parseRepoUrl(opts.repoUrl) : null;
  if (repo?.platform === "gitlab" && !env.GITLAB_TOKEN) {
    const token = await getGitToken("gitlab", {
      workspaceId: opts.workspaceId,
      userId: opts.ownerUserId ?? undefined,
      host: repo.host,
    }).catch(() => null);
    if (token) {
      env.GITLAB_TOKEN = token;
      // This token was resolved for one repository host. The shell fallback
      // must not offer it to other operator-listed hosts if the API is down.
      env.GITLAB_HOST = repo.host;
      env.GITLAB_HOSTS = repo.host;
    }
  }
  for (const name of [
    "GITHUB_TOKEN",
    ...(repo?.platform === "gitlab" ? [] : ["GITLAB_TOKEN"]),
    "GITLAB_HOST",
  ]) {
    if (env[name]) continue;
    const value = await retrieveSecretWithFallback(
      name,
      "global",
      opts.workspaceId,
      opts.ownerUserId,
    ).catch(() => null);
    if (value) env[name] = value;
  }
  // A registered instance (docs/gitlab-instances.md): its API base and CA for
  // repo-init.sh, git and glab. Its token is the one resolved above (or the
  // caller's own); a missing token leaves the run to the credential helper.
  const instance = repo?.platform === "gitlab" ? runtimeGitLabInstance(repo.host) : null;
  if (instance && repo) {
    env.GITLAB_HOST = repo.host;
    env.OPTIO_GITLAB_BASE_URL = instance.baseUrl;
    if (instance.caPem) {
      env.OPTIO_GITLAB_CA_PEM = instance.caPem;
      const digest = createHash("sha256")
        .update(instance.baseUrl + instance.caPem)
        .digest("hex");
      env.OPTIO_GITLAB_CA_FILE = `/home/agent/.config/optio/gitlab/${digest}.pem`;
    }
  }
  if (opts.helper === false) {
    // A turn's installation token (an hour) rather than a long-lived one,
    // limited to the turn's repo; none for a repo that isn't on GitHub.
    if (isGitHubAppConfigured()) {
      const repo = opts.repoUrl ? installationRepoFor(opts.repoUrl) : null;
      if (repo) env.GITHUB_TOKEN = await getInstallationToken(repo);
      else if (!opts.repoUrl) env.GITHUB_TOKEN = await getInstallationToken();
    }
    return;
  }
  const scope = gitCredentialScope({
    workspaceId: opts.workspaceId,
    ownerUserId: opts.ownerUserId ?? null,
    repoUrl: opts.repoUrl,
  });
  const base = `${apiInternalUrl()}/api/internal/git-credentials?scope=${scope}`;
  // Pod-level: repo-init.sh's clone with the installation token.
  env.OPTIO_GIT_CREDENTIAL_URL = base;
  // Run-level: injected at exec time for user-scoped git operations.
  if (opts.runId) env.OPTIO_GIT_TASK_CREDENTIAL_URL = base;
  env.OPTIO_CREDENTIAL_SECRET = gitCredentialKey(scope);
  // With a GitHub App the helper mints tokens; a static one would only leak.
  if (isGitHubAppConfigured()) delete env.GITHUB_TOKEN;
}
