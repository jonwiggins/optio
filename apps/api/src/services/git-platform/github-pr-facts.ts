import {
  extractMentions,
  type PrChecks,
  type PrFacts,
  type PrMergeState,
  type PrReviewDecision,
  type PrReviewFact,
  type RepoIdentifier,
} from "@optio/shared";
import { GitHubApiError } from "./github.js";

/**
 * Open PRs of one GitHub repository with everything the PR panel needs —
 * checks rollup, merge state, latest reviews, review threads, recent
 * comments — in one GraphQL query per page of 25 (REST would take five
 * calls per PR).
 */

const PAGE = 25;

const QUERY = `
query PrPanel($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
    pullRequests(states: OPEN, first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url isDraft createdAt updatedAt body additions deletions
        author { login }
        headRefName baseRefName headRefOid isCrossRepository
        mergeable mergeStateStatus reviewDecision
        assignees(first: 10) { nodes { login } }
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Bot { login }
              ... on Mannequin { login }
              ... on Team { combinedSlug }
            }
          }
        }
        latestReviews(first: 20) { nodes { author { login } state submittedAt } }
        reviewThreads(last: 40) {
          nodes {
            isResolved path
            comments(last: 10) { nodes { author { login } createdAt } }
          }
        }
        comments(last: 20) { nodes { author { login } createdAt body } }
        commits(last: 1) {
          nodes {
            commit {
              committedDate
              statusCheckRollup {
                state
                contexts(first: 60) {
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/** `https://api.github.com` → `https://api.github.com/graphql`; GHE `…/api/v3` → `…/api/graphql`. */
export function githubGraphqlUrl(apiBaseUrl: string): string {
  const base = apiBaseUrl.replace(/\/+$/, "");
  return /\/api\/v3$/.test(base) ? base.replace(/\/v3$/, "/graphql") : `${base}/graphql`;
}

export async function fetchGitHubPrFacts(
  ri: RepoIdentifier,
  token: string,
  opts: { max?: number; fetchImpl?: typeof fetch } = {},
): Promise<PrFacts[]> {
  const max = opts.max ?? 100;
  const doFetch = opts.fetchImpl ?? fetch;
  const out: PrFacts[] = [];
  let after: string | null = null;
  while (out.length < max) {
    const res = await doFetch(githubGraphqlUrl(ri.apiBaseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "Optio",
        "Content-Type": "application/json",
        Accept: "application/vnd.github.merge-info-preview+json",
      },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          owner: ri.owner,
          name: ri.repo,
          first: Math.min(PAGE, max - out.length),
          after,
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw GitHubApiError.fromResponse(res, text);
    const json = JSON.parse(text) as { data?: any; errors?: Array<{ message: string }> };
    const conn = json.data?.repository?.pullRequests;
    if (!conn) {
      const msg = json.errors?.map((e) => e.message).join("; ") || "No repository data";
      throw new GitHubApiError(
        res.status === 200 ? 404 : res.status,
        JSON.stringify({ message: msg }),
      );
    }
    const repo = json.data.repository;
    const mergeMethods = (
      [
        ["squash", repo.squashMergeAllowed],
        ["merge", repo.mergeCommitAllowed],
        ["rebase", repo.rebaseMergeAllowed],
      ] as const
    )
      .filter(([, allowed]) => allowed !== false)
      .map(([m]) => m);
    for (const node of conn.nodes ?? []) {
      if (node) out.push({ ...mapGitHubPrNode(node, ri), mergeMethods });
    }
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

const login = (a: any): string => (typeof a?.login === "string" ? a.login : "ghost");

const FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "CANCELLED",
]);

export function mapGitHubPrNode(node: any, ri: RepoIdentifier): PrFacts {
  const commit = node.commits?.nodes?.[0]?.commit;
  const rollup = commit?.statusCheckRollup;
  const contexts: any[] = rollup?.contexts?.nodes ?? [];
  const failingChecks = contexts
    .filter((c) =>
      c?.__typename === "CheckRun"
        ? FAILED_CONCLUSIONS.has(c.conclusion)
        : c?.state === "FAILURE" || c?.state === "ERROR",
    )
    .map((c) => (c.__typename === "CheckRun" ? c.name : c.context))
    .filter(Boolean);

  const reviews: PrReviewFact[] = (node.latestReviews?.nodes ?? [])
    .filter((r: any) => r && r.state !== "PENDING" && r.submittedAt)
    .map((r: any) => ({
      author: login(r.author),
      state:
        (
          {
            APPROVED: "approved",
            CHANGES_REQUESTED: "changes_requested",
            DISMISSED: "dismissed",
          } as Record<string, PrReviewFact["state"]>
        )[r.state] ?? "commented",
      submittedAt: r.submittedAt,
    }));

  const requestedReviewers: string[] = [];
  const requestedTeams: string[] = [];
  for (const rr of node.reviewRequests?.nodes ?? []) {
    const who = rr?.requestedReviewer;
    if (!who) continue;
    if (who.__typename === "Team" && who.combinedSlug) requestedTeams.push(who.combinedSlug);
    else if (who.login) requestedReviewers.push(who.login);
  }

  const threads = (node.reviewThreads?.nodes ?? [])
    .filter((t: any) => t && (t.comments?.nodes?.length ?? 0) > 0)
    .map((t: any) => {
      const cs: any[] = t.comments.nodes;
      const last = cs[cs.length - 1];
      return {
        resolved: !!t.isResolved,
        participants: [...new Set(cs.map((c) => login(c.author)))],
        lastAuthor: login(last.author),
        lastAt: last.createdAt,
        path: t.path ?? null,
      };
    });

  const comments = (node.comments?.nodes ?? []).filter(Boolean).map((c: any) => ({
    author: login(c.author),
    at: c.createdAt,
    mentions: extractMentions(c.body),
  }));

  return {
    url: node.url,
    number: node.number,
    title: node.title ?? "",
    platform: "github",
    repoFullName: `${ri.owner}/${ri.repo}`,
    author: login(node.author),
    draft: !!node.isDraft,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    headBranch: node.headRefName ?? null,
    baseBranch: node.baseRefName ?? null,
    headSha: node.headRefOid ?? null,
    isFork: !!node.isCrossRepository,
    lastPushAt: commit?.committedDate ?? null,
    checks: mapRollup(rollup?.state, failingChecks.length),
    failingChecks,
    mergeState: mapMergeState(node.mergeable, node.mergeStateStatus),
    reviewDecision:
      (
        {
          APPROVED: "approved",
          CHANGES_REQUESTED: "changes_requested",
          REVIEW_REQUIRED: "review_required",
        } as Record<string, PrReviewDecision>
      )[node.reviewDecision] ?? "none",
    reviews,
    requestedReviewers,
    requestedTeams,
    assignees: (node.assignees?.nodes ?? []).map(login),
    threads,
    comments,
    bodyMentions: extractMentions(node.body),
    additions: node.additions ?? undefined,
    deletions: node.deletions ?? undefined,
  };
}

function mapRollup(state: string | undefined, failing: number): PrChecks {
  switch (state) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      // A failed check while others still run is already red.
      return failing > 0 ? "failing" : "pending";
    default:
      return "none";
  }
}

function mapMergeState(mergeable: string | undefined, status: string | undefined): PrMergeState {
  if (mergeable === "CONFLICTING" || status === "DIRTY") return "conflict";
  switch (status) {
    case "BEHIND":
      return "behind";
    case "BLOCKED":
      return "blocked";
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE":
    case "DRAFT":
      return "clean";
    default:
      return mergeable === "MERGEABLE" ? "clean" : "unknown";
  }
}
