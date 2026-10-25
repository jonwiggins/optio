import { featureFilter, type DeploymentFeatures } from "@optio/shared";

/** The third-party trackers the setup wizard's Tickets step can add, in its order. */
export const SETUP_TRACKER_SOURCES = ["linear", "notion", "jira"] as const;
export type SetupTrackerSource = (typeof SETUP_TRACKER_SOURCES)[number];

/** The trackers the deployment feature lists offer (OPTIO_TICKET_SOURCES). */
export function setupTrackerSources(features: DeploymentFeatures): SetupTrackerSource[] {
  return featureFilter("ticketSources", SETUP_TRACKER_SOURCES, features);
}

/**
 * Where a GitLab Issues ticket provider for a repo URL looks (the API's
 * gitlab config: `host` + `projectPath`, groups included); null for a
 * GitHub URL or one that isn't a project URL.
 */
export function gitLabIssuesProject(url: string): { host: string; projectPath: string } | null {
  const trimmed = url.trim();
  let host = "";
  let path = "";
  const ssh = trimmed.match(/^[^@\s/]+@([^:\s/]+):(.+)$/);
  if (ssh) {
    host = ssh[1];
    path = ssh[2];
  } else {
    try {
      const u = new URL(/^[a-z+]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
      host = u.host;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  const projectPath = path
    .replace(/^\/+/, "")
    .replace(/\/-\/.*$/, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
  if (!host || /(^|\.)github\.com$/i.test(host) || !projectPath.includes("/")) return null;
  return { host: host.toLowerCase(), projectPath };
}

/**
 * Where a GitLab Issues provider for a repo the wizard added looks, when the
 * repo is a GitLab project: on gitlab.com, on the GitLab host from the Git
 * step, or on a host named "gitlab" — or, where the deployment offers no
 * GitHub, any non-GitHub repo. Null otherwise (a GitHub Enterprise repo, say).
 */
export function gitLabIssuesRepo(
  url: string,
  gitlabHost: string,
  githubOffered: boolean,
): { host: string; projectPath: string } | null {
  const project = gitLabIssuesProject(url);
  if (!project) return null;
  if (!githubOffered) return project;
  const named = gitlabHost
    .trim()
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  const hostname = project.host.replace(/:\d+$/, "");
  const isGitLab =
    project.host === named ||
    hostname === named ||
    hostname === "gitlab.com" ||
    hostname.includes("gitlab");
  return isGitLab ? project : null;
}
