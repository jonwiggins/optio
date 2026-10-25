import { parseRepoUrl } from "@optio/shared";

/**
 * A repo URL as a short label: its path on any host (`acme/web`,
 * `group/subgroup/project`), without the scheme, host or `.git`.
 */
export function repoLabel(repoUrl: string | null | undefined): string {
  const url = (repoUrl ?? "").trim();
  if (!url) return "";
  const path = url
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "")
    .replace(/^[\w.-]+@[^:/]+:/, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
  return path || url;
}

/** The `owner/repo` slug Optio records for a repo URL (the namespace path on GitLab). */
export function repoFullName(repoUrl: string, platform?: "github" | "gitlab" | "codecommit") {
  const ri = parseRepoUrl(repoUrl, platform);
  return ri ? `${ri.owner}/${ri.repo}` : repoLabel(repoUrl);
}
