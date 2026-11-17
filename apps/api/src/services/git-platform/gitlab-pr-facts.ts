import {
  extractMentions,
  type PrChecks,
  type PrCommentFact,
  type PrFacts,
  type PrMergeState,
  type PrReviewFact,
  type PrThreadFact,
  type RepoIdentifier,
} from "@optio/shared";
import { guardedFetch } from "../../utils/outbound-url.js";
import { GitLabApiError } from "./gitlab.js";

/**
 * Open merge requests of one GitLab project with what the PR panel needs.
 * GitLab has no single query for it: the list, then per MR its reviewers,
 * discussions, newest commit and (when the pipeline failed) its failed jobs,
 * a few MRs at a time.
 */

const CONCURRENCY = 4;

export async function fetchGitLabPrFacts(
  ri: RepoIdentifier,
  token: string,
  opts: { max?: number } = {},
): Promise<PrFacts[]> {
  const max = Math.min(opts.max ?? 40, 100);
  const project = `${ri.apiBaseUrl}/projects/${encodeURIComponent(`${ri.owner}/${ri.repo}`)}`;
  const get = async <T>(path: string, optional = false): Promise<T | null> => {
    const res = await guardedFetch(`${project}${path}`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "Optio" },
      redirect: "error",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (optional && (res.status === 404 || res.status === 403)) return null;
      throw GitLabApiError.fromResponse(res, body);
    }
    return (await res.json()) as T;
  };

  const list =
    (await get<any[]>(
      `/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=${max}`,
    )) ?? [];

  const out: PrFacts[] = new Array(list.length);
  let next = 0;
  const work = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await factsFor(list[i]);
    }
  };

  async function factsFor(mr: any): Promise<PrFacts> {
    const iid = mr.iid;
    const [detail, reviewers, discussions, commits] = await Promise.all([
      get<any>(`/merge_requests/${iid}`),
      get<any[]>(`/merge_requests/${iid}/reviewers`, true),
      get<any[]>(`/merge_requests/${iid}/discussions?per_page=100`, true),
      get<any[]>(`/merge_requests/${iid}/commits?per_page=1`, true),
    ]);
    const pipeline = detail?.head_pipeline ?? null;
    let failingChecks: string[] = [];
    if (pipeline?.status === "failed" && typeof pipeline.id === "number") {
      const jobs = await get<any[]>(
        `/pipelines/${pipeline.id}/jobs?scope[]=failed&per_page=20`,
        true,
      );
      failingChecks = (jobs ?? []).filter((j) => j.allow_failure !== true).map((j) => j.name);
    }
    return mapGitLabMr({ ...mr, ...(detail ?? {}) }, ri, {
      reviewers: reviewers ?? [],
      discussions: discussions ?? [],
      lastCommitAt: commits?.[0]?.committed_date ?? commits?.[0]?.created_at ?? null,
      failingChecks,
    });
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, work));
  return out.filter(Boolean);
}

const username = (u: any): string => (typeof u?.username === "string" ? u.username : "ghost");

export function mapGitLabMr(
  mr: any,
  ri: RepoIdentifier,
  extra: {
    reviewers: any[];
    discussions: any[];
    lastCommitAt: string | null;
    failingChecks: string[];
  },
): PrFacts {
  const threads: PrThreadFact[] = [];
  const comments: PrCommentFact[] = [];
  const lastNoteBy = new Map<string, string>();
  for (const d of extra.discussions) {
    const notes: any[] = (d?.notes ?? []).filter((n: any) => n && !n.system);
    if (notes.length === 0) continue;
    for (const n of notes) {
      const who = username(n.author).toLowerCase();
      const prev = lastNoteBy.get(who);
      if (!prev || n.created_at > prev) lastNoteBy.set(who, n.created_at);
    }
    const last = notes[notes.length - 1];
    if (notes[0].resolvable) {
      threads.push({
        resolved: notes.every((n) => !n.resolvable || n.resolved),
        participants: [...new Set(notes.map((n) => username(n.author)))],
        lastAuthor: username(last.author),
        lastAt: last.created_at,
        path: notes[0].position?.new_path ?? null,
      });
    } else {
      for (const n of notes) {
        comments.push({
          author: username(n.author),
          at: n.created_at,
          mentions: extractMentions(n.body),
        });
      }
    }
  }
  comments.sort((a, b) => (a.at < b.at ? -1 : 1));

  // Reviewers carry their state (GitLab 16.x+); approvals count as reviews.
  const reviews: PrReviewFact[] = [];
  const requestedReviewers: string[] = [];
  for (const r of extra.reviewers) {
    const who = username(r.user);
    const when = lastNoteBy.get(who.toLowerCase()) ?? mr.updated_at;
    switch (r.state) {
      case "approved":
        reviews.push({ author: who, state: "approved", submittedAt: when });
        break;
      case "requested_changes":
        reviews.push({ author: who, state: "changes_requested", submittedAt: when });
        break;
      case "reviewed":
        reviews.push({ author: who, state: "commented", submittedAt: when });
        break;
      default:
        requestedReviewers.push(who);
    }
  }

  const status: string = mr.detailed_merge_status ?? "";
  const anyChangesRequested = reviews.some((r) => r.state === "changes_requested");
  const approved =
    mr.approved === true || (reviews.some((r) => r.state === "approved") && !anyChangesRequested);

  return {
    url: mr.web_url,
    number: mr.iid,
    title: mr.title ?? "",
    platform: "gitlab",
    repoFullName: `${ri.owner}/${ri.repo}`,
    author: username(mr.author),
    draft: !!(mr.draft ?? mr.work_in_progress),
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    headBranch: mr.source_branch ?? null,
    baseBranch: mr.target_branch ?? null,
    headSha: mr.sha ?? null,
    isFork: !!(
      mr.source_project_id &&
      mr.target_project_id &&
      mr.source_project_id !== mr.target_project_id
    ),
    lastPushAt: extra.lastCommitAt,
    checks: mapPipeline(mr.head_pipeline?.status),
    failingChecks: extra.failingChecks,
    mergeState: mapDetailedMergeStatus(status, mr.has_conflicts),
    reviewDecision: anyChangesRequested
      ? "changes_requested"
      : approved
        ? "approved"
        : extra.reviewers.length > 0
          ? "review_required"
          : "none",
    reviews,
    requestedReviewers,
    requestedTeams: [],
    assignees: (mr.assignees ?? []).map(username),
    threads,
    comments: comments.slice(-20),
    bodyMentions: extractMentions(mr.description),
  };
}

function mapPipeline(status: string | undefined): PrChecks {
  switch (status) {
    case "success":
      return "passing";
    case "failed":
      return "failing";
    case "running":
    case "pending":
    case "created":
    case "preparing":
    case "waiting_for_resource":
    case "scheduled":
      return "pending";
    default:
      return "none";
  }
}

export function mapDetailedMergeStatus(status: string, hasConflicts?: boolean): PrMergeState {
  if (hasConflicts || status === "conflict" || status === "broken_status") return "conflict";
  switch (status) {
    case "need_rebase":
      return "behind";
    case "mergeable":
    case "ci_still_running":
    case "ci_must_pass":
    case "draft_status":
      return "clean";
    case "not_approved":
    case "discussions_not_resolved":
    case "blocked_status":
    case "requested_changes":
    case "jira_association_missing":
    case "external_status_checks":
    case "not_open":
      return "blocked";
    default:
      return "unknown";
  }
}
