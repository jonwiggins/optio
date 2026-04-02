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

export class GitLabPlatform implements GitPlatform {
  readonly type = "gitlab" as const;
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {
      "PRIVATE-TOKEN": this.token,
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
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitLab API error ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }

  // ── PR/MR reads ───────────────────────────────────────────────────────────

  async getPullRequest(ri: RepoIdentifier, number: number): Promise<PullRequest> {
    const data = await this.fetchJson<any>(this.url(ri, `/merge_requests/${number}`), {
      headers: this.headers(),
    });
    return mapMr(data, ri);
  }

  async listOpenPullRequests(
    ri: RepoIdentifier,
    opts?: { branch?: string; perPage?: number },
  ): Promise<PullRequest[]> {
    const params = new URLSearchParams({ state: "opened" });
    if (opts?.perPage) params.set("per_page", String(opts.perPage));
    if (opts?.branch) params.set("source_branch", opts.branch);
    const data = await this.fetchJson<any[]>(this.url(ri, `/merge_requests?${params}`), {
      headers: this.headers(),
    });
    return data.map((d: any) => mapMr(d, ri));
  }

  async getCIChecks(ri: RepoIdentifier, commitSha: string): Promise<CICheck[]> {
    // Get pipelines for the commit
    const pipelines = await this.fetchJson<any[]>(
      this.url(ri, `/pipelines?sha=${commitSha}&per_page=5`),
      { headers: this.headers() },
    );
    if (pipelines.length === 0) return [];

    // Get jobs from the most recent pipeline
    const pipelineId = pipelines[0].id;
    const jobs = await this.fetchJson<any[]>(
      this.url(ri, `/pipelines/${pipelineId}/jobs?per_page=100`),
      { headers: this.headers() },
    );

    return jobs.map((j: any) => ({
      name: j.name ?? "",
      status: mapGitLabJobStatus(j.status),
      conclusion: mapGitLabJobConclusion(j.status),
    }));
  }

  async getReviews(ri: RepoIdentifier, prNumber: number): Promise<Review[]> {
    const reviews: Review[] = [];

    // Fetch approvals
    try {
      const approvals = await this.fetchJson<any>(
        this.url(ri, `/merge_requests/${prNumber}/approvals`),
        { headers: this.headers() },
      );
      for (const approver of approvals.approved_by ?? []) {
        reviews.push({
          author: approver.user?.username ?? "unknown",
          state: "APPROVED",
          body: "",
        });
      }
    } catch {
      // Approvals API may not be available on all tiers
    }

    // Fetch discussion notes that act as reviews
    try {
      const notes = await this.fetchJson<any[]>(
        this.url(ri, `/merge_requests/${prNumber}/notes?sort=asc&per_page=100`),
        { headers: this.headers() },
      );
      for (const note of notes) {
        if (note.system) continue; // Skip system-generated notes
        if (!note.body?.trim()) continue;
        reviews.push({
          author: note.author?.username ?? "unknown",
          state: "COMMENTED",
          body: note.body ?? "",
        });
      }
    } catch {
      // Notes endpoint failure is non-critical
    }

    return reviews;
  }

  async getInlineComments(ri: RepoIdentifier, prNumber: number): Promise<InlineComment[]> {
    const notes = await this.fetchJson<any[]>(
      this.url(ri, `/merge_requests/${prNumber}/notes?sort=asc&per_page=100`),
      { headers: this.headers() },
    );

    return notes
      .filter((n: any) => n.position && !n.system)
      .map((n: any) => ({
        author: n.author?.username ?? "unknown",
        path: n.position?.new_path ?? n.position?.old_path ?? "",
        line: n.position?.new_line ?? n.position?.old_line ?? null,
        body: n.body ?? "",
        createdAt: n.created_at ?? "",
      }));
  }

  async getIssueComments(ri: RepoIdentifier, issueOrPrNumber: number): Promise<IssueComment[]> {
    const notes = await this.fetchJson<any[]>(
      this.url(ri, `/issues/${issueOrPrNumber}/notes?sort=asc&per_page=30`),
      { headers: this.headers() },
    );

    return notes
      .filter((n: any) => !n.system)
      .map((n: any) => ({
        author: n.author?.username ?? "unknown",
        body: n.body ?? "",
        createdAt: n.created_at ?? "",
      }));
  }

  // ── PR/MR writes ──────────────────────────────────────────────────────────

  async mergePullRequest(
    ri: RepoIdentifier,
    prNumber: number,
    method: "merge" | "squash" | "rebase",
  ): Promise<void> {
    const body: Record<string, unknown> = {
      should_remove_source_branch: true,
    };
    if (method === "squash") body.squash = true;
    if (method === "rebase") body.merge_method = "rebase";

    await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/merge`), {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify(body),
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
    // GitLab has no atomic "submit review" — we make multiple calls

    // 1. Handle approval
    if (review.event === "APPROVE") {
      try {
        await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/approve`), {
          method: "POST",
          headers: this.headers(true),
        });
      } catch (err) {
        // Log but continue — approval might fail if already approved
      }
    }

    // 2. Post the review body as a note
    if (review.body?.trim()) {
      const prefix = review.event === "REQUEST_CHANGES" ? "**Changes Requested:**\n\n" : "";
      await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/notes`), {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ body: `${prefix}${review.body}` }),
      });
    }

    // 3. Post inline comments as discussions
    if (review.comments?.length) {
      for (const comment of review.comments) {
        try {
          const position: Record<string, unknown> = {
            position_type: "text",
            new_path: comment.path,
            old_path: comment.path,
          };
          if (comment.line) {
            position.new_line = comment.line;
          }

          await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/discussions`), {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({
              body: comment.body,
              position,
            }),
          });
        } catch {
          // Individual comment failures are non-critical
        }
      }
    }

    // GitLab doesn't return a review URL; construct the MR URL
    const mrUrl = `https://${ri.host}/${ri.owner}/${ri.repo}/-/merge_requests/${prNumber}`;
    return { url: mrUrl };
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
    const res = await fetch(this.url(ri, "/labels"), {
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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapMr(data: any, ri: RepoIdentifier): PullRequest {
  return {
    number: data.iid,
    title: data.title ?? "",
    body: data.description ?? "",
    state: data.state === "merged" || data.state === "closed" ? "closed" : "open",
    merged: data.state === "merged",
    mergeable:
      data.merge_status === "can_be_merged"
        ? true
        : data.merge_status === "cannot_be_merged"
          ? false
          : null,
    draft: data.draft ?? data.work_in_progress ?? false,
    headSha: data.sha ?? data.diff_refs?.head_sha ?? "",
    baseBranch: data.target_branch ?? "",
    url: data.web_url ?? `https://${ri.host}/${ri.owner}/${ri.repo}/-/merge_requests/${data.iid}`,
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

function mapIssueStateToGitLab(state: string): string {
  if (state === "open") return "opened";
  if (state === "closed") return "closed";
  return state; // "all" etc.
}
