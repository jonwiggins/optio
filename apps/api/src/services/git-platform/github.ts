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
} from "@optio/shared";

/**
 * Error thrown by GitHubPlatform for any non-2xx GitHub REST response. Carries
 * the verified response metadata callers need to choose the correct recovery:
 * HTTP status, `Retry-After`, the `x-ratelimit-*` primary-quota signals, and
 * whether the body indicates a *secondary* rate limit. The `.message` is kept
 * identical to the previous `GitHub API error <status>: <body>` string so
 * existing message-based logging/classification is unaffected.
 */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  readonly rateLimitRemaining: number | null;
  readonly rateLimitResetMs: number | null;
  readonly isSecondaryRateLimit: boolean;
  readonly isPrimaryRateLimit: boolean;

  constructor(
    status: number,
    body: string,
    meta: {
      retryAfterMs?: number | null;
      rateLimitRemaining?: number | null;
      rateLimitResetMs?: number | null;
    } = {},
  ) {
    super(`GitHub API error ${status}: ${body}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.retryAfterMs = meta.retryAfterMs ?? null;
    this.rateLimitRemaining = meta.rateLimitRemaining ?? null;
    this.rateLimitResetMs = meta.rateLimitResetMs ?? null;
    this.isSecondaryRateLimit =
      (status === 403 || status === 429) &&
      /secondary rate limit|exceeded a secondary rate limit|abuse detection/i.test(body);
    // A primary-quota exhaustion is a 403/429 with the remaining counter at 0
    // and no secondary marker — it must wait for the reset, not the 60s floor.
    this.isPrimaryRateLimit =
      (status === 403 || status === 429) &&
      this.rateLimitRemaining === 0 &&
      !this.isSecondaryRateLimit;
    // Preserve the prototype chain so `instanceof GitHubApiError` holds even
    // under down-level transpilation targets.
    Object.setPrototypeOf(this, GitHubApiError.prototype);
  }

  static fromResponse(res: Response, body: string): GitHubApiError {
    return new GitHubApiError(res.status, body, {
      retryAfterMs: parseRetryAfterMs(res.headers),
      rateLimitRemaining: parseIntHeader(res.headers, "x-ratelimit-remaining"),
      rateLimitResetMs: parseEpochSecondsToMs(res.headers, "x-ratelimit-reset"),
    });
  }
}

function parseRetryAfterMs(headers: Headers | undefined): number | null {
  const raw = headers?.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : null;
}

function parseIntHeader(headers: Headers | undefined, name: string): number | null {
  const raw = headers?.get(name);
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseEpochSecondsToMs(headers: Headers | undefined, name: string): number | null {
  const seconds = parseIntHeader(headers, name);
  return seconds == null ? null : seconds * 1000;
}

/** Distinct GitHub failure classes, each of which needs a distinct retry policy. */
export type GitHubFailureKind =
  | "secondary_rate_limit"
  | "primary_rate_limit"
  | "auth"
  | "permission";

export interface GitHubFailure {
  kind: GitHubFailureKind;
  /** Server-directed wait (`Retry-After`), if present. */
  retryAfterMs: number | null;
  /** Primary-quota reset time (`x-ratelimit-reset`), if present. */
  resetAtMs: number | null;
}

/**
 * Classify a thrown error into the GitHub failure class that determines retry
 * policy, or `null` when it is NOT a GitHub block (transient 5xx, 404, 422,
 * network, or any non-GitHub error) — in which case callers keep their normal
 * fast-retry behavior. The deadline math (how long to wait) is the caller's
 * responsibility, since it depends on persisted attempt history.
 */
export function classifyGitHubFailure(err: unknown): GitHubFailure | null {
  if (!(err instanceof GitHubApiError)) return null;
  const { retryAfterMs, rateLimitResetMs: resetAtMs } = err;
  if (err.isSecondaryRateLimit) return { kind: "secondary_rate_limit", retryAfterMs, resetAtMs };
  if (err.isPrimaryRateLimit) return { kind: "primary_rate_limit", retryAfterMs, resetAtMs };
  // A 429 with no secondary marker / remaining counter is still a rate limit.
  if (err.status === 429) return { kind: "secondary_rate_limit", retryAfterMs, resetAtMs };
  if (err.status === 401) return { kind: "auth", retryAfterMs: null, resetAtMs: null };
  if (err.status === 403) return { kind: "permission", retryAfterMs: null, resetAtMs: null };
  return null;
}

export class GitHubPlatform implements GitPlatform {
  readonly type = "github" as const;
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "Optio",
      Accept: "application/vnd.github.v3+json",
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private url(ri: RepoIdentifier, path: string): string {
    return `${ri.apiBaseUrl}/repos/${ri.owner}/${ri.repo}${path}`;
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw GitHubApiError.fromResponse(res, body);
    }
    return (await res.json()) as T;
  }

  // ── PR/MR reads ───────────────────────────────────────────────────────────

  async getPullRequest(ri: RepoIdentifier, number: number): Promise<PullRequest> {
    const data = await this.fetchJson<any>(this.url(ri, `/pulls/${number}`), {
      headers: this.headers(),
    });
    return mapPr(data);
  }

  async listOpenPullRequests(
    ri: RepoIdentifier,
    opts?: { branch?: string; perPage?: number },
  ): Promise<PullRequest[]> {
    const params = new URLSearchParams({ state: "open" });
    if (opts?.perPage) params.set("per_page", String(opts.perPage));
    if (opts?.branch) params.set("head", `${ri.owner}:${opts.branch}`);
    const data = await this.fetchJson<any[]>(this.url(ri, `/pulls?${params}`), {
      headers: this.headers(),
    });
    return data.map(mapPr);
  }

  async getCIChecks(ri: RepoIdentifier, commitSha: string): Promise<CICheck[]> {
    const data = await this.fetchJson<any>(this.url(ri, `/commits/${commitSha}/check-runs`), {
      headers: this.headers(),
    });
    return (data.check_runs ?? []).map((r: any) => ({
      name: r.name ?? "",
      status: r.status ?? "queued",
      conclusion: r.conclusion ?? null,
    }));
  }

  async getReviews(ri: RepoIdentifier, prNumber: number): Promise<Review[]> {
    const data = await this.fetchJson<any[]>(this.url(ri, `/pulls/${prNumber}/reviews`), {
      headers: this.headers(),
    });
    return data.map((r: any) => ({
      author: r.user?.login ?? "unknown",
      state: r.state,
      body: r.body ?? "",
    }));
  }

  async getInlineComments(ri: RepoIdentifier, prNumber: number): Promise<InlineComment[]> {
    const data = await this.fetchJson<any[]>(
      this.url(ri, `/pulls/${prNumber}/comments?per_page=50`),
      { headers: this.headers() },
    );
    return data.map((c: any) => ({
      author: c.user?.login ?? "unknown",
      path: c.path ?? "",
      line: c.line ?? null,
      body: c.body ?? "",
      createdAt: c.created_at ?? "",
    }));
  }

  async getIssueComments(ri: RepoIdentifier, issueOrPrNumber: number): Promise<IssueComment[]> {
    const data = await this.fetchJson<any[]>(
      this.url(ri, `/issues/${issueOrPrNumber}/comments?per_page=30`),
      { headers: this.headers() },
    );
    return data.map((c: any) => ({
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      createdAt: c.created_at ?? "",
    }));
  }

  // ── PR/MR writes ──────────────────────────────────────────────────────────

  async mergePullRequest(
    ri: RepoIdentifier,
    prNumber: number,
    method: "merge" | "squash" | "rebase",
  ): Promise<void> {
    await this.fetchJson(this.url(ri, `/pulls/${prNumber}/merge`), {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify({ merge_method: method }),
    });
  }

  async submitReview(
    ri: RepoIdentifier,
    prNumber: number,
    review: {
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: { path: string; line?: number; side?: string; body: string }[];
    },
  ): Promise<{ url: string }> {
    const payload: any = { event: review.event, body: review.body };
    if (review.comments?.length) {
      payload.comments = review.comments.map((c) => ({
        path: c.path,
        body: c.body,
        ...(c.line ? { line: c.line } : { position: 1 }),
        ...(c.side ? { side: c.side } : {}),
      }));
    }
    const data = await this.fetchJson<any>(this.url(ri, `/pulls/${prNumber}/reviews`), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(payload),
    });
    return { url: data.html_url ?? "" };
  }

  // ── Issue reads/writes ────────────────────────────────────────────────────

  async listIssues(
    ri: RepoIdentifier,
    opts?: { state?: string; perPage?: number; labels?: string },
  ): Promise<Issue[]> {
    const params = new URLSearchParams({
      state: opts?.state ?? "open",
      per_page: String(opts?.perPage ?? 50),
      sort: "updated",
      direction: "desc",
    });
    if (opts?.labels) params.set("labels", opts.labels);
    const data = await this.fetchJson<any[]>(this.url(ri, `/issues?${params}`), {
      headers: this.headers(),
    });
    return data.map((i: any) => ({
      id: i.id,
      number: i.number,
      title: i.title ?? "",
      body: i.body ?? "",
      state: i.state ?? "",
      url: i.html_url ?? "",
      labels: (i.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name)),
      author: i.user?.login ?? "",
      assignee: i.assignee?.login ?? null,
      isPullRequest: !!i.pull_request,
      createdAt: i.created_at ?? "",
      updatedAt: i.updated_at ?? "",
    }));
  }

  async createLabel(
    ri: RepoIdentifier,
    label: { name: string; color: string; description?: string },
  ): Promise<void> {
    // Ignore 422 (label already exists)
    const res = await fetch(this.url(ri, "/labels"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(label),
    });
    if (!res.ok && res.status !== 422) {
      const body = await res.text().catch(() => "");
      throw GitHubApiError.fromResponse(res, body);
    }
  }

  async addLabelsToIssue(ri: RepoIdentifier, issueNumber: number, labels: string[]): Promise<void> {
    await this.fetchJson(this.url(ri, `/issues/${issueNumber}/labels`), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ labels }),
    });
  }

  async createIssueComment(ri: RepoIdentifier, issueNumber: number, body: string): Promise<void> {
    await this.fetchJson(this.url(ri, `/issues/${issueNumber}/comments`), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ body }),
    });
  }

  async closeIssue(ri: RepoIdentifier, issueNumber: number): Promise<void> {
    await this.fetchJson(this.url(ri, `/issues/${issueNumber}`), {
      method: "PATCH",
      headers: this.headers(true),
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    });
  }

  // ── Repo reads ────────────────────────────────────────────────────────────

  async getRepoMetadata(ri: RepoIdentifier): Promise<RepoMetadata> {
    const data = await this.fetchJson<any>(`${ri.apiBaseUrl}/repos/${ri.owner}/${ri.repo}`, {
      headers: this.headers(),
    });
    return {
      fullName: data.full_name ?? `${ri.owner}/${ri.repo}`,
      defaultBranch: data.default_branch ?? "main",
      isPrivate: data.private ?? false,
    };
  }

  async listRepoContents(ri: RepoIdentifier, path = ""): Promise<RepoContent[]> {
    const data = await this.fetchJson<any[]>(this.url(ri, `/contents/${path}`), {
      headers: this.headers(),
    });
    return data.map((item: any) => ({
      name: item.name ?? "",
      type: item.type === "dir" ? "dir" : "file",
    }));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapPr(data: any): PullRequest {
  return {
    number: data.number,
    title: data.title ?? "",
    body: data.body ?? "",
    state: data.state === "open" ? "open" : "closed",
    merged: data.merged ?? false,
    mergeable: data.mergeable ?? null,
    draft: data.draft ?? false,
    headSha: data.head?.sha ?? "",
    baseBranch: data.base?.ref ?? "",
    url: data.html_url ?? "",
    author: data.user?.login ?? "",
    assignees: (data.assignees ?? []).map((a: any) => a.login ?? ""),
    labels: (data.labels ?? []).map((l: any) => (typeof l === "string" ? l : (l.name ?? ""))),
    createdAt: data.created_at ?? "",
    updatedAt: data.updated_at ?? "",
  };
}
