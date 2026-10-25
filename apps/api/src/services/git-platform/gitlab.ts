import { gitLabFetch } from "../gitlab-instance-runtime.js";
import type {
  GitPlatform,
  RepoIdentifier,
  PullRequest,
  CICheck,
  Review,
  InlineComment,
  IssueComment,
  Issue,
  RepoMetadata,
  RepoContent,
  Branch,
  WebhookSpec,
  BrowsableRepository,
  PlatformLocation,
} from "@optio/shared";
import {
  defaultBranchFirst,
  filterPullRequests,
  pullRequestNumberOf,
  uniqueNewestFirst,
} from "./pr-search.js";
import { markReviewsIncomplete } from "../auto-merge-guard.js";
import type { GitHubFailure } from "./github.js";
// GitLab API errors, for the deployment's monitoring (docs/observability.md).
import { recordGitLabApiError } from "../../telemetry/site-metrics.js";

/**
 * A non-2xx answer from GitLab's API, with its HTTP status and the rate-limit
 * headers GitLab sends with it (`Retry-After`, `RateLimit-Remaining`,
 * `RateLimit-Reset`), so a caller can wait as long as GitLab asks.
 */
export class GitLabApiError extends Error {
  readonly retryAfterMs: number | null;
  readonly rateLimitRemaining: number | null;
  readonly rateLimitResetMs: number | null;

  constructor(
    readonly status: number,
    body: string,
    meta: {
      retryAfterMs?: number | null;
      rateLimitRemaining?: number | null;
      rateLimitResetMs?: number | null;
    } = {},
  ) {
    super(`GitLab API error ${status}: ${body}`);
    this.name = "GitLabApiError";
    this.retryAfterMs = meta.retryAfterMs ?? null;
    this.rateLimitRemaining = meta.rateLimitRemaining ?? null;
    this.rateLimitResetMs = meta.rateLimitResetMs ?? null;
  }

  static fromResponse(res: Response, body: string): GitLabApiError {
    const header = (name: string): number | null => {
      const raw = res.headers?.get?.(name);
      if (raw == null || raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const retryAfter = header("retry-after");
    const reset = header("ratelimit-reset");
    return new GitLabApiError(res.status, body, {
      retryAfterMs: retryAfter == null ? null : Math.max(0, retryAfter) * 1000,
      rateLimitRemaining: header("ratelimit-remaining"),
      rateLimitResetMs: reset == null ? null : reset * 1000,
    });
  }
}

/**
 * The failure class of a GitLab error, in the shape GitHub's has
 * (classifyGitHubFailure), or null when it isn't one that waiting fixes or
 * that retrying can't: a 429 is a rate limit (GitLab's limits are per user
 * and endpoint, with `Retry-After`); a 401 is the token, a 403 its scope or
 * the user's role on the project.
 */
export function classifyGitLabFailure(err: unknown): GitHubFailure | null {
  if (!(err instanceof GitLabApiError)) return null;
  if (err.status === 429) {
    // Wait until GitLab's reset time (or its Retry-After from now).
    const resetAtMs =
      err.rateLimitResetMs ?? (err.retryAfterMs != null ? Date.now() + err.retryAfterMs : null);
    return { kind: "primary_rate_limit", retryAfterMs: err.retryAfterMs, resetAtMs };
  }
  if (err.status === 401) return { kind: "auth", retryAfterMs: null, resetAtMs: null };
  if (err.status === 403) return { kind: "permission", retryAfterMs: null, resetAtMs: null };
  return null;
}

/**
 * GitLab won't merge the MR yet: it answered 405/406 and, after polling,
 * still reports the MR as being checked, or as not mergeable. Auto-merge
 * tries again later instead of failing the run (reconcile-executor.ts).
 */
export class GitLabNotReadyError extends Error {
  constructor(readonly mergeStatus: string | undefined) {
    super(`GitLab merge request not ready to merge (${mergeStatus ?? "unknown"})`);
    this.name = "GitLabNotReadyError";
  }
}

/** `detailed_merge_status` values that mean GitLab is still checking the MR. */
const MERGE_STATUS_PENDING = new Set(["unchecked", "checking", "preparing", "approvals_syncing"]);

/** Whether a `PullRequest.mergeStatus` says GitLab is still checking the MR. */
export function mergeStatusPending(status: string | undefined | null): boolean {
  return !!status && MERGE_STATUS_PENDING.has(status);
}

/**
 * `detailed_merge_status` values only a person clears — an approval rule,
 * unresolved threads, a reviewer's requested changes, a blocking MR, a
 * draft, a closed MR, a policy — so automatic merging asks a person at once
 * instead of trying again for minutes. CI states and checks still in
 * progress are not among them: those settle by themselves.
 */
const MERGE_STATUS_NEEDS_PERSON = new Set([
  "not_approved",
  "discussions_not_resolved",
  "requested_changes",
  "blocked_status",
  "merge_request_blocked",
  "draft_status",
  "not_open",
  "jira_association_missing",
  "security_policy_violations",
  "locked_paths",
  "locked_lfs_files",
  "title_regex",
]);

/** Whether a GitLab merge status is one only a person can clear (see above). */
export function mergeStatusNeedsPerson(status: string | undefined | null): boolean {
  return !!status && MERGE_STATUS_NEEDS_PERSON.has(status);
}

/** How long a merge waits for GitLab to finish checking an MR (5 × 2 s). */
const MERGE_STATUS_POLLS = 5;
const MERGE_STATUS_POLL_MS = 2_000;
/** How long a rebase GitLab runs is waited for (15 × 2 s). */
const REBASE_POLLS = 15;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How many pages (of 100) of a thread's newest notes are read. */
const NOTE_PAGES = 3;

/** How many of an issue's newest comments a ticket's prompt carries (as GitHub's one page). */
const ISSUE_COMMENTS = 30;

/** The opening of a note that requests changes (`**Changes Requested:**`, `Changes requested:`). */
const CHANGE_REQUEST = /^\s*(?:\*\*)?\s*changes requested:/i;

/** Whether a note is a "Request changes" review: it opens with "Changes requested:". */
export function isChangeRequest(body: string | null | undefined): boolean {
  return CHANGE_REQUEST.test(body ?? "");
}

function toComment(n: any): IssueComment {
  return {
    author: n.author?.username ?? "unknown",
    body: n.body ?? "",
    createdAt: n.created_at ?? "",
  };
}

/** How long an MR read's head pipeline stands in for a pipeline lookup. */
const HEAD_PIPELINE_TTL_MS = 60_000;

export class GitLabPlatform implements GitPlatform {
  readonly type = "gitlab" as const;
  private readonly token: string;
  /** `<project url>@<sha>` → the head pipeline the last MR read reported for it. */
  private readonly headPipelines = new Map<
    string,
    { at: number; pipeline: { id: number; status?: string } | null }
  >();

  constructor(token: string) {
    this.token = token;
  }

  /**
   * `Authorization: Bearer` takes every kind of GitLab token — personal,
   * project and group access tokens and OAuth access tokens — where
   * `PRIVATE-TOKEN` takes no OAuth token.
   */
  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "Optio",
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private projectId(ri: RepoIdentifier): string {
    return encodeURIComponent(`${ri.owner}/${ri.repo}`);
  }

  private url(ri: RepoIdentifier, path: string): string {
    return `${ri.apiBaseUrl}/projects/${this.projectId(ri)}${path}`;
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await gitLabFetch(url, init);
    if (!res.ok) {
      recordGitLabApiError(url, res.status); // Telemetry/site-metrics.ts
      const body = await res.text().catch(() => "");
      throw GitLabApiError.fromResponse(res, body);
    }
    return (await res.json()) as T;
  }

  // ── PR/MR reads ───────────────────────────────────────────────────────────

  async getPullRequest(ri: RepoIdentifier, number: number): Promise<PullRequest> {
    const data = await this.fetchJson<any>(this.url(ri, `/merge_requests/${number}`), {
      headers: this.headers(),
    });
    this.rememberHeadPipeline(ri, data);
    return mapMr(data, ri, await this.forkPaths(ri, [data]));
  }

  /**
   * `path_with_namespace` of the source project of each MR from a fork
   * (`source_project_id` ≠ `target_project_id`), by project id. A fork the
   * token can't see is left out, and its MR keeps `headRepo` unset.
   */
  private async forkPaths(ri: RepoIdentifier, mrs: any[]): Promise<Map<number, string>> {
    const ids = new Set<number>();
    for (const d of mrs) {
      if (
        d?.source_project_id &&
        d.target_project_id &&
        d.source_project_id !== d.target_project_id
      ) {
        ids.add(d.source_project_id);
      }
    }
    const paths = new Map<number, string>();
    await Promise.all(
      [...ids].map(async (id) => {
        try {
          const project = await this.fetchJson<any>(`${ri.apiBaseUrl}/projects/${id}`, {
            headers: this.headers(),
          });
          if (typeof project?.path_with_namespace === "string") {
            paths.set(id, project.path_with_namespace);
          }
        } catch {
          // Not visible to this token: the MR's head repo stays unknown
        }
      }),
    );
    return paths;
  }

  /**
   * Keep the MR's `head_pipeline` for its head SHA, so the CI read that
   * follows (getCIChecks) uses the pipeline GitLab shows on the MR without
   * asking for it again. GitLab only returns a head pipeline that ran on
   * the MR's current head (its own SHA, or its source SHA for a
   * merged-results pipeline).
   */
  private rememberHeadPipeline(ri: RepoIdentifier, data: any): void {
    const sha = typeof data?.sha === "string" ? data.sha : null;
    if (!sha) return;
    const hp = data.head_pipeline;
    if (this.headPipelines.size > 200) this.headPipelines.clear();
    this.headPipelines.set(`${this.url(ri, "")}@${sha}`, {
      at: Date.now(),
      pipeline: hp && typeof hp.id === "number" ? { id: hp.id, status: hp.status } : null,
    });
  }

  async listOpenPullRequests(
    ri: RepoIdentifier,
    opts?: { branch?: string; perPage?: number; search?: string },
  ): Promise<PullRequest[]> {
    const params = new URLSearchParams({ state: "opened", order_by: "updated_at", sort: "desc" });
    if (opts?.perPage) params.set("per_page", String(opts.perPage));
    if (opts?.branch) params.set("source_branch", opts.branch);
    const search = opts?.search?.trim();
    if (!search) return this.fetchMrs(ri, params);

    // GitLab searches title + description server-side (`search`) and finds
    // one MR by its iid (`iids[]`); a head branch it can only match exactly.
    // So a number is looked up by iid, and words are searched server-side
    // and, for branch / author matches, also over the newest page.
    const iid = pullRequestNumberOf(search);
    if (iid !== null) {
      params.append("iids[]", String(iid));
      return this.fetchMrs(ri, params);
    }
    const searched = new URLSearchParams(params);
    searched.set("search", search);
    const [byText, newest] = await Promise.all([
      this.fetchMrs(ri, searched),
      this.fetchMrs(ri, params),
    ]);
    const matches = filterPullRequests(uniqueNewestFirst([...byText, ...newest]), search);
    return opts?.perPage ? matches.slice(0, opts.perPage) : matches;
  }

  private async fetchMrs(ri: RepoIdentifier, params: URLSearchParams): Promise<PullRequest[]> {
    const data = await this.fetchJson<any[]>(this.url(ri, `/merge_requests?${params}`), {
      headers: this.headers(),
    });
    const forks = await this.forkPaths(ri, data);
    return data.map((d: any) => mapMr(d, ri, forks));
  }

  async findPullRequestsByHeadPrefix(ri: RepoIdentifier, prefix: string): Promise<PullRequest[]> {
    const out: PullRequest[] = [];
    for (let page = 1; page <= 3; page++) {
      const params = new URLSearchParams({
        state: "opened",
        per_page: "100",
        page: String(page),
        order_by: "created_at",
        sort: "desc",
      });
      const data = await this.fetchJson<any[]>(this.url(ri, `/merge_requests?${params}`), {
        headers: this.headers(),
      });
      const matching = data.filter(
        (d: any) => typeof d?.source_branch === "string" && d.source_branch.startsWith(prefix),
      );
      const forks = await this.forkPaths(ri, matching);
      for (const d of matching) out.push(mapMr(d, ri, forks));
      if (data.length < 100) break;
    }
    return out;
  }

  /**
   * The checks of the pipeline GitLab shows on the MR: the MR's own
   * `head_pipeline` when this platform just read the MR at `commitSha` (it
   * covers detached and merged-results pipelines, which run on another SHA),
   * else the newest pipeline for the commit. Its jobs and its trigger jobs
   * (child / multi-project pipelines) are the checks; a job allowed to fail
   * doesn't fail them (GitLab's "passed with warnings"). The pipeline's own
   * status has the last word: a failed or still-running pipeline is never
   * read as passing because of what its job list left out.
   */
  async getCIChecks(ri: RepoIdentifier, commitSha: string): Promise<CICheck[]> {
    const pipeline = await this.pipelineFor(ri, commitSha);
    if (!pipeline) return [];

    const [jobs, bridges] = await Promise.all([
      this.fetchPages(ri, `/pipelines/${pipeline.id}/jobs`),
      // Older GitLab has no bridges API (a 404): its trigger jobs stay out.
      this.fetchPages(ri, `/pipelines/${pipeline.id}/bridges`).catch((err) => {
        if (err instanceof GitLabApiError && err.status === 404) return [];
        throw err;
      }),
    ]);
    const checks: CICheck[] = [...jobs, ...bridges].map((j: any) => ({
      name: j.name ?? "",
      status: mapGitLabJobStatus(j.status),
      conclusion:
        j.allow_failure === true && j.status === "failed"
          ? "skipped"
          : mapGitLabJobConclusion(j.status),
    }));
    const verdict = pipelineVerdict(pipeline, checks);
    return verdict ? [...checks, verdict] : checks;
  }

  /** The pipeline whose checks count for `commitSha` (see getCIChecks). */
  private async pipelineFor(
    ri: RepoIdentifier,
    commitSha: string,
  ): Promise<{ id: number; status?: string } | null> {
    const fromMr = this.headPipelines.get(`${this.url(ri, "")}@${commitSha}`);
    if (fromMr && Date.now() - fromMr.at < HEAD_PIPELINE_TTL_MS && fromMr.pipeline) {
      return fromMr.pipeline;
    }
    const pipelines = await this.fetchJson<any[]>(
      this.url(ri, `/pipelines?sha=${encodeURIComponent(commitSha)}&per_page=5`),
      { headers: this.headers() },
    );
    const newest = pipelines[0];
    return newest && typeof newest.id === "number" ? newest : null;
  }

  /** Every page (100 a page, at most 5) of a list endpoint. */
  private async fetchPages(ri: RepoIdentifier, path: string): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page <= 5; page++) {
      const data = await this.fetchJson<any[]>(this.url(ri, `${path}?per_page=100&page=${page}`), {
        headers: this.headers(),
      });
      out.push(...data);
      if (data.length < 100) break;
    }
    return out;
  }

  async getReviews(ri: RepoIdentifier, prNumber: number): Promise<Review[]> {
    // A read that failed for another reason than "this GitLab has no such
    // API" (404) leaves the list incomplete: automatic merging never goes
    // ahead on it (auto-merge-guard.ts), since a "Request changes" may be
    // what's missing.
    let incomplete = false;
    const notThere = (err: unknown) => err instanceof GitLabApiError && err.status === 404;

    // Fetch approvals
    let approvers: string[] = [];
    try {
      const approvals = await this.fetchJson<any>(
        this.url(ri, `/merge_requests/${prNumber}/approvals`),
        { headers: this.headers() },
      );
      approvers = (approvals.approved_by ?? []).map(
        (a: any) => (a.user?.username as string | undefined) ?? "unknown",
      );
    } catch (err) {
      // Approvals API may not be available on all tiers (a 404 on CE)
      if (!notThere(err)) incomplete = true;
    }

    // The MR's notes, oldest first. A note that opens with "Changes
    // requested:" is the GitLab form of a "Request changes" review (what
    // Optio's review agent and submitReview post; GitLab before 17 has no
    // reviewer state for it) until its thread is resolved. GitLab's
    // "approved this merge request" system notes date each approval, so a
    // reviewer's approval after their own change request supersedes it.
    let notes: any[] = [];
    try {
      notes = await this.mrNotes(ri, prNumber);
    } catch (err) {
      if (!notThere(err)) incomplete = true;
    }
    const approvedAt = new Map<string, string>();
    for (const note of notes) {
      if (note.system && /^approved this merge request/i.test(note.body ?? "")) {
        approvedAt.set(note.author?.username ?? "unknown", note.created_at ?? "");
      }
    }
    const dated: { at: number; review: Review }[] = [];
    const reviews: Review[] = [];
    for (const author of approvers) {
      const review: Review = { author, state: "APPROVED", body: "" };
      const at = Date.parse(approvedAt.get(author) ?? "");
      if (Number.isNaN(at)) reviews.push(review);
      else dated.push({ at, review });
    }
    for (const note of notes) {
      if (note.system) continue; // Skip system-generated notes
      if (!note.body?.trim()) continue;
      const requestsChanges = isChangeRequest(note.body) && !(note.resolvable && note.resolved);
      dated.push({
        at: Date.parse(note.created_at ?? "") || 0,
        review: {
          author: note.author?.username ?? "unknown",
          state: requestsChanges ? "CHANGES_REQUESTED" : "COMMENTED",
          body: note.body ?? "",
        },
      });
    }
    // Stable: notes keep their order when dates tie or are missing.
    dated.sort((a, b) => a.at - b.at);
    reviews.push(...dated.map((d) => d.review));

    // A reviewer's "Request changes" (GitLab 17+): last, so it is that
    // reviewer's latest say — automatic merging never goes over it.
    try {
      const reviewers = await this.fetchJson<any[]>(
        this.url(ri, `/merge_requests/${prNumber}/reviewers`),
        { headers: this.headers() },
      );
      for (const r of reviewers ?? []) {
        if (r?.state !== "requested_changes") continue;
        reviews.push({
          author: r.user?.username ?? "unknown",
          state: "CHANGES_REQUESTED",
          body: "",
        });
      }
    } catch (err) {
      // Older GitLab has no reviewer states (a 404)
      if (!notThere(err)) incomplete = true;
    }

    return incomplete ? markReviewsIncomplete(reviews) : reviews;
  }

  /** Comments on lines of the diff, oldest first; a resolved thread is settled and left out. */
  async getInlineComments(ri: RepoIdentifier, prNumber: number): Promise<InlineComment[]> {
    const notes = await this.mrNotes(ri, prNumber);

    return notes
      .filter((n: any) => n.position && !n.system && !(n.resolvable && n.resolved))
      .map((n: any) => ({
        author: n.author?.username ?? "unknown",
        path: n.position?.new_path ?? n.position?.old_path ?? "",
        line: n.position?.new_line ?? n.position?.old_line ?? null,
        body: n.body ?? "",
        createdAt: n.created_at ?? "",
      }));
  }

  /** The MR's general discussion: its notes that are not on a line of the diff. */
  async getPullRequestComments(ri: RepoIdentifier, prNumber: number): Promise<IssueComment[]> {
    const notes = await this.mrNotes(ri, prNumber);
    return notes.filter((n: any) => !n.system && !n.position).map(toComment);
  }

  /** An issue's newest comments (up to 30), oldest first: what a ticket's prompt carries. */
  async getIssueComments(ri: RepoIdentifier, issueOrPrNumber: number): Promise<IssueComment[]> {
    const notes = await this.newestNotes(ri, `/issues/${issueOrPrNumber}/notes`, 1);
    return notes
      .filter((n: any) => !n.system)
      .slice(-ISSUE_COMMENTS)
      .map(toComment);
  }

  private mrNotes(ri: RepoIdentifier, prNumber: number): Promise<any[]> {
    return this.newestNotes(ri, `/merge_requests/${prNumber}/notes`);
  }

  /**
   * A thread's notes, oldest first: read newest first, up to `pages` pages
   * of 100, so a busy thread keeps its latest feedback.
   */
  private async newestNotes(ri: RepoIdentifier, path: string, pages = NOTE_PAGES): Promise<any[]> {
    const notes: any[] = [];
    for (let page = 1; page <= pages; page++) {
      const params = new URLSearchParams({
        sort: "desc",
        order_by: "created_at",
        per_page: "100",
        page: String(page),
      });
      const data = await this.fetchJson<any[]>(this.url(ri, `${path}?${params}`), {
        headers: this.headers(),
      });
      notes.push(...data);
      if (data.length < 100) break;
    }
    return notes.reverse();
  }

  // ── PR/MR writes ──────────────────────────────────────────────────────────

  /**
   * Merge the MR. GitLab's merge method (merge commit, semi-linear,
   * fast-forward) is the project's setting, not a parameter of the merge, so
   * "rebase" rebases the source branch onto the target first
   * (`PUT /rebase`, GitLab's own rebase) and then merges what that made.
   * GitLab answers 405/406 right after a push while it is still checking the
   * MR: polled until it says, then merged or `GitLabNotReadyError`. An MR
   * that only needs a rebase (`need_rebase`, a fast-forward project) is
   * rebased by GitLab rather than handed back as a conflict; when the merge
   * was guarded by a checked head SHA, the rebase made a new head that CI
   * must see first, so it comes back as not ready and is merged later.
   */
  async mergePullRequest(
    ri: RepoIdentifier,
    prNumber: number,
    method: "merge" | "squash" | "rebase",
    expectedHeadSha?: string,
  ): Promise<void> {
    let sha = expectedHeadSha;
    if (method === "rebase") {
      const rebased = await this.rebaseMergeRequest(ri, prNumber);
      if (expectedHeadSha && rebased !== expectedHeadSha) {
        throw new GitLabNotReadyError("rebased");
      }
      sha = rebased ?? sha;
    }
    const body = (): Record<string, unknown> => ({
      should_remove_source_branch: true,
      sha,
      ...(method === "squash" ? { squash: true } : {}),
    });

    const merge = async (): Promise<boolean> => {
      try {
        await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/merge`), {
          method: "PUT",
          headers: this.headers(true),
          body: JSON.stringify(body()),
        });
        return true;
      } catch (err) {
        // 405 / 406: not mergeable *yet* — GitLab answers so right after a
        // push, while `detailed_merge_status` is still unchecked/checking.
        if (err instanceof GitLabApiError && (err.status === 405 || err.status === 406)) {
          return false;
        }
        throw err;
      }
    };
    if (await merge()) return;

    let status: string | undefined;
    for (let i = 0; i < MERGE_STATUS_POLLS; i++) {
      await sleep(MERGE_STATUS_POLL_MS);
      const mr = await this.fetchJson<any>(this.url(ri, `/merge_requests/${prNumber}`), {
        headers: this.headers(),
      });
      if (mr.state === "merged") return;
      status = mr.detailed_merge_status ?? mr.merge_status;
      if (!mergeStatusPending(status)) break;
    }
    if (status === "need_rebase") {
      const rebased = await this.rebaseMergeRequest(ri, prNumber);
      if (expectedHeadSha) throw new GitLabNotReadyError("need_rebase");
      sha = rebased ?? undefined;
      if (await merge()) return;
      throw new GitLabNotReadyError(status);
    }
    if ((status === "mergeable" || status === "can_be_merged") && (await merge())) return;
    throw new GitLabNotReadyError(status);
  }

  /**
   * Have GitLab rebase the MR's source branch onto its target and wait for
   * it (`rebase_in_progress`), returning the new head SHA. A rebase GitLab
   * couldn't do (a real conflict) is a `GitLabNotReadyError("conflict")`.
   */
  private async rebaseMergeRequest(ri: RepoIdentifier, prNumber: number): Promise<string | null> {
    await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/rebase`), {
      method: "PUT",
      headers: this.headers(true),
    });
    for (let i = 0; i < REBASE_POLLS; i++) {
      await sleep(MERGE_STATUS_POLL_MS);
      const mr = await this.fetchJson<any>(
        this.url(ri, `/merge_requests/${prNumber}?include_rebase_in_progress=true`),
        { headers: this.headers() },
      );
      if (mr.rebase_in_progress) continue;
      // "Rebase failed: Rebase locally, resolve all conflicts, then push the branch."
      if (typeof mr.merge_error === "string" && /rebase/i.test(mr.merge_error)) {
        throw new GitLabNotReadyError("conflict");
      }
      return typeof mr.sha === "string" ? mr.sha : null;
    }
    throw new GitLabNotReadyError("rebase_in_progress");
  }

  async submitReview(
    ri: RepoIdentifier,
    prNumber: number,
    review: {
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: { path: string; line?: number; side?: string; body: string }[];
      commitId?: string;
    },
  ): Promise<{ url: string }> {
    // GitLab has no atomic "submit review" — we make multiple calls

    // 1. Handle approval, of the commit that was reviewed when it is known:
    // GitLab refuses (409) when the MR has moved on since, and that refusal
    // stops the submission before anything is posted.
    if (review.event === "APPROVE") {
      const approve = () =>
        this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/approve`), {
          method: "POST",
          headers: this.headers(true),
          ...(review.commitId ? { body: JSON.stringify({ sha: review.commitId }) } : {}),
        });
      const movedOn = (err: unknown) => err instanceof GitLabApiError && err.status === 409;
      try {
        await approve();
      } catch (err) {
        if (movedOn(err)) throw err;
        // GitLab refuses an approval the user already gave, and no new
        // "approved this merge request" note is made, so a "Changes
        // requested:" this reviewer posted since would never be superseded
        // (getReviews). Withdraw the old approval and approve again. Any
        // other refusal: continue and post the review.
        if (await this.hasApproved(ri, prNumber)) {
          try {
            await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/unapprove`), {
              method: "POST",
              headers: this.headers(true),
            });
            await approve();
          } catch (retryErr) {
            if (movedOn(retryErr)) throw retryErr;
          }
        }
      }
    }

    // 2. Post the review body: a request for changes opens a resolvable
    // thread (GitLab's "all threads must be resolved" holds the merge, and
    // resolving it settles the request — see getReviews); the rest is a note.
    if (review.body?.trim()) {
      if (review.event === "REQUEST_CHANGES") {
        await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/discussions`), {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({ body: `**Changes Requested:**\n\n${review.body}` }),
        });
      } else {
        await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/notes`), {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({ body: review.body }),
        });
      }
    }

    // 3. Post inline comments as discussions
    if (review.comments?.length) {
      // Fetch MR diff_refs (required by GitLab for positioned discussions)
      let diffRefs: { base_sha: string; start_sha: string; head_sha: string } | null = null;
      try {
        const mrData = await this.fetchJson<{
          diff_refs?: { base_sha: string; start_sha: string; head_sha: string };
        }>(this.url(ri, `/merge_requests/${prNumber}`), { headers: this.headers() });
        diffRefs = mrData.diff_refs ?? null;
      } catch {
        // Continue without diff_refs — comments will be posted as plain notes below
      }

      for (const comment of review.comments) {
        if (diffRefs) {
          const position: Record<string, unknown> = {
            position_type: "text",
            new_path: comment.path,
            old_path: comment.path,
            base_sha: diffRefs.base_sha,
            start_sha: diffRefs.start_sha,
            head_sha: diffRefs.head_sha,
          };
          // A comment on a removed line (GitHub's side LEFT) is on the old file.
          if (comment.line) {
            position[comment.side === "LEFT" ? "old_line" : "new_line"] = comment.line;
          }
          try {
            await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/discussions`), {
              method: "POST",
              headers: this.headers(true),
              body: JSON.stringify({ body: comment.body, position }),
            });
            continue;
          } catch {
            // GitLab refused the position (a line outside the diff, an
            // unchanged line it needs both line numbers for): post it as a
            // located note below rather than lose the finding.
          }
        }
        try {
          const locationPrefix = comment.line
            ? `**${comment.path}:${comment.line}**\n\n`
            : `**${comment.path}**\n\n`;
          await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/notes`), {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({ body: `${locationPrefix}${comment.body}` }),
          });
        } catch {
          // Individual comment failures are non-critical
        }
      }
    }

    // GitLab doesn't return a review URL; construct the MR URL
    const mrUrl = `${ri.apiBaseUrl.replace(/\/api\/v4$/, "")}/${ri.owner}/${ri.repo}/-/merge_requests/${prNumber}`;
    return { url: mrUrl };
  }

  /** Whether this token's user has approved the MR (false when GitLab can't say). */
  private async hasApproved(ri: RepoIdentifier, prNumber: number): Promise<boolean> {
    try {
      const approvals = await this.fetchJson<any>(
        this.url(ri, `/merge_requests/${prNumber}/approvals`),
        { headers: this.headers() },
      );
      return approvals?.user_has_approved === true;
    } catch {
      return false;
    }
  }

  // ── Issue reads/writes ────────────────────────────────────────────────────

  async listIssues(
    ri: RepoIdentifier,
    opts?: { state?: string; perPage?: number; labels?: string },
  ): Promise<Issue[]> {
    const params = new URLSearchParams({
      state: mapIssueStateToGitLab(opts?.state ?? "open"),
      per_page: String(opts?.perPage ?? 50),
      order_by: "updated_at",
      sort: "desc",
    });
    if (opts?.labels) params.set("labels", opts.labels);

    const data = await this.fetchJson<any[]>(this.url(ri, `/issues?${params}`), {
      headers: this.headers(),
    });

    return data.map((i: any) => ({
      id: i.id,
      number: i.iid,
      title: i.title ?? "",
      body: i.description ?? "",
      state: i.state === "opened" ? "open" : "closed",
      url: i.web_url ?? "",
      labels: i.labels ?? [],
      author: i.author?.username ?? "",
      assignee: i.assignee?.username ?? null,
      isPullRequest: false, // GitLab issues endpoint never includes MRs
      createdAt: i.created_at ?? "",
      updatedAt: i.updated_at ?? "",
    }));
  }

  async createLabel(
    ri: RepoIdentifier,
    label: { name: string; color: string; description?: string },
  ): Promise<void> {
    const res = await gitLabFetch(this.url(ri, "/labels"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        name: label.name,
        color: `#${label.color}`,
        description: label.description ?? "",
      }),
    });
    // Ignore 409 (label already exists)
    if (!res.ok && res.status !== 409) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitLab API error ${res.status}: ${body}`);
    }
  }

  async addLabelsToIssue(ri: RepoIdentifier, issueNumber: number, labels: string[]): Promise<void> {
    // GitLab: update issue with add_labels parameter
    await this.fetchJson(this.url(ri, `/issues/${issueNumber}`), {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify({ add_labels: labels.join(",") }),
    });
  }

  async createIssueComment(ri: RepoIdentifier, issueNumber: number, body: string): Promise<void> {
    await this.fetchJson(this.url(ri, `/issues/${issueNumber}/notes`), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ body }),
    });
  }

  async closeIssue(ri: RepoIdentifier, issueNumber: number): Promise<void> {
    await this.fetchJson(this.url(ri, `/issues/${issueNumber}`), {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify({ state_event: "close" }),
    });
  }

  // ── Repo reads ────────────────────────────────────────────────────────────

  async getRepoMetadata(ri: RepoIdentifier): Promise<RepoMetadata> {
    const data = await this.fetchJson<any>(`${ri.apiBaseUrl}/projects/${this.projectId(ri)}`, {
      headers: this.headers(),
    });
    return {
      fullName: data.path_with_namespace ?? `${ri.owner}/${ri.repo}`,
      defaultBranch: data.default_branch ?? "main",
      isPrivate: data.visibility !== "public",
    };
  }

  async listRepoContents(ri: RepoIdentifier, path = ""): Promise<RepoContent[]> {
    const params = new URLSearchParams({ per_page: "100" });
    if (path) params.set("path", path);
    const data = await this.fetchJson<any[]>(this.url(ri, `/repository/tree?${params}`), {
      headers: this.headers(),
    });
    return data.map((item: any) => ({
      name: item.name ?? "",
      type: item.type === "tree" ? "dir" : "file",
    }));
  }

  async listBranches(
    ri: RepoIdentifier,
    opts?: { search?: string; perPage?: number },
  ): Promise<Branch[]> {
    // GitLab's `search` is a contains-match (`^term` / `term$` anchor it);
    // branches come back alphabetically, with the default one flagged.
    const params = new URLSearchParams({ per_page: String(Math.min(opts?.perPage ?? 100, 100)) });
    const search = opts?.search?.trim();
    if (search) params.set("search", search);
    const data = await this.fetchJson<any[]>(this.url(ri, `/repository/branches?${params}`), {
      headers: this.headers(),
    });
    return defaultBranchFirst(
      data
        .filter((b: any) => typeof b?.name === "string" && b.name)
        .map((b: any) => ({
          name: b.name as string,
          default: b.default === true,
          protected: b.protected === true,
        })),
    );
  }

  /**
   * The projects the token is a member of (`/projects?membership=true`),
   * most recently active first. GitLab searches name, path and description
   * server-side; `search_namespaces` lets `group/project` match too.
   */
  async browseRepositories(
    query: string,
    at: PlatformLocation,
    opts?: { perPage?: number },
  ): Promise<BrowsableRepository[]> {
    const params = new URLSearchParams({
      membership: "true",
      order_by: "last_activity_at",
      sort: "desc",
      per_page: String(Math.min(opts?.perPage ?? 50, 100)),
    });
    const search = query.trim();
    if (search) {
      params.set("search", search);
      if (search.includes("/")) params.set("search_namespaces", "true");
    }
    const data = await this.fetchJson<any[]>(`${at.apiBaseUrl}/projects?${params}`, {
      headers: this.headers(),
    });
    return data
      .filter((p: any) => typeof p?.path_with_namespace === "string")
      .map((p: any) => ({
        fullName: p.path_with_namespace as string,
        cloneUrl:
          p.http_url_to_repo ??
          `${at.apiBaseUrl.replace(/\/api\/v4$/, "")}/${p.path_with_namespace}.git`,
        htmlUrl: p.web_url ?? `${at.apiBaseUrl.replace(/\/api\/v4$/, "")}/${p.path_with_namespace}`,
        defaultBranch: p.default_branch ?? "main",
        isPrivate: p.visibility !== "public",
        description: p.description ?? null,
        pushedAt: p.last_activity_at ?? null,
      }));
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  /**
   * The project's hook to `spec.url`: created when none has that URL and the
   * hook Optio made before (`spec.hookId`) is gone, else rewritten
   * (`PUT /hooks/:id`). A hook found by its id but at an old URL (the public
   * address moved) is pointed at the new one rather than joined by a second.
   * GitLab never returns a hook's token, so an existing hook cannot be
   * compared and is always brought up to date — that is what "Repair" relies
   * on. Needs Maintainer on the project; a 403 comes back as the usual
   * `GitLab API error 403`.
   */
  async ensureWebhook(
    ri: RepoIdentifier,
    spec: GitLabWebhookSpec,
  ): Promise<{ hookId: string; created: boolean }> {
    const body = JSON.stringify(gitLabHookBody(spec));
    const hooks = await this.fetchJson<any[]>(this.url(ri, "/hooks?per_page=100"), {
      headers: this.headers(),
    });
    const existing =
      hooks.find((h: any) => typeof h?.url === "string" && h.url === spec.url) ??
      (spec.hookId ? hooks.find((h: any) => String(h?.id) === String(spec.hookId)) : undefined);
    if (!existing) {
      const created = await this.fetchJson<any>(this.url(ri, "/hooks"), {
        method: "POST",
        headers: this.headers(true),
        body,
      });
      return { hookId: String(created.id), created: true };
    }
    await this.fetchJson(this.url(ri, `/hooks/${existing.id}`), {
      method: "PUT",
      headers: this.headers(true),
      body,
    });
    return { hookId: String(existing.id), created: false };
  }

  async deleteWebhook(ri: RepoIdentifier, hookId: string): Promise<void> {
    const res = await gitLabFetch(this.url(ri, `/hooks/${encodeURIComponent(hookId)}`), {
      method: "DELETE",
      headers: this.headers(),
    });
    // Already gone is the outcome we wanted
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitLab API error ${res.status}: ${text}`);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A webhook spec with the hook Optio registered before, so a moved URL updates it. */
export interface GitLabWebhookSpec extends WebhookSpec {
  /** The project hook's id from an earlier `ensureWebhook` (`repos.webhook_id`). */
  hookId?: string | null;
}

/**
 * GitLab's per-event hook flags. Every flag is sent, so an event dropped from
 * the spec is switched off on an update rather than left as it was.
 */
const GITLAB_HOOK_EVENT_FLAGS: Record<string, string> = {
  push: "push_events",
  tag_push: "tag_push_events",
  merge_requests: "merge_requests_events",
  note: "note_events",
  confidential_note: "confidential_note_events",
  issues: "issues_events",
  confidential_issues: "confidential_issues_events",
  pipeline: "pipeline_events",
  job: "job_events",
  releases: "releases_events",
  wiki_page: "wiki_page_events",
  deployment: "deployment_events",
};

/**
 * TLS verification GitLab applies when calling Optio: on, unless the
 * deployment says its certificate comes from a CA GitLab does not trust
 * (`OPTIO_GITLAB_HOOK_SSL_VERIFY=false`, a self-signed internal ingress).
 */
export function gitLabHookSslVerifyDefault(): boolean {
  const raw = process.env.OPTIO_GITLAB_HOOK_SSL_VERIFY?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "no" || raw === "off");
}

function gitLabHookBody(spec: WebhookSpec): Record<string, unknown> {
  const unknown = spec.events.filter((e) => !(e in GITLAB_HOOK_EVENT_FLAGS));
  if (unknown.length > 0) {
    throw new Error(`Unknown GitLab webhook event(s): ${unknown.join(", ")}`);
  }
  const body: Record<string, unknown> = {
    url: spec.url,
    token: spec.token,
    enable_ssl_verification: spec.sslVerify ?? gitLabHookSslVerifyDefault(),
  };
  for (const [event, flag] of Object.entries(GITLAB_HOOK_EVENT_FLAGS)) {
    body[flag] = spec.events.includes(event);
  }
  return body;
}

/**
 * Whether the MR merges cleanly: `detailed_merge_status` first (GitLab 15.6+),
 * null while GitLab is still checking it, false for a conflict. A source
 * branch that is only behind (`need_rebase`, a fast-forward project) has no
 * conflict — GitLab rebases it at merge time (mergePullRequest), as a GitHub
 * PR that is behind is still mergeable. Other blockers (CI, approvals,
 * draft) aren't conflicts, so the deprecated `merge_status` — which only
 * looks at the git merge — answers for those, and for older GitLab.
 */
function mrMergeable(data: any): boolean | null {
  const detailed = data.detailed_merge_status;
  if (detailed === "mergeable" || detailed === "need_rebase") return true;
  if (mergeStatusPending(detailed)) return null;
  if (detailed === "conflict" || detailed === "broken_status") {
    return false;
  }
  return data.merge_status === "can_be_merged"
    ? true
    : data.merge_status === "cannot_be_merged"
      ? false
      : null;
}

function mapMr(data: any, ri: RepoIdentifier, forks?: Map<number, string>): PullRequest {
  const headRepo = forks?.get(data.source_project_id);
  return {
    number: data.iid,
    title: data.title ?? "",
    body: data.description ?? "",
    state: data.state === "merged" || data.state === "closed" ? "closed" : "open",
    merged: data.state === "merged",
    mergeable: mrMergeable(data),
    ...(typeof data.detailed_merge_status === "string"
      ? { mergeStatus: data.detailed_merge_status }
      : {}),
    draft: data.draft ?? data.work_in_progress ?? false,
    headSha: data.sha ?? data.diff_refs?.head_sha ?? "",
    baseBranch: data.target_branch ?? "",
    headBranch: data.source_branch ?? undefined,
    ...(headRepo ? { headRepo } : {}),
    url:
      data.web_url ??
      `${ri.apiBaseUrl.replace(/\/api\/v4$/, "")}/${ri.owner}/${ri.repo}/-/merge_requests/${data.iid}`,
    author: data.author?.username ?? "",
    assignees: (data.assignees ?? []).map((a: any) => a.username ?? ""),
    labels: data.labels ?? [],
    createdAt: data.created_at ?? "",
    updatedAt: data.updated_at ?? "",
  };
}

/**
 * Map GitLab job status to CICheck status.
 * GitLab statuses: created, waiting_for_resource, preparing, pending, running,
 *                  success, failed, canceled, skipped, manual, scheduled
 */
function mapGitLabJobStatus(status: string): "queued" | "in_progress" | "completed" {
  switch (status) {
    case "success":
    case "failed":
    case "canceled":
    case "skipped":
    case "manual":
      return "completed";
    case "running":
      return "in_progress";
    default:
      return "queued";
  }
}

function mapGitLabJobConclusion(
  status: string,
): "success" | "failure" | "skipped" | "cancelled" | null {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "skipped":
    case "manual":
      return "skipped";
    case "canceled":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * The pipeline's own status as one more check, when its jobs don't already
 * say it: a failed pipeline with no failed job in the list (a trigger job's
 * downstream pipeline, a job beyond the pages read), a pipeline still running
 * or waiting with every listed job done, or a pipeline with no jobs listed.
 */
function pipelineVerdict(
  pipeline: { id: number; status?: string },
  checks: CICheck[],
): CICheck | null {
  const status = pipeline.status;
  if (!status) return null;
  const name = `pipeline #${pipeline.id}`;
  if (status === "failed") {
    return checks.some((c) => c.conclusion === "failure")
      ? null
      : { name, status: "completed", conclusion: "failure" };
  }
  if (status === "canceled") {
    return checks.some((c) => c.conclusion === "failure" || c.conclusion === "cancelled")
      ? null
      : { name, status: "completed", conclusion: "cancelled" };
  }
  if (status === "success" || status === "skipped" || status === "manual") {
    if (checks.length > 0) return null;
    return { name, status: "completed", conclusion: status === "success" ? "success" : "skipped" };
  }
  // created, waiting_for_resource, preparing, pending, running, scheduled
  return checks.some((c) => c.status !== "completed")
    ? null
    : { name, status: status === "running" ? "in_progress" : "queued", conclusion: null };
}

function mapIssueStateToGitLab(state: string): string {
  if (state === "open") return "opened";
  if (state === "closed") return "closed";
  return state; // "all" etc.
}
