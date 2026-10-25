import { gitlabOnlyDeployment, type DeploymentFeatures } from "../config/features.js";

/**
 * What a change request's label is decided by, besides its URL: the repo's
 * platform when known (repos.git_platform, resolveRepoPlatform), and the
 * deployment's features (one that offers GitLab and not GitHub opens merge
 * requests only).
 */
export interface ChangeRequestContext {
  platform?: string | null;
  features?: DeploymentFeatures;
}

/**
 * Whether a change request is a GitLab merge request ("MR", `!12`) rather
 * than a pull request ("PR", `#12`). The URL decides once there is one
 * (`/merge_requests/N`, whatever the host is called); before that the repo's
 * platform, else the deployment.
 */
export function isMergeRequest(prUrl: unknown, ctx: ChangeRequestContext = {}): boolean {
  if (typeof prUrl === "string" && prUrl) return /\/merge_requests\/\d+/.test(prUrl);
  if (ctx.platform) return ctx.platform === "gitlab";
  return gitlabOnlyDeployment(ctx.features);
}

/** "MR" or "PR", for a short label. */
export function changeRequestAbbrev(prUrl: unknown, ctx: ChangeRequestContext = {}): "MR" | "PR" {
  return isMergeRequest(prUrl, ctx) ? "MR" : "PR";
}

/** `!12` for a merge request, `#12` for a pull request. */
export function changeRequestRef(
  prNumber: number | string,
  prUrl: unknown,
  ctx: ChangeRequestContext = {},
): string {
  return `${isMergeRequest(prUrl, ctx) ? "!" : "#"}${prNumber}`;
}

/** The platform a change request lives on, by name ("View on GitLab"). */
export function changeRequestHost(
  prUrl: unknown,
  ctx: ChangeRequestContext = {},
): "GitLab" | "GitHub" | "CodeCommit" {
  if (typeof prUrl === "string" && /codecommit/i.test(prUrl)) return "CodeCommit";
  if (!(typeof prUrl === "string" && prUrl) && ctx.platform === "codecommit") return "CodeCommit";
  return isMergeRequest(prUrl, ctx) ? "GitLab" : "GitHub";
}
