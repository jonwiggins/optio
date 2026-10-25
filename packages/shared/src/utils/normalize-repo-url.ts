import { gitLabInstanceForHost } from "./gitlab-instances.js";

/**
 * Normalizes a git repository URL to a canonical HTTPS form.
 *
 * Handles common permutations:
 *   - https://github.com/foo/bar.git
 *   - https://github.com/foo/bar
 *   - https://github.com/foo/bar/
 *   - git@github.com:foo/bar.git
 *   - ssh://git@github.com/foo/bar
 *   - ssh://git@github.com:22/foo/bar.git
 *   - github.com/foo/bar
 *   - http://github.com/foo/bar
 *   - HTTPS://GitHub.com/Foo/Bar
 *
 * Canonical form: https://github.com/foo/bar (lowercase host, no trailing slash, no .git)
 */
export function normalizeRepoUrl(url: string): string {
  let u = url.trim();

  // SSH shorthand: git@host:owner/repo.git → https://host/owner/repo
  const sshShorthand = u.match(/^[\w-]+@([^:]+):(.+)$/);
  if (sshShorthand) {
    u = `https://${sshShorthand[1]}/${sshShorthand[2]}`;
  }

  // ssh://git@host(:port)/owner/repo → https://host/owner/repo
  const sshProto = u.match(/^ssh:\/\/[^@]+@([^:/]+)(?::\d+)?\/(.+)$/);
  if (sshProto) {
    u = `https://${sshProto[1]}/${sshProto[2]}`;
  }

  // http:// or HTTPS:// → https://
  u = u.replace(/^https?:\/\//i, "https://");

  // Add https:// if missing (e.g. "github.com/foo/bar")
  if (!u.startsWith("https://")) {
    u = `https://${u}`;
  }

  // Strip trailing slashes, then .git suffix (order matters for "foo.git/")
  u = u.replace(/\/+$/, "");
  u = u.replace(/\.git$/, "");
  u = u.replace(/\/+$/, "");

  // An explicitly configured GitLab installation may have a case-sensitive URL root.
  try {
    const parsed = new URL(u);
    if (gitLabInstanceForHost(parsed.host)) return `${parsed.origin}${parsed.pathname}`;
  } catch {
    /* Keep the existing normalization of unrecognized URLs. */
  }

  // GitHub is case-insensitive for owner/repo, so lowercase everything for matching
  u = u.toLowerCase();

  // Strip trailing slash again (URL parsing may re-add it)
  u = u.replace(/\/+$/, "");

  return u;
}
