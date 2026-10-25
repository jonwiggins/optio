/**
 * The GitHub calls Optio's bot makes for @-mentions (docs/gitlab-bot.md),
 * the counterpart of gitlab-api.ts: a reaction on a comment, a reply on the
 * issue or pull request, a person's permission on the repository and their
 * public email, a pull request's branches and head, and the GitHub App's
 * name. Bare `fetch` against the repo's API (`https://api.github.com`, a
 * GitHub Enterprise Server's `/api/v3`); every call is bounded in time;
 * errors are `GitLabBotApiError` with GitHub's status, for the caller to word.
 */
import { GitLabBotApiError } from "./gitlab-api.js";

const TIMEOUT_MS = 15_000;

/** GitHub's repository roles that may push: write, maintain, admin. */
const PUSH_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export interface GitHubPullRequest {
  state: "open" | "closed" | "merged";
  sourceBranch: string | null;
  targetBranch: string | null;
  headSha: string | null;
  sourceRepoId: number | null;
  targetRepoId: number | null;
  title: string;
  body: string;
  url: string | null;
}

export class GitHubBotApi {
  constructor(
    /** `https://api.github.com` (parseRepoUrl's `apiBaseUrl`). */
    private readonly apiBaseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${this.apiBaseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Optio",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GitLabBotApiError(res.status, path.split("?")[0], text, "GitHub");
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** A reaction on an issue or pull request comment (`eyes`: seen). One already there is fine. */
  async react(owner: string, repo: string, commentId: number, content: string): Promise<void> {
    await this.call("POST", `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
      content,
    });
  }

  /** A comment on the issue or pull request (GitHub's conversation has no threads). */
  async reply(owner: string, repo: string, number: number, body: string): Promise<number | null> {
    const c = await this.call<{ id: number }>(
      "POST",
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      { body },
    );
    return c?.id ?? null;
  }

  /** Whether `login` may push to the repository (write, maintain or admin); false when not a collaborator. */
  async canPush(owner: string, repo: string, login: string): Promise<boolean> {
    try {
      const p = await this.call<{ permission?: string; role_name?: string }>(
        "GET",
        `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      );
      return PUSH_PERMISSIONS.has(String(p?.role_name ?? p?.permission ?? ""));
    } catch (err) {
      if (err instanceof GitLabBotApiError && err.status === 404) return false;
      throw err;
    }
  }

  /** A person's public email (`GET /users/:login`), or null. */
  async userEmail(login: string): Promise<string | null> {
    const u = await this.call<{ email?: string | null }>(
      "GET",
      `/users/${encodeURIComponent(login)}`,
    );
    return u?.email || null;
  }

  /** The pull request behind a comment: its branches, head, repositories and state. */
  async pullRequest(owner: string, repo: string, number: number): Promise<GitHubPullRequest> {
    const pr = await this.call<{
      state?: string;
      merged?: boolean;
      merged_at?: string | null;
      title?: string;
      body?: string | null;
      html_url?: string;
      head?: { ref?: string; sha?: string; repo?: { id?: number } | null };
      base?: { ref?: string; repo?: { id?: number } | null };
    }>("GET", `/repos/${owner}/${repo}/pulls/${number}`);
    return {
      state: pr.merged || pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open",
      sourceBranch: pr.head?.ref ?? null,
      targetBranch: pr.base?.ref ?? null,
      headSha: pr.head?.sha ?? null,
      sourceRepoId: pr.head?.repo?.id ?? null,
      targetRepoId: pr.base?.repo?.id ?? null,
      title: pr.title ?? "",
      body: pr.body ?? "",
      url: pr.html_url ?? null,
    };
  }
}

/** The GitHub App's slug (`GET /app` with the App's JWT): its bot is `<slug>[bot]`. */
export async function githubAppSlug(jwt: string): Promise<string> {
  const res = await fetch("https://api.github.com/app", {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Optio",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new GitLabBotApiError(res.status, "/app", await res.text().catch(() => ""), "GitHub");
  }
  const app = (await res.json()) as { slug?: string };
  if (!app.slug) throw new Error("GitHub didn't say the App's name");
  return app.slug;
}
