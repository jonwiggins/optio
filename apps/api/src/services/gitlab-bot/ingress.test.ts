import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/client.js", () => ({ db: {} }));

import { mentionCommentOf, mentionNoteOf } from "./ingress.js";
import { envBot, envGitLabBot } from "./settings.js";

const base = {
  object_kind: "note",
  user: { id: 501, username: "alice", email: "[REDACTED]" },
  project: {
    id: 42,
    path_with_namespace: "platform/hello-service",
    web_url: "https://GitLab.example.test/platform/hello-service",
  },
};

describe("mentionNoteOf", () => {
  it("reads a note on a merge request", () => {
    const m = mentionNoteOf({
      ...base,
      object_attributes: {
        id: 9,
        note: "@optio-bot fix ci",
        noteable_type: "MergeRequest",
        discussion_id: "abc",
        url: "https://gitlab.example.test/platform/hello-service/-/merge_requests/3#note_9",
      },
      merge_request: {
        iid: 3,
        title: "T",
        description: "D",
        state: "opened",
        source_branch: "feature/x",
        target_branch: "main",
        source_project_id: 42,
        target_project_id: 42,
        last_commit: { id: "abc123" },
        url: "https://gitlab.example.test/platform/hello-service/-/merge_requests/3",
      },
    });
    expect(m).toMatchObject({
      host: "gitlab.example.test",
      noteId: 9,
      projectId: 42,
      noteableType: "MergeRequest",
      noteableIid: 3,
      discussionId: "abc",
      authorGitlabId: 501,
      authorUsername: "alice",
      note: "@optio-bot fix ci",
      subject: {
        sourceBranch: "feature/x",
        targetBranch: "main",
        headSha: "abc123",
        state: "opened",
        authorEmail: "[REDACTED]",
      },
    });
  });

  it("reads a note on an issue", () => {
    const m = mentionNoteOf({
      ...base,
      object_attributes: { id: 10, note: "@optio-bot go", noteable_type: "Issue" },
      issue: { iid: 7, title: "T", description: "D", state: "opened" },
    });
    expect(m).toMatchObject({ noteableType: "Issue", noteableIid: 7, discussionId: null });
    expect(m?.subject.sourceBranch).toBeUndefined();
  });

  it("leaves out what isn't a new comment on an MR or an issue", () => {
    const note = (attrs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      mentionNoteOf({
        ...base,
        ...extra,
        object_attributes: { id: 11, note: "@optio-bot x", noteable_type: "Issue", ...attrs },
        issue: { iid: 1 },
      });
    expect(note({ system: true })).toBeNull();
    expect(note({ action: "update" })).toBeNull();
    expect(note({ noteable_type: "Commit" })).toBeNull();
    expect(note({ noteable_type: "Snippet" })).toBeNull();
    expect(note({}, { object_kind: "issue" })).toBeNull();
    expect(note({}, { project: { id: 42, web_url: "not a url" } })).toBeNull();
    expect(note({}, { user: {} })).toBeNull();
    expect(note({ action: "create" })).not.toBeNull();
  });
});

describe("envGitLabBot", () => {
  it("is off with the token's user and 5 a window by default", () => {
    expect(envGitLabBot({})).toEqual({ enabled: false, username: null, rateLimit: 5 });
  });

  it("is on when the environment says so", () => {
    expect(envGitLabBot({ OPTIO_GITLAB_BOT_ENABLED: "true" }).enabled).toBe(true);
  });

  it("reads the chart's values", () => {
    expect(
      envGitLabBot({
        OPTIO_GITLAB_BOT_ENABLED: "false",
        OPTIO_GITLAB_BOT_USERNAME: "@svc-optio",
        OPTIO_GITLAB_BOT_RATE_LIMIT: "500",
      }),
    ).toEqual({ enabled: false, username: "svc-optio", rateLimit: 100 });
    expect(
      envGitLabBot({ OPTIO_GITLAB_BOT_USERNAME: "not a name", OPTIO_GITLAB_BOT_RATE_LIMIT: "x" }),
    ).toEqual({ enabled: false, username: null, rateLimit: 5 });
  });
});

describe("envBot for GitHub", () => {
  it("is off by default, apart from GitLab's", () => {
    expect(envBot("github", {})).toEqual({ enabled: false, username: null, rateLimit: 5 });
    expect(envBot("github", { OPTIO_GITLAB_BOT_ENABLED: "true" }).enabled).toBe(false);
  });

  it("reads OPTIO_GITHUB_BOT_*", () => {
    expect(
      envBot("github", {
        OPTIO_GITHUB_BOT_ENABLED: "true",
        OPTIO_GITHUB_BOT_USERNAME: "@optio-bot",
        OPTIO_GITHUB_BOT_RATE_LIMIT: "3",
      }),
    ).toEqual({ enabled: true, username: "optio-bot", rateLimit: 3 });
  });
});

describe("mentionCommentOf (GitHub issue_comment)", () => {
  const event = (over: Record<string, unknown> = {}) => ({
    action: "created",
    issue: {
      number: 5,
      title: "Add a greeting",
      body: "Says hello.",
      state: "open",
      html_url: "https://github.com/acme/widgets/pull/5",
      pull_request: { html_url: "https://github.com/acme/widgets/pull/5" },
    },
    comment: {
      id: 77,
      body: "@optio-bot fix ci",
      html_url: "https://github.com/acme/widgets/pull/5#issuecomment-77",
      user: { login: "alice", id: 7001, type: "User" },
    },
    repository: { id: 4242, html_url: "https://github.com/acme/widgets" },
    ...over,
  });

  it("reads a comment on a pull request's conversation", () => {
    expect(mentionCommentOf(event())).toEqual({
      host: "github.com",
      noteId: 77,
      projectId: 4242,
      projectUrl: "https://github.com/acme/widgets",
      noteableType: "MergeRequest",
      noteableIid: 5,
      discussionId: null,
      noteUrl: "https://github.com/acme/widgets/pull/5#issuecomment-77",
      authorGitlabId: 7001,
      authorUsername: "alice",
      note: "@optio-bot fix ci",
      subject: {
        platform: "github",
        title: "Add a greeting",
        description: "Says hello.",
        state: "open",
        url: "https://github.com/acme/widgets/pull/5",
        authorEmail: null,
      },
    });
  });

  it("an issue's comment is on an Issue", () => {
    const e = event();
    delete (e.issue as Record<string, unknown>).pull_request;
    expect(mentionCommentOf(e)?.noteableType).toBe("Issue");
  });

  it("skips edits, deletions and bots", () => {
    expect(mentionCommentOf(event({ action: "edited" }))).toBeNull();
    expect(mentionCommentOf(event({ action: "deleted" }))).toBeNull();
    const bot = event();
    (bot.comment.user as Record<string, unknown>).type = "Bot";
    expect(mentionCommentOf(bot)).toBeNull();
  });
});
