import type { RepoIdentifier } from "@optio/shared";
import type { gitlabMentions } from "../../db/schema.js";
import { getGitToken } from "../git-token-service.js";
import { fetchFailedJobLogs, type FailedJobs } from "../git-platform/gitlab-ci-logs.js";
import { fetchFailedGitHubJobLogs } from "../git-platform/github-ci-logs.js";
import { DEVELOPER_ACCESS, GitLabBotApi } from "./gitlab-api.js";
import { GitHubBotApi, type GitHubPullRequest } from "./github-api.js";

/**
 * Where a mention was made, as the bot's decisions (process.ts, outcome.ts)
 * need it, the same on GitHub and GitLab (docs/gitlab-bot.md): mark the
 * comment seen, reply in its thread, the author's email and whether they
 * may push, a failed pipeline's jobs, and — on GitHub, whose comment events
 * don't carry them — a pull request's branches. Calls go out with the
 * organization's token for the platform (the workspace's, else the
 * deployment's; a GitHub App's installation token when one is configured).
 */

type Row = typeof gitlabMentions.$inferSelect;

export type MentionPlatform = "github" | "gitlab";

export interface MentionThread {
  readonly platform: MentionPlatform;
  /** Seen: `eyes` on the comment. */
  ack(row: Row): Promise<void>;
  reply(row: Row, body: string): Promise<void>;
  /** The author's email as the platform shows it to the token, or null. */
  authorEmail(row: Row): Promise<string | null>;
  /** Whether the author may push to the project (GitLab: Developer or more; GitHub: write or more). */
  authorMayPush(row: Row): Promise<boolean>;
  /** The failed jobs of a commit's pipeline (GitLab) or workflow runs (GitHub); null when none failed. */
  failedJobs(sha: string): Promise<FailedJobs | null>;
  /** A pull request's branches, head and state (GitHub; GitLab's note events carry them). */
  pullRequest?(row: Row): Promise<GitHubPullRequest>;
}

/** The platform a stored mention came from (GitHub ones say so in `subject`). */
export function mentionPlatform(row: Pick<Row, "subject">): MentionPlatform {
  return row.subject?.platform === "github" ? "github" : "gitlab";
}

/**
 * The organization's token for a platform, as server-side calls use it; for
 * GitLab, the one saved for the repo's host first (GITLAB_TOKEN_<HOST>).
 */
export function orgToken(
  platform: MentionPlatform,
  workspaceId: string | null,
  host?: string,
): Promise<string> {
  return getGitToken(platform, {
    server: true,
    workspaceId,
    ...(platform === "gitlab" && host ? { host } : {}),
  });
}

export async function mentionThread(
  ri: RepoIdentifier,
  workspaceId: string | null,
): Promise<MentionThread> {
  const token = await orgToken(
    ri.platform === "github" ? "github" : "gitlab",
    workspaceId,
    ri.host,
  );
  if (ri.platform === "github") {
    const api = new GitHubBotApi(ri.apiBaseUrl, token);
    return {
      platform: "github",
      ack: (row) => api.react(ri.owner, ri.repo, row.noteId, "eyes"),
      reply: async (row, body) => {
        await api.reply(ri.owner, ri.repo, row.noteableIid, body);
      },
      authorEmail: (row) => api.userEmail(row.authorUsername),
      authorMayPush: (row) => api.canPush(ri.owner, ri.repo, row.authorUsername),
      failedJobs: (sha) => fetchFailedGitHubJobLogs(ri, token, sha),
      pullRequest: (row) => api.pullRequest(ri.owner, ri.repo, row.noteableIid),
    };
  }
  const api = new GitLabBotApi(ri.apiBaseUrl, token);
  return {
    platform: "gitlab",
    ack: (row) =>
      api.awardEmoji(row.projectId, row.noteableType, row.noteableIid, row.noteId, "eyes"),
    reply: async (row, body) => {
      await api.reply(row.projectId, row.noteableType, row.noteableIid, row.discussionId, body);
    },
    authorEmail: async (row) => (row.authorGitlabId ? api.userEmail(row.authorGitlabId) : null),
    authorMayPush: async (row) =>
      !!row.authorGitlabId &&
      (await api.accessLevel(row.projectId, row.authorGitlabId)) >= DEVELOPER_ACCESS,
    failedJobs: (sha) => fetchFailedJobLogs(ri, token, sha),
  };
}
