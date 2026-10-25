/**
 * How a pod signs in to git — the same for every pod that clones or pushes: a
 * Repo Task, a review, a persistent agent with a repo.
 *
 * Repo pods use Optio's credential helper (a GitHub App installation token
 * from /api/internal/git-credentials, signed with an owner/workspace-derived
 * key). Persistent agents use a short-lived installation token. Without a GitHub App, both use the workspace's GitHub / GitLab
 * tokens.
 */
import { createHash } from "node:crypto";
import { runtimeGitLabInstance } from "./gitlab-instance-runtime.js";
import { refreshGitLabInstances } from "./gitlab-instance-service.js";
import { gitlabOnlyDeployment, parseRepoUrl, type GitPlatformType } from "@optio/shared";
import { gitCredentialScope, gitCredentialKey } from "./git-credential-scope.js";
import { getInstallationToken, isGitHubAppConfigured } from "./github-app-service.js";
import { retrieveSecretWithFallback } from "./secret-service.js";

/**
 * The git token a repo's work must have before its pod starts: GitLab's for a
 * GitLab repo (gitlab.com or a GITLAB_HOSTS host), GitHub's otherwise — unless
 * a GitHub App mints installation tokens, which leaves none to require.
 */
export function requiredGitTokenSecret(platform: GitPlatformType | undefined): string | null {
  // A deployment that offers GitLab and not GitHub has every repo on its GitLab.
  if (platform === "gitlab" || gitlabOnlyDeployment()) return "GITLAB_TOKEN";
  return isGitHubAppConfigured() ? null : "GITHUB_TOKEN";
}

const apiInternalUrl = () =>
  process.env.OPTIO_API_INTERNAL_URL ?? `http://localhost:${process.env.API_PORT ?? "4000"}`;

/**
 * Add git sign-in to a pod's env, in place. A token the env already has (the
 * caller's own pick) wins over the workspace's. `runId` scopes the per-run
 * credential URL (user-scoped git operations at exec time); `helper: false`
 * signs in with a token instead of the credential helper.
 */
export async function applyGitAccess(
  env: Record<string, string>,
  opts: {
    workspaceId: string | null;
    repoUrl?: string;
    ownerUserId?: string | null;
    /** A team's work: the team's token is tried instead of the person's (docs/teams.md). */
    ownerTeamId?: string | null;
    runId?: string;
    helper?: boolean;
  },
): Promise<void> {
  const suppliedGitLabToken = env.GITLAB_TOKEN;
  for (const name of ["GITHUB_TOKEN", "GITLAB_TOKEN", "GITLAB_HOST"]) {
    if (env[name]) continue;
    const value = await retrieveSecretWithFallback(
      name,
      "global",
      opts.workspaceId,
      opts.ownerUserId,
      opts.ownerTeamId,
    ).catch(() => null);
    if (value) env[name] = value;
  }
  const repoUrl = opts.repoUrl ?? env.OPTIO_REPO_URL;
  if (repoUrl) {
    await refreshGitLabInstances().catch(() => {});
    const ri = parseRepoUrl(repoUrl);
    const instance = ri ? runtimeGitLabInstance(ri.host) : null;
    if (instance && ri) {
      const { getGitToken } = await import("./git-token-service.js");
      env.GITLAB_TOKEN =
        suppliedGitLabToken ||
        (await getGitToken("gitlab", {
          userId: opts.ownerUserId ?? undefined,
          ownerTeamId: opts.ownerTeamId,
          workspaceId: opts.workspaceId,
          host: ri.host,
        }));
      env.GITLAB_HOST = ri.host;
      env.OPTIO_GITLAB_BASE_URL = instance.baseUrl;
      if (instance.caPem) {
        env.OPTIO_GITLAB_CA_PEM = instance.caPem;
        const digest = createHash("sha256")
          .update(instance.baseUrl + instance.caPem)
          .digest("hex");
        env.OPTIO_GITLAB_CA_FILE = `/home/agent/.config/optio/gitlab/${digest}.pem`;
      }
    }
  }
  if (opts.helper === false) {
    // A turn's installation token (an hour) rather than a long-lived one.
    if (isGitHubAppConfigured()) env.GITHUB_TOKEN = await getInstallationToken();
    return;
  }
  const scope = gitCredentialScope({
    workspaceId: opts.workspaceId,
    ownerUserId: opts.ownerUserId ?? null,
    ownerTeamId: opts.ownerTeamId ?? null,
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
