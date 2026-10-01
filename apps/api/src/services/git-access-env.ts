/**
 * How a pod signs in to git — the same for every pod that clones or pushes: a
 * Repo Task, a review, a persistent agent with a repo.
 *
 * Repo pods use Optio's credential helper (a GitHub App installation token
 * from /api/internal/git-credentials, signed with the shared credential
 * secret; per run, the run's user token). A persistent agent's pod gets no
 * helper: the secret could sign a request for any run's token, and an agent
 * is message-driven, so its turn gets a short-lived installation token
 * instead. Without a GitHub App, both use the workspace's GitHub / GitLab
 * tokens.
 */
import { getCredentialSecret } from "./credential-secret-service.js";
import { getInstallationToken, isGitHubAppConfigured } from "./github-app-service.js";
import { retrieveSecretWithFallback } from "./secret-service.js";

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
  opts: { workspaceId: string | null; runId?: string; helper?: boolean },
): Promise<void> {
  for (const name of ["GITHUB_TOKEN", "GITLAB_TOKEN", "GITLAB_HOST"]) {
    if (env[name]) continue;
    const value = await retrieveSecretWithFallback(name, "global", opts.workspaceId).catch(
      () => null,
    );
    if (value) env[name] = value;
  }
  if (opts.helper === false) {
    // A turn's installation token (an hour) rather than a long-lived one.
    if (isGitHubAppConfigured()) env.GITHUB_TOKEN = await getInstallationToken();
    return;
  }
  const base = `${apiInternalUrl()}/api/internal/git-credentials`;
  // Pod-level: repo-init.sh's clone with the installation token.
  env.OPTIO_GIT_CREDENTIAL_URL = base;
  // Run-level: injected at exec time for user-scoped git operations.
  if (opts.runId) env.OPTIO_GIT_TASK_CREDENTIAL_URL = `${base}?taskId=${opts.runId}`;
  env.OPTIO_CREDENTIAL_SECRET = getCredentialSecret();
  // With a GitHub App the helper mints tokens; a static one would only leak.
  if (isGitHubAppConfigured()) delete env.GITHUB_TOKEN;
}
