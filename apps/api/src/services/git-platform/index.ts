import type { GitPlatform, GitPlatformType } from "@optio/shared";
import { GitHubPlatform } from "./github.js";
import { GitLabPlatform } from "./gitlab.js";
import { CodeCommitPlatform } from "./codecommit.js";

export function createGitPlatform(platform: GitPlatformType, token: string): GitPlatform {
  switch (platform) {
    case "github":
      return new GitHubPlatform(token);
    case "gitlab":
      return new GitLabPlatform(token);
    case "codecommit":
      return new CodeCommitPlatform(token);
    default:
      throw new Error(`Unsupported git platform: ${platform}`);
  }
}

export { GitHubPlatform } from "./github.js";
export { GitLabPlatform } from "./gitlab.js";
export { CodeCommitPlatform } from "./codecommit.js";
