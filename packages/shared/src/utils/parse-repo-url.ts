import type { GitPlatformType, RepoIdentifier } from "../types/git-platform.js";

const GITHUB_HOSTS = new Set(["github.com"]);

/**
 * GITLAB_HOSTS (plural): comma-separated list of all known GitLab hostnames,
 * used for platform detection when parsing repository URLs.
 * Distinct from GITLAB_HOST (singular) which is the specific GitLab host
 * for the current task/auth context (used in scripts and credential helpers).
 */
function getGitLabHosts(): Set<string> {
  const hosts = new Set(["gitlab.com"]);
  const env =
    typeof process !== "undefined"
      ? (process.env.GITLAB_HOSTS ?? process.env.OPTIO_GITLAB_HOSTS)
      : undefined;
  if (env) {
    for (const h of env.split(",")) {
      const trimmed = h.trim().toLowerCase();
      if (trimmed) hosts.add(trimmed);
    }
  }
  return hosts;
}

// CodeCommit Git endpoint: git-codecommit.<region>.amazonaws.com
// Console PR URL: <region>.console.aws.amazon.com/codesuite/codecommit/repositories/<repo>/pull-requests/<id>
const CODECOMMIT_GIT_HOST_RE = /^git-codecommit\.([a-z0-9-]+)\.amazonaws\.com$/i;
const CODECOMMIT_CONSOLE_HOST_RE = /^([a-z0-9-]+)\.console\.aws\.amazon\.com$/i;

/**
 * Extract the AWS region from a CodeCommit hostname.
 * Returns null if the host is not a recognised CodeCommit endpoint.
 */
function extractCodeCommitRegion(host: string): string | null {
  const git = host.match(CODECOMMIT_GIT_HOST_RE);
  if (git) return git[1].toLowerCase();
  const console = host.match(CODECOMMIT_CONSOLE_HOST_RE);
  if (console) return console[1].toLowerCase();
  return null;
}

function detectPlatform(host: string): GitPlatformType {
  const h = host.toLowerCase();
  if (GITHUB_HOSTS.has(h)) return "github";
  if (getGitLabHosts().has(h)) return "gitlab";
  if (extractCodeCommitRegion(h)) return "codecommit";
  // Unknown hosts: check if the hostname contains "gitlab"
  if (h.includes("gitlab")) return "gitlab";
  // Default to github for unknown hosts (most common case)
  return "github";
}

function buildApiBaseUrl(platform: GitPlatformType, host: string): string {
  if (platform === "github") {
    return host.toLowerCase() === "github.com"
      ? "https://api.github.com"
      : `https://${host}/api/v3`; // GitHub Enterprise
  }
  if (platform === "codecommit") {
    // CodeCommit's API endpoint is region-scoped and constructed by the AWS SDK.
    // We store the region here so callers can configure the SDK client.
    return extractCodeCommitRegion(host) ?? "us-east-1";
  }
  return `https://${host}/api/v4`;
}

/**
 * Extracts host + owner/repo path from a git URL.
 * Returns null if the URL cannot be parsed.
 */
function extractParts(url: string): { host: string; path: string } | null {
  let u = url.trim();

  // SSH shorthand: git@host:owner/repo.git
  const sshShorthand = u.match(/^[\w-]+@([^:]+):(.+)$/);
  if (sshShorthand) {
    return { host: sshShorthand[1], path: sshShorthand[2] };
  }

  // ssh://git@host(:port)/owner/repo
  const sshProto = u.match(/^ssh:\/\/[^@]+@([^:/]+)(?::\d+)?\/(.+)$/);
  if (sshProto) {
    return { host: sshProto[1], path: sshProto[2] };
  }

  // Normalize http/https
  u = u.replace(/^https?:\/\//i, "https://");
  if (!u.startsWith("https://")) {
    u = `https://${u}`;
  }

  try {
    const parsed = new URL(u);
    const path = parsed.pathname.replace(/^\//, "");
    if (!path) return null;
    return { host: parsed.hostname, path };
  } catch {
    return null;
  }
}

/**
 * Clean a path segment: strip .git suffix, trailing slashes, and extract
 * owner/repo. For GitLab subgroups the owner includes the full namespace
 * path (e.g. "group/subgroup"), with the last segment as the repo.
 * For GitHub-style URLs, takes the first two segments only.
 * For CodeCommit, the owner field is set by the caller (region from the host).
 */
function cleanOwnerRepo(
  rawPath: string,
  platform: GitPlatformType = "github",
  host = "",
): { owner: string; repo: string } | null {
  let p = rawPath.replace(/\.git\/?$/, "").replace(/\/+$/, "");

  // Strip GitLab path suffixes like /-/... or /merge_requests/...
  if (platform === "gitlab") {
    p = p.replace(/\/?-\/.*$/, "").replace(/\/merge_requests\/.*$/, "");
  }

  // CodeCommit Git path: v1/repos/<RepoName>
  // Console path: codesuite/codecommit/repositories/<RepoName>/...
  if (platform === "codecommit") {
    const region = extractCodeCommitRegion(host) ?? "us-east-1";
    const gitMatch = p.match(/^v1\/repos\/([^/]+)/i);
    if (gitMatch) return { owner: region, repo: gitMatch[1] };
    const consoleMatch = p.match(/^codesuite\/codecommit\/repositories\/([^/]+)/i);
    if (consoleMatch) return { owner: region, repo: consoleMatch[1] };
    return null;
  }

  const parts = p.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  if (platform === "gitlab") {
    // GitLab: last segment is the project, everything before is the namespace
    return { owner: parts.slice(0, -1).join("/"), repo: parts[parts.length - 1] };
  }

  // GitHub: always owner/repo (first two segments)
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Parse a git repository URL into a RepoIdentifier.
 * Detects platform from the host (github.com → github, gitlab.com or GITLAB_HOSTS → gitlab).
 */
export function parseRepoUrl(url: string): RepoIdentifier | null {
  const extracted = extractParts(url);
  if (!extracted) return null;

  const host = extracted.host.toLowerCase();
  const platform = detectPlatform(host);

  const ownerRepo = cleanOwnerRepo(extracted.path, platform, host);
  if (!ownerRepo) return null;

  return {
    platform,
    host,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    apiBaseUrl: buildApiBaseUrl(platform, host),
  };
}

/**
 * Parse a PR/MR URL into a RepoIdentifier plus the PR/MR number.
 * Handles GitHub `/pull/N`, GitLab `/-/merge_requests/N` or `/merge_requests/N`,
 * and CodeCommit console URLs `<region>.console.aws.amazon.com/codesuite/codecommit/repositories/<repo>/pull-requests/<id>`.
 */
export function parsePrUrl(url: string): (RepoIdentifier & { prNumber: number }) | null {
  const extracted = extractParts(url);
  if (!extracted) return null;

  const host = extracted.host.toLowerCase();
  const platform = detectPlatform(host);

  const p = extracted.path.replace(/\.git\/?$/, "").replace(/\/+$/, "");

  // CodeCommit console: codesuite/codecommit/repositories/<repo>/pull-requests/<id>
  if (platform === "codecommit") {
    const ccMatch = p.match(/^codesuite\/codecommit\/repositories\/([^/]+)\/pull-requests\/(\d+)/i);
    if (ccMatch) {
      const region = extractCodeCommitRegion(host) ?? "us-east-1";
      return {
        platform,
        host,
        owner: region,
        repo: ccMatch[1],
        apiBaseUrl: buildApiBaseUrl(platform, host),
        prNumber: parseInt(ccMatch[2], 10),
      };
    }
    return null;
  }

  // GitHub: owner/repo/pull/123
  const ghMatch = p.match(/^([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (ghMatch) {
    return {
      platform,
      host,
      owner: ghMatch[1],
      repo: ghMatch[2],
      apiBaseUrl: buildApiBaseUrl(platform, host),
      prNumber: parseInt(ghMatch[3], 10),
    };
  }

  // GitLab: owner/repo/-/merge_requests/123 or owner/repo/merge_requests/123
  // Also handles subgroups: group/subgroup/repo/-/merge_requests/123
  const glMatch = p.match(/^(.+?)\/([^/]+)\/?-?\/merge_requests\/(\d+)/);
  if (glMatch) {
    return {
      platform,
      host,
      owner: glMatch[1],
      repo: glMatch[2],
      apiBaseUrl: buildApiBaseUrl(platform, host),
      prNumber: parseInt(glMatch[3], 10),
    };
  }

  return null;
}
