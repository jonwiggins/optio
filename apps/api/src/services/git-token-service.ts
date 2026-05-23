import type { GitPlatform, GitPlatformType, RepoIdentifier } from "@optio/shared";
import { parseRepoUrl } from "@optio/shared";
import { getGitHubToken } from "./github-token-service.js";
import { retrieveSecretWithFallback } from "./secret-service.js";
import { getCodeCommitCredentials } from "./codecommit-credential-service.js";
import { createGitPlatform } from "./git-platform/index.js";
import { logger } from "../logger.js";

export interface GitTokenContext {
  userId?: string;
  workspaceId?: string | null;
  server?: boolean;
}

/**
 * Resolve a git platform token for the given platform and context.
 * GitHub: delegates to the existing github-token-service (App → user OAuth → PAT).
 * GitLab: checks GITLAB_TOKEN secret (workspace-scoped → global).
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

  // GitLab: try user-scoped token, then workspace/global GITLAB_TOKEN
  if (context.userId) {
    try {
      return await retrieveSecretWithFallback(
        "GITLAB_USER_ACCESS_TOKEN",
        `user:${context.userId}`,
        context.workspaceId,
      );
    } catch {
      logger.debug({ userId: context.userId }, "No user GitLab token, trying global");
    }
  }

  try {
    return await retrieveSecretWithFallback("GITLAB_TOKEN", "global", context.workspaceId);
  } catch {
    // Fall back to env var
    const envToken = process.env.GITLAB_TOKEN;
    if (envToken) return envToken;
    throw new Error(
      "No GitLab token available. Add a GITLAB_TOKEN secret or set the GITLAB_TOKEN environment variable.",
    );
  }
}

/**
 * Parse a repo URL, resolve the appropriate token, and create a GitPlatform instance.
 * This is the primary entry point for consumers that need to interact with a git platform.
 */
export async function getGitPlatformForRepo(
  repoUrl: string,
  context: GitTokenContext & { platformHint?: GitPlatformType },
): Promise<{ platform: GitPlatform; ri: RepoIdentifier }> {
  const ri = parseRepoUrl(repoUrl);
  if (!ri) throw new Error(`Cannot parse repo URL: ${repoUrl}`);

  // Allow callers with a repo record to skip URL-based platform detection
  if (context.platformHint) ri.platform = context.platformHint;

  const token = await getGitToken(ri.platform, context);
  const platform = createGitPlatform(ri.platform, token);

  return { platform, ri };
}
