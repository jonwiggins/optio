import { gitLabFetch } from "../gitlab-instance-runtime.js";
/**
 * The GitLab calls Optio's GitLab user makes for @-mentions
 * (docs/gitlab-bot.md): who the token is, an award emoji on a comment, a
 * reply in the comment's thread, a person's access to the project and their
 * email. Bare `fetch` against `<host>/api/v4`, as git-platform/gitlab.ts
 * does: the API trusts the deployment's CA through the chart's CA bundle
 * (`NODE_EXTRA_CA_CERTS`). Every call is bounded in time; errors are
 * `GitLabBotApiError` with GitLab's status, for the caller to word.
 */

const TIMEOUT_MS = 15_000;

export class GitLabBotApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
    readonly platform: "GitHub" | "GitLab" = "GitLab",
  ) {
    super(`${platform} answered ${status} on ${path}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "GitLabBotApiError";
  }
}

/**
 * A failed GitLab (or GitHub) call as a thread may show it: the platform's
 * status, never the error's text (a response body, an address, a TLS
 * detail), which the caller logs. Knows this file's errors, github-api.ts's,
 * gitlab-ci-logs.ts's and github-ci-logs.ts's.
 */
export function gitlabProblem(err: unknown, platform: "GitHub" | "GitLab" = "GitLab"): string {
  if (err instanceof GitLabBotApiError) return `${err.platform} answered ${err.status}`;
  const status =
    err instanceof Error ? /(?:GitLab|GitHub) API error (\d{3})/.exec(err.message)?.[1] : null;
  return status ? `${platform} answered ${status}` : `${platform} didn't answer`;
}

export type Noteable = "MergeRequest" | "Issue";

const noteablePath = (type: Noteable) => (type === "MergeRequest" ? "merge_requests" : "issues");

/** GitLab's access levels: Developer may push to unprotected branches. */
export const DEVELOPER_ACCESS = 30;

export class GitLabBotApi {
  constructor(
    /** `https://gitlab.example.test/api/v4` (parseRepoUrl's `apiBaseUrl`). */
    private readonly apiBaseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await gitLabFetch(`${this.apiBaseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "Optio",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GitLabBotApiError(res.status, path.split("?")[0], text);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /**
   * The token's own user (`GET /user`): Optio's GitLab user. `bot` is
   * GitLab's flag (true for project, group and service account tokens'
   * users, false for a person; absent on old GitLabs).
   */
  async currentUser(): Promise<{ id: number; username: string; bot?: boolean }> {
    const u = await this.call<{ id: number; username: string; bot?: unknown }>("GET", "/user");
    return {
      id: Number(u.id),
      username: String(u.username),
      ...(typeof u.bot === "boolean" ? { bot: u.bot } : {}),
    };
  }

  /** An award emoji on a comment (`eyes`: seen). An emoji already there is no error. */
  async awardEmoji(
    projectId: number,
    type: Noteable,
    iid: number,
    noteId: number,
    name: string,
  ): Promise<void> {
    try {
      await this.call(
        "POST",
        `/projects/${projectId}/${noteablePath(type)}/${iid}/notes/${noteId}/award_emoji`,
        { name },
      );
    } catch (err) {
      // 404 "Award Emoji Name has already been taken" comes as 404 or 400.
      if (err instanceof GitLabBotApiError && /already been taken/i.test(err.message)) return;
      throw err;
    }
  }

  /**
   * A reply in the comment's thread, or — when GitLab won't take one there
   * (no discussion id, a thread it can't find) — a new comment on the merge
   * request or issue. Returns the new note's id.
   */
  async reply(
    projectId: number,
    type: Noteable,
    iid: number,
    discussionId: string | null,
    body: string,
  ): Promise<number | null> {
    const base = `/projects/${projectId}/${noteablePath(type)}/${iid}`;
    if (discussionId) {
      try {
        const note = await this.call<{ id: number }>(
          "POST",
          `${base}/discussions/${encodeURIComponent(discussionId)}/notes`,
          { body },
        );
        return note?.id ?? null;
      } catch (err) {
        if (!(err instanceof GitLabBotApiError) || err.status >= 500 || err.status === 401) {
          throw err;
        }
      }
    }
    const note = await this.call<{ id: number }>("POST", `${base}/notes`, { body });
    return note?.id ?? null;
  }

  /** A person's access level on the project, inherited included; 0 when not a member. */
  async accessLevel(projectId: number, userId: number): Promise<number> {
    try {
      const m = await this.call<{ access_level?: number; state?: string }>(
        "GET",
        `/projects/${projectId}/members/all/${userId}`,
      );
      if (m?.state && m.state !== "active") return 0;
      return Number(m?.access_level ?? 0);
    } catch (err) {
      if (err instanceof GitLabBotApiError && err.status === 404) return 0;
      throw err;
    }
  }

  /** A person's email as the token may read it: `email` (an admin's token), else `public_email`. */
  async userEmail(userId: number): Promise<string | null> {
    const u = await this.call<{ email?: string | null; public_email?: string | null }>(
      "GET",
      `/users/${userId}`,
    );
    return u?.email || u?.public_email || null;
  }
}
