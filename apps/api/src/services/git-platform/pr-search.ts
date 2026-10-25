import type { Branch, PullRequest } from "@optio/shared";

/**
 * The one meaning of `search` on `listOpenPullRequests`, shared by the
 * platforms: a case-insensitive "contains" over the PR's number, title,
 * body, head branch and author. A query of just a number (with or without a
 * `#` / `!` prefix) matches that number exactly, so `12` finds `!12` and not
 * `!112` or `!120`.
 */
export function pullRequestMatches(pr: PullRequest, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const number = pullRequestNumberOf(q);
  if (number !== null) return pr.number === number;
  return [pr.title, pr.body, pr.headBranch ?? "", pr.author, String(pr.number)].some((field) =>
    field.toLowerCase().includes(q),
  );
}

/** `12`, `#12` or `!12` → 12; anything else → null. */
export function pullRequestNumberOf(search: string): number | null {
  const m = search.trim().match(/^[#!]?(\d{1,9})$/);
  return m ? Number(m[1]) : null;
}

/** `prs` narrowed to `search`, in the order given. */
export function filterPullRequests(prs: PullRequest[], search?: string): PullRequest[] {
  const q = search?.trim();
  return q ? prs.filter((pr) => pullRequestMatches(pr, q)) : prs;
}

/** Open PRs by `updatedAt`, newest first, without duplicates (by url). */
export function uniqueNewestFirst(prs: PullRequest[]): PullRequest[] {
  const seen = new Set<string>();
  const out: PullRequest[] = [];
  for (const pr of prs) {
    const key = pr.url || String(pr.number);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pr);
  }
  return out.sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));
}

/** `branches` with the default branch first, the rest in their given order. */
export function defaultBranchFirst(branches: Branch[]): Branch[] {
  return [...branches.filter((b) => b.default), ...branches.filter((b) => !b.default)];
}

/** `branches` whose name contains `search` (case-insensitive), all when blank. */
export function filterBranches(branches: Branch[], search?: string): Branch[] {
  const q = search?.trim().toLowerCase();
  return q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches;
}
