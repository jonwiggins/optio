import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("./local-blueprint-service.js", () => ({
  getBlueprint: vi.fn(),
  spawnFromBlueprint: vi.fn(),
}));

import {
  extractMentions,
  githubEventParams,
  linearEventParams,
  matchGitHubTrigger,
  matchLinearTrigger,
  matchSlackTrigger,
  normalizeGitHubEvent,
  normalizeLinearEvent,
  normalizeSlackEvent,
  slackPermalink,
} from "./local-event-service.js";

const REPO = {
  full_name: "acme/optio",
  html_url: "https://github.com/acme/optio",
};
const PR = {
  number: 42,
  title: "feat: automations",
  body: "cc @Jon-Wiggins please look",
  html_url: "https://github.com/acme/optio/pull/42",
  user: { login: "alice" },
  head: { ref: "feat/auto" },
  base: { ref: "main" },
};

describe("extractMentions", () => {
  it("finds @handles, lowercases them, and ignores emails and paths", () => {
    expect(extractMentions("hey @Jon-Wiggins and @bob.smith, not me@x.com or a/@b")).toEqual([
      "jon-wiggins",
      "bob.smith",
    ]);
  });
});

describe("GitHub", () => {
  it("normalizes review_requested with the reviewer as target", () => {
    const ev = normalizeGitHubEvent("pull_request", {
      action: "review_requested",
      repository: REPO,
      pull_request: PR,
      requested_reviewer: { login: "Jon-Wiggins" },
    })!;
    expect(ev.kinds).toEqual(["review_requested"]);
    expect(ev.targets).toEqual(["jon-wiggins"]);
    expect(ev.kind).toBe("pr");
    expect(ev.headBranch).toBe("feat/auto");
    expect(ev.repoUrl).toBe("https://github.com/acme/optio");
  });

  it("normalizes comment @-mentions and tells PR comments from issue comments", () => {
    const ev = normalizeGitHubEvent("issue_comment", {
      action: "created",
      repository: REPO,
      issue: { ...PR, pull_request: { url: "x" } },
      comment: { body: "@jon-wiggins can you take this?", html_url: "https://c" },
      sender: { login: "alice" },
    })!;
    expect(ev.kinds).toEqual(["mentioned"]);
    expect(ev.kind).toBe("pr");
    expect(ev.commentBody).toContain("take this");
    expect(ev.commentUrl).toBe("https://c");
  });

  it("ignores deliveries that aren't about a person", () => {
    expect(normalizeGitHubEvent("push", { repository: REPO })).toBeNull();
    expect(
      normalizeGitHubEvent("pull_request", {
        action: "synchronize",
        repository: REPO,
        pull_request: PR,
      }),
    ).toBeNull();
    expect(
      normalizeGitHubEvent("issue_comment", {
        action: "created",
        repository: REPO,
        issue: PR,
        comment: { body: "no mentions here" },
      }),
    ).toBeNull();
  });

  it("matches only the configured login, repos, and kinds", () => {
    const ev = normalizeGitHubEvent("pull_request", {
      action: "review_requested",
      repository: REPO,
      pull_request: PR,
      requested_reviewer: { login: "jon-wiggins" },
    })!;
    expect(matchGitHubTrigger({ login: "@Jon-Wiggins" }, ev)).toBe("review_requested");
    expect(matchGitHubTrigger({ login: "someone-else" }, ev)).toBeNull();
    expect(matchGitHubTrigger({ login: "jon-wiggins", events: ["mentioned"] }, ev)).toBeNull();
    expect(matchGitHubTrigger({ login: "jon-wiggins", repos: ["acme/other"] }, ev)).toBeNull();
    expect(matchGitHubTrigger({ login: "jon-wiggins", repos: ["ACME/optio"] }, ev)).toBe(
      "review_requested",
    );
    // Personal kinds never match without a login.
    expect(matchGitHubTrigger({}, ev)).toBeNull();
  });

  it("pr_opened matches without a login and prefers the personal kind when both apply", () => {
    const opened = normalizeGitHubEvent("pull_request", {
      action: "opened",
      repository: REPO,
      pull_request: PR,
    })!;
    expect(opened.kinds.sort()).toEqual(["mentioned", "pr_opened"]);
    expect(matchGitHubTrigger({ events: ["pr_opened"] }, opened)).toBe("pr_opened");
    expect(matchGitHubTrigger({ login: "jon-wiggins" }, opened)).toBe("mentioned");
  });

  it("doesn't fire a mention on your own comment", () => {
    const ev = normalizeGitHubEvent("issue_comment", {
      action: "created",
      repository: REPO,
      issue: { ...PR, user: { login: "jon" } },
      comment: { body: "note to self @jon" },
    })!;
    expect(matchGitHubTrigger({ login: "jon" }, ev)).toBeNull();
  });

  it("renders string params for the prompt template", () => {
    const ev = normalizeGitHubEvent("pull_request", {
      action: "assigned",
      repository: REPO,
      pull_request: PR,
      assignee: { login: "jon" },
    })!;
    const params = githubEventParams(ev, "assigned");
    expect(params).toMatchObject({
      source: "github",
      event: "assigned",
      repo: "acme/optio",
      number: "42",
      headBranch: "feat/auto",
      commentBody: "",
    });
  });
});

describe("Slack", () => {
  const callback = (event: Record<string, unknown>) => ({
    type: "event_callback",
    event_id: "Ev1",
    team_id: "T1",
    event: {
      type: "message",
      channel: "C123",
      user: "U1",
      text: "deploy please",
      ts: "1.2",
      ...event,
    },
  });

  it("normalizes human messages and drops bots / subtypes / other payload types", () => {
    expect(normalizeSlackEvent(callback({}))).toMatchObject({
      event: "message",
      channelId: "C123",
      text: "deploy please",
      eventId: "Ev1",
      threadTs: null,
    });
    expect(normalizeSlackEvent(callback({ bot_id: "B1" }))).toBeNull();
    expect(normalizeSlackEvent(callback({ subtype: "message_changed" }))).toBeNull();
    expect(normalizeSlackEvent({ type: "url_verification", challenge: "x" })).toBeNull();
  });

  it("matches on channel, keyword, mention mode, and threads", () => {
    const msg = normalizeSlackEvent(callback({}))!;
    expect(matchSlackTrigger({ channelId: "C123" }, msg)).toBe(true);
    expect(matchSlackTrigger({ channelId: "C999" }, msg)).toBe(false);
    expect(matchSlackTrigger({ channelId: "C123", keyword: "DEPLOY" }, msg)).toBe(true);
    expect(matchSlackTrigger({ channelId: "C123", keyword: "rollback" }, msg)).toBe(false);
    // mentionOnly listens to app_mention events, not plain messages.
    expect(matchSlackTrigger({ channelId: "C123", mentionOnly: true }, msg)).toBe(false);
    const mention = normalizeSlackEvent(callback({ type: "app_mention" }))!;
    expect(matchSlackTrigger({ channelId: "C123", mentionOnly: true }, mention)).toBe(true);
    expect(matchSlackTrigger({ channelId: "C123" }, mention)).toBe(false);
    const reply = normalizeSlackEvent(callback({ thread_ts: "0.9" }))!;
    expect(matchSlackTrigger({ channelId: "C123" }, reply)).toBe(false);
    expect(matchSlackTrigger({ channelId: "C123", includeThreads: true }, reply)).toBe(true);
  });

  it("builds an archive permalink", () => {
    const msg = normalizeSlackEvent(callback({ ts: "1700000000.123456" }))!;
    expect(slackPermalink(msg)).toBe("https://slack.com/archives/C123/p1700000000123456");
  });
});

describe("Linear", () => {
  const issue = {
    id: "iss-1",
    identifier: "ENG-123",
    title: "Login breaks on Safari",
    description: "Steps… cc @jon",
    url: "https://linear.app/acme/issue/ENG-123/login",
    priority: 2,
    labels: [{ id: "l1", name: "bug" }],
    labelIds: ["l1"],
    team: { id: "t1", key: "ENG", name: "Engineering" },
    state: { name: "Todo" },
    assignee: { id: "u-jon", name: "Jon Wiggins", displayName: "jon" },
    assigneeId: "u-jon",
  };

  it("normalizes an assignment update using updatedFrom", () => {
    const ev = normalizeLinearEvent({
      type: "Issue",
      action: "update",
      data: issue,
      updatedFrom: { assigneeId: null },
      actor: { id: "u-alice", name: "Alice" },
    })!;
    expect(ev.kinds).toEqual(["assigned"]);
    expect(ev.targets).toEqual(expect.arrayContaining(["u-jon", "jon wiggins", "jon"]));
    expect(ev.identifier).toBe("ENG-123");
    expect(ev.teamKey).toBe("ENG");
    expect(ev.labels).toEqual(["bug"]);
  });

  it("ignores unrelated updates but sees new labels", () => {
    expect(
      normalizeLinearEvent({
        type: "Issue",
        action: "update",
        data: issue,
        updatedFrom: { title: "x" },
      }),
    ).toBeNull();
    const labeled = normalizeLinearEvent({
      type: "Issue",
      action: "update",
      data: { ...issue, labelIds: ["l1", "l2"] },
      updatedFrom: { labelIds: ["l1"] },
    })!;
    expect(labeled.kinds).toEqual(["labeled"]);
  });

  it("normalizes comment mentions (plain and markdown-link style)", () => {
    const ev = normalizeLinearEvent({
      type: "Comment",
      action: "create",
      data: {
        body: "[@Jon Wiggins](https://linear.app/acme/profiles/jonw) can you triage?",
        issue,
        user: { id: "u-alice", name: "Alice" },
        url: "https://linear.app/acme/issue/ENG-123#comment-1",
      },
      actor: { id: "u-alice", name: "Alice" },
    })!;
    expect(ev.kinds).toEqual(["mentioned"]);
    expect(ev.targets).toEqual(expect.arrayContaining(["jon wiggins", "jonw"]));
    expect(ev.commentUrl).toContain("#comment-1");
    expect(matchLinearTrigger({ user: "Jon Wiggins" }, ev)).toBe("mentioned");
    expect(matchLinearTrigger({ user: "@jonw" }, ev)).toBe("mentioned");
    expect(matchLinearTrigger({ user: "alice" }, ev)).toBeNull();
  });

  it("matches on user, teams, labels and kinds", () => {
    const ev = normalizeLinearEvent({
      type: "Issue",
      action: "create",
      data: issue,
      actor: { id: "u-alice", name: "Alice" },
    })!;
    expect(ev.kinds.sort()).toEqual(["assigned", "created", "mentioned"]);
    expect(matchLinearTrigger({ user: "u-jon" }, ev)).toBe("assigned");
    expect(matchLinearTrigger({ user: "u-jon", teams: ["ops"] }, ev)).toBeNull();
    expect(matchLinearTrigger({ user: "u-jon", labels: ["Bug"] }, ev)).toBe("assigned");
    expect(matchLinearTrigger({ events: ["created"] }, ev)).toBe("created");
    expect(matchLinearTrigger({ events: ["assigned"] }, ev)).toBeNull();
    expect(linearEventParams(ev, "assigned")).toMatchObject({
      identifier: "ENG-123",
      ticketExternalId: "ENG-123",
      priority: "2",
      state: "Todo",
    });
  });
});
