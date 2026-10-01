import { createHash } from "node:crypto";

/**
 * Browse the GitHub repositories the server's stored credentials can reach,
 * for the "Add repository" picker. Works with both kinds of server token
 * `getGitHubToken({ server: true })` hands out:
 *
 * - a GitHub App installation token (`ghs_…`) → `/installation/repositories`
 *   (every repo the installation was granted, org repos included);
 * - a PAT / user token → `/user/repos` with owner, collaborator and
 *   organization-member affiliation.
 *
 * GitHub has no "search the repos I can access" endpoint, so a search scans
 * up to {@link MAX_SCAN_PAGES} pages of 100 and filters by name/description,
 * cached briefly so typing doesn't re-scan on every keystroke.
 */

export interface BrowsableRepo {
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  description: string | null;
  pushedAt: string | null;
}

export interface BrowseResult {
  repos: BrowsableRepo[];
  hasMore: boolean;
  /** A search only looked at the first MAX_SCAN_PAGES × 100 repos. */
  truncated?: boolean;
}

const MAX_SCAN_PAGES = 10;
const SCAN_PAGE_SIZE = 100;
const SCAN_CACHE_TTL_MS = 60_000;
const SCAN_CACHE_MAX = 20;

type RepoItem = {
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  description: string | null;
  pushed_at: string | null;
};

const scanCache = new Map<string, { at: number; repos: BrowsableRepo[]; truncated: boolean }>();

/** Exported for tests. */
export function resetRepoBrowseCache(): void {
  scanCache.clear();
}

function isInstallationToken(token: string): boolean {
  return token.startsWith("ghs_");
}

function listUrl(token: string, page: number, perPage: number): string {
  const paging = `per_page=${perPage}&page=${page}`;
  return isInstallationToken(token)
    ? `https://api.github.com/installation/repositories?${paging}`
    : `https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&${paging}`;
}

function toRepo(r: RepoItem): BrowsableRepo {
  return {
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    htmlUrl: r.html_url,
    defaultBranch: r.default_branch,
    isPrivate: r.private,
    description: r.description ?? null,
    pushedAt: r.pushed_at ?? null,
  };
}

async function fetchPage(
  token: string,
  page: number,
  perPage: number,
): Promise<{ repos: BrowsableRepo[]; hasNext: boolean }> {
  const res = await fetch(listUrl(token, page, perPage), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Optio",
    },
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const json = (await res.json()) as RepoItem[] | { repositories: RepoItem[] };
  const items = Array.isArray(json) ? json : (json.repositories ?? []);
  const link = res.headers?.get?.("link") ?? "";
  return { repos: items.map(toRepo), hasNext: /rel="next"/.test(link) };
}

async function scanAll(token: string): Promise<{ repos: BrowsableRepo[]; truncated: boolean }> {
  const key = createHash("sha256").update(token).digest("hex");
  const hit = scanCache.get(key);
  if (hit && Date.now() - hit.at < SCAN_CACHE_TTL_MS) return hit;

  const repos: BrowsableRepo[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_SCAN_PAGES; page++) {
    const { repos: batch, hasNext } = await fetchPage(token, page, SCAN_PAGE_SIZE);
    repos.push(...batch);
    if (!hasNext || batch.length < SCAN_PAGE_SIZE) break;
    if (page === MAX_SCAN_PAGES) truncated = true;
  }
  if (scanCache.size >= SCAN_CACHE_MAX) {
    const oldest = scanCache.keys().next().value;
    if (oldest) scanCache.delete(oldest);
  }
  const entry = { at: Date.now(), repos, truncated };
  scanCache.set(key, entry);
  return entry;
}

export async function browseGitHubRepos(
  token: string,
  opts: { q?: string; page?: number; perPage?: number } = {},
): Promise<BrowseResult> {
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.min(100, Math.max(1, opts.perPage ?? 30));
  const q = opts.q?.trim().toLowerCase();

  if (!q) {
    const { repos, hasNext } = await fetchPage(token, page, perPage);
    return { repos, hasMore: hasNext };
  }

  const { repos, truncated } = await scanAll(token);
  const matches = repos.filter(
    (r) => r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q),
  );
  const start = (page - 1) * perPage;
  return {
    repos: matches.slice(start, start + perPage),
    hasMore: matches.length > start + perPage,
    ...(truncated ? { truncated } : {}),
  };
}
