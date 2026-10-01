/**
 * How a pod signs in to git: Optio's credential helper (a GitHub App
 * installation token from /api/internal/git-credentials, authenticated by the
 * shared credential secret), else the workspace's GitHub / GitLab tokens. The
 * same for every pod that clones or pushes — a Repo Task, a review, a
 * persistent agent with a repo.
 */
import { getCredentialSecret } from "./credential-secret-service.js";
import { isGitHubAppConfigured } from "./github-app-service.js";
import { retrieveSecretWithFallback } from "./secret-service.js";

const apiInternalUrl = () =>
  process.env.OPTIO_API_INTERNAL_URL ?? `http://localhost:${process.env.API_PORT ?? "4000"}`;

/**
 * The git env for a pod. `runId` scopes the per-run credential URL (user-
 * scoped git operations at exec time); `present` holds what the caller
 * already resolved, so a token it picked wins over the workspace's.
 */
export async function gitAccessEnv(opts: {
  workspaceId: string | null;
  runId?: string;
  present?: Record<string, string>;
}): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const name of ["GITHUB_TOKEN", "GITLAB_TOKEN", "GITLAB_HOST"]) {
    if (opts.present?.[name]) continue;
    const value = await retrieveSecretWithFallback(name, "global", opts.workspaceId).catch(
      () => null,
    );
    if (value) env[name] = value;
  }
  const base = `${apiInternalUrl()}/api/internal/git-credentials`;
  // Pod-level: repo-init.sh's clone with the installation token.
  env.OPTIO_GIT_CREDENTIAL_URL = base;
  // Run-level: injected at exec time for user-scoped git operations.
  if (opts.runId) env.OPTIO_GIT_TASK_CREDENTIAL_URL = `${base}?taskId=${opts.runId}`;
  env.OPTIO_CREDENTIAL_SECRET = getCredentialSecret();
  // With a GitHub App the helper mints tokens; a static one would only leak.
  if (isGitHubAppConfigured()) delete env.GITHUB_TOKEN;
  return env;
}
