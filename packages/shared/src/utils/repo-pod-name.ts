import { parseRepoUrl } from "./parse-repo-url.js";

/**
 * The owner and repo a repo pod's (and StatefulSet's) name is made of.
 *
 * Upstream reads them with one regex, `[/:]([^/]+)\/([^/.]+?)(?:\.git)?$`,
 * whose repo part stops at a dot: `platform/my.service` or
 * `group/sub/my.proj.git` matched nothing and every such repo's pod was
 * named `optio-repo-unknown-unknown-…` (upstream issue #676). GitLab project
 * paths often carry a dot.
 *
 * - A URL the regex already read keeps that answer, so an existing pod or
 *   StatefulSet keeps its name across the upgrade (a renamed StatefulSet
 *   would leave the old one and its volume behind).
 * - Anything else comes from `parseRepoUrl`, which handles dots, `.git`,
 *   SSH and GitLab subgroups: the last namespace segment and the project,
 *   as the regex gives for a subgroup path without a dot.
 * - Neither: `unknown` / `unknown`, as before.
 *
 * The callers sanitize both parts. Kept in its own file so upstream's fix
 * can replace it at a rebase.
 */
const LEGACY = /[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/;

export function repoPodNameParts(repoUrl: string): { owner: string; repo: string } {
  const legacy = repoUrl.match(LEGACY);
  if (legacy) return { owner: legacy[1], repo: legacy[2] };
  const parsed = parseRepoUrl(repoUrl);
  if (parsed && parsed.platform !== "codecommit") {
    const namespace = parsed.owner.split("/").filter(Boolean);
    const owner = namespace[namespace.length - 1];
    if (owner && parsed.repo) return { owner, repo: parsed.repo };
  }
  return { owner: "unknown", repo: "unknown" };
}
