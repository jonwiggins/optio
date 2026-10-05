import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("./trigger-dispatch.js", () => ({ fireTrigger: vi.fn() }));

import {
  extractMentions,
  firingFor,
  githubEventParams,
  linearEventParams,
  matchGitHubTrigger,
  matchLinearTrigger,
  matchPagerDutyTrigger,
  matchPylonTrigger,
  matchSlackTrigger,
  normalizeGitHubEvent,
  normalizeLinearEvent,
  normalizePagerDutyEvent,
  normalizePylonEvent,
  normalizeSlackEvent,
  pagerDutyEventParams,
  pylonEventParams,
  slackEventParams,
  slackPermalink,
} from "./event-trigger-service.js";
import type { SlackTriggerConfig } from "@optio/shared";

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

  it("normalizes new posts and drops edits / other subtypes / other payload types", () => {
    expect(normalizeSlackEvent(callback({}))).toMatchObject({
      event: "message",
      channelId: "C123",
      text: "deploy please",
      eventId: "Ev1",
      threadTs: null,
      bot: null,
    });
    expect(normalizeSlackEvent(callback({ subtype: "message_changed" }))).toBeNull();
    expect(normalizeSlackEvent(callback({ subtype: "channel_join" }))).toBeNull();
    expect(normalizeSlackEvent(callback({ subtype: "message_deleted" }))).toBeNull();
    expect(normalizeSlackEvent({ type: "url_verification", challenge: "x" })).toBeNull();
  });

  it("takes a bot's post with who posted it", () => {
    // An app posting with its bot token.
    const app = normalizeSlackEvent(
      callback({
        user: "U0BOT",
        bot_id: "B1",
        app_id: "A1",
        bot_profile: { name: "Alertmanager", app_id: "A1" },
        text: "[FIRING:1] HighErrorRate api",
      }),
    );
    expect(app).toMatchObject({
      text: "[FIRING:1] HighErrorRate api",
      bot: { id: "B1", appId: "A1", name: "Alertmanager" },
    });
    // An integration / incoming webhook: the bot_message subtype, a username, no user.
    const hook = normalizeSlackEvent(
      callback({ user: undefined, subtype: "bot_message", bot_id: "B2", username: "deploy-bot" }),
    );
    expect(hook).toMatchObject({ userId: "", bot: { id: "B2", appId: null, name: "deploy-bot" } });
  });

  it("never takes what the receiving app posted itself", () => {
    const own = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      normalizeSlackEvent({ ...callback(event), api_app_id: "AOPTIO", ...extra });
    expect(own({ bot_id: "B9", app_id: "AOPTIO" })).toBeNull();
    expect(own({ bot_id: "B9", bot_profile: { app_id: "AOPTIO", name: "Optio" } })).toBeNull();
    // Its bot user, per the event's authorizations.
    expect(
      own({ user: "UOPTIO" }, { authorizations: [{ user_id: "UOPTIO", is_bot: true }] }),
    ).toBeNull();
    // A person who installed the app with a user token is still a person.
    expect(
      own({ user: "U1" }, { authorizations: [{ user_id: "U1", is_bot: false }] }),
    ).not.toBeNull();
    // Another app's bot is not the receiving app.
    expect(own({ bot_id: "B1", app_id: "A1" })).not.toBeNull();
  });

  it("reads what an alert bot puts in attachments and blocks", () => {
    const alert = normalizeSlackEvent(
      callback({
        bot_id: "B1",
        text: "",
        attachments: [
          {
            fallback: "[Triggered] CPU high on db-1",
            title: "[Triggered] CPU high on db-1",
            title_link: "https://app.datadoghq.com/monitors/1",
            text: "CPU usage is above 90% for 5 minutes.",
            fields: [
              { title: "Host", value: "db-1" },
              { title: "Value", value: "97%" },
            ],
            footer: "Datadog",
          },
        ],
      }),
    );
    expect(alert?.text).toBe(
      [
        "[Triggered] CPU high on db-1 (https://app.datadoghq.com/monitors/1)",
        "CPU usage is above 90% for 5 minutes.",
        "Host: db-1",
        "Value: 97%",
        "Datadog",
      ].join("\n"),
    );
    // Blocks, with the text they repeat said once; a fallback only stands in for nothing else.
    const blocks = normalizeSlackEvent(
      callback({
        bot_id: "B1",
        text: "New issue: TypeError in checkout",
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: "New issue: TypeError in checkout" },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: "Cannot read properties of undefined (reading 'id')" },
            fields: [{ type: "mrkdwn", text: "*Project:* web" }],
          },
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: "Sentry" },
              { type: "plain_text", text: "prod" },
            ],
          },
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "See " },
                  { type: "link", url: "https://sentry.io/issues/1" },
                ],
              },
            ],
          },
        ],
        attachments: [{ fallback: "only a fallback" }],
      }),
    );
    expect(blocks?.text).toBe(
      [
        "New issue: TypeError in checkout",
        "Cannot read properties of undefined (reading 'id')",
        "*Project:* web",
        "Sentry prod",
        "See https://sentry.io/issues/1",
        "only a fallback",
      ].join("\n"),
    );
    // A bot post that says nothing at all is dropped, like an empty human one.
    expect(normalizeSlackEvent(callback({ bot_id: "B1", text: "" }))).toBeNull();
  });

  it("fires for people by default, for bots when asked, and for the named bot only", () => {
    const person = normalizeSlackEvent(callback({}))!;
    const bot = normalizeSlackEvent(
      callback({ bot_id: "B1", app_id: "A1", bot_profile: { name: "Alertmanager" } }),
    )!;
    const other = normalizeSlackEvent(callback({ bot_id: "B2", username: "deploy-bot" }))!;
    const on = (config: Partial<SlackTriggerConfig>) => (ev: typeof person) =>
      matchSlackTrigger({ channelId: "C123", ...config }, ev);

    expect([person, bot].map(on({}))).toEqual([true, false]);
    expect([person, bot].map(on({ postedBy: "people" }))).toEqual([true, false]);
    expect([person, bot, other].map(on({ postedBy: "bots" }))).toEqual([false, true, true]);
    expect([person, bot, other].map(on({ postedBy: "anyone" }))).toEqual([true, true, true]);
    // By name, bot id or app id, any case; people still count with "anyone".
    for (const name of ["alertmanager", "B1", "a1"]) {
      expect([person, bot, other].map(on({ postedBy: "bots", bot: name }))).toEqual([
        false,
        true,
        false,
      ]);
    }
    expect([person, bot, other].map(on({ postedBy: "anyone", bot: "deploy-bot" }))).toEqual([
      true,
      false,
      true,
    ]);
    // Keyword and thread rules apply to bots as to people.
    expect(on({ postedBy: "bots", keyword: "nope" })(bot)).toBe(false);
    const threaded = normalizeSlackEvent(callback({ bot_id: "B1", thread_ts: "0.9" }))!;
    expect(on({ postedBy: "bots" })(threaded)).toBe(false);
  });

  it("hands the bot to the prompt", () => {
    const bot = normalizeSlackEvent(
      callback({
        bot_id: "B1",
        bot_profile: { name: "Alertmanager" },
        text: "[FIRING:1] disk full",
      }),
    )!;
    expect(slackEventParams(bot)).toMatchObject({
      text: "[FIRING:1] disk full",
      botName: "Alertmanager",
      botId: "B1",
    });
    expect(slackEventParams(normalizeSlackEvent(callback({}))!)).toMatchObject({
      userId: "U1",
      botName: "",
      botId: "",
    });
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

  describe("othersOnly", () => {
    const assignedBy = (actor: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      normalizeLinearEvent({
        type: "Issue",
        action: "update",
        data: { ...issue, ...extra },
        updatedFrom: { assigneeId: null },
        actor,
      })!;

    it("fires when someone else assigns someone else's ticket to you", () => {
      const ev = assignedBy({ id: "u-alice", name: "Alice" }, { creatorId: "u-alice" });
      expect(matchLinearTrigger({ user: "Jon Wiggins", othersOnly: true }, ev)).toBe("assigned");
      expect(matchLinearTrigger({ user: "u-jon", othersOnly: true }, ev)).toBe("assigned");
    });

    it("skips tickets you assigned to yourself", () => {
      const ev = assignedBy({ id: "u-jon", name: "Jon Wiggins" }, { creatorId: "u-alice" });
      expect(matchLinearTrigger({ user: "u-jon" }, ev)).toBe("assigned");
      expect(matchLinearTrigger({ user: "u-jon", othersOnly: true }, ev)).toBeNull();
      expect(matchLinearTrigger({ user: "Jon Wiggins", othersOnly: true }, ev)).toBeNull();
    });

    it("skips tickets you created, even when a name matched and the payload has only creatorId", () => {
      const ev = assignedBy({ id: "u-alice", name: "Alice" }, { creatorId: "u-jon" });
      expect(matchLinearTrigger({ user: "Jon Wiggins" }, ev)).toBe("assigned");
      expect(matchLinearTrigger({ user: "Jon Wiggins", othersOnly: true }, ev)).toBeNull();
      expect(matchLinearTrigger({ user: "@jon", othersOnly: true }, ev)).toBeNull();
    });

    it("skips an issue you filed and assigned to yourself on creation", () => {
      const ev = normalizeLinearEvent({
        type: "Issue",
        action: "create",
        data: { ...issue, creatorId: "u-jon" },
        actor: { id: "u-jon", name: "Jon Wiggins", url: "https://linear.app/acme/profiles/jonw" },
      })!;
      expect(matchLinearTrigger({ user: "jon", events: ["assigned"] }, ev)).toBe("assigned");
      expect(
        matchLinearTrigger({ user: "jon", events: ["assigned"], othersOnly: true }, ev),
      ).toBeNull();
      // Known only by the handle in the actor's profile URL.
      expect(
        matchLinearTrigger({ user: "jonw", events: ["created"], othersOnly: true }, ev),
      ).toBeNull();
      expect(
        matchLinearTrigger({ user: "u-jon", events: ["created"], othersOnly: true }, ev),
      ).toBeNull();
    });

    it("knows the person behind an integration's actor, and the author of a comment", () => {
      const viaSlack = assignedBy(
        { id: "slack-app", name: "Slack" },
        { botActor: { name: "Slack", userDisplayName: "Jon Wiggins" }, creatorId: "u-x" },
      );
      expect(matchLinearTrigger({ user: "Jon Wiggins", othersOnly: true }, viaSlack)).toBeNull();

      const comment = normalizeLinearEvent({
        type: "Comment",
        action: "create",
        data: {
          body: "[@Jon Wiggins](https://linear.app/acme/profiles/jonw) please look",
          issue,
          user: { id: "u-alice", name: "Alice" },
          userId: "u-alice",
        },
        actor: { id: "u-alice", name: "Alice" },
      })!;
      expect(matchLinearTrigger({ user: "jonw", othersOnly: true }, comment)).toBe("mentioned");
    });
  });
});

describe("Pylon", () => {
  const issue = {
    id: "iss_123",
    number: 456,
    title: "Login broken",
    body_html: "<p>Can't sign in</p>",
    state: "new",
    link: "https://app.usepylon.com/issues/456",
    account: { name: "Acme" },
    requester: { email: "alice@acme.test", name: "Alice" },
    assignee: { email: "bob@optio.test" },
    tags: [{ name: "bug" }, "urgent"],
  };

  describe("normalizePylonEvent", () => {
    it("reads a nested issue and the event kind from `event`", () => {
      const ev = normalizePylonEvent({ event: "issue.created", issue });
      expect(ev).toMatchObject({
        event: "issue.created",
        issueId: "iss_123",
        issueNumber: "456",
        title: "Login broken",
        body: "<p>Can't sign in</p>",
        state: "new",
        url: "https://app.usepylon.com/issues/456",
        account: "Acme",
        requester: "alice@acme.test",
        assignee: "bob@optio.test",
        tags: ["bug", "urgent"],
      });
      expect(ev.payload).toEqual({ event: "issue.created", issue });
    });

    it("finds the kind under each key it may be called, and nowhere", () => {
      expect(normalizePylonEvent({ event_type: "issue.updated" }).event).toBe("issue.updated");
      expect(normalizePylonEvent({ type: "account.created" }).event).toBe("account.created");
      expect(normalizePylonEvent({ trigger: "Escalated" }).event).toBe("Escalated");
      expect(normalizePylonEvent({ data: { event: "issue.closed" } }).event).toBe("issue.closed");
      expect(normalizePylonEvent({ event: "a", type: "b" }).event).toBe("a");
      expect(normalizePylonEvent({ issue: { title: "x" } }).event).toBeNull();
      expect(normalizePylonEvent(null).event).toBeNull();
    });

    it("reads the same fields flat at the top level, and under `data`", () => {
      const flat = normalizePylonEvent({
        event: "issue.created",
        id: 9,
        number: "10",
        title: "Flat",
        body: "plain",
        status: "open",
        url: "https://x/10",
        account: "Acme Inc",
        requester: "carol@acme.test",
        tags: ["t1"],
      });
      expect(flat).toMatchObject({
        issueId: "9",
        issueNumber: "10",
        title: "Flat",
        body: "plain",
        state: "open",
        url: "https://x/10",
        account: "Acme Inc",
        requester: "carol@acme.test",
        assignee: "",
        tags: ["t1"],
      });
      const nested = normalizePylonEvent({ data: { issue } });
      expect(nested.title).toBe("Login broken");
      const data = normalizePylonEvent({ data: { id: "d1", title: "In data" } });
      expect(data).toMatchObject({ issueId: "d1", title: "In data" });
    });
  });

  describe("matchPylonTrigger", () => {
    const ev = normalizePylonEvent({ event: "Issue.Created", issue });
    it("matches the event kind case-insensitively, any kind when the filter is empty", () => {
      expect(matchPylonTrigger({}, ev)).toBe("Issue.Created");
      expect(matchPylonTrigger({ events: [] }, ev)).toBe("Issue.Created");
      expect(matchPylonTrigger({ events: ["issue.created"] }, ev)).toBe("Issue.Created");
      expect(matchPylonTrigger({ events: ["issue.closed", " ISSUE.CREATED "] }, ev)).toBe(
        "Issue.Created",
      );
      expect(matchPylonTrigger({ events: ["issue.closed"] }, ev)).toBeNull();
    });

    it("a payload with no kind matches only an unfiltered trigger", () => {
      const none = normalizePylonEvent({ issue });
      expect(matchPylonTrigger({}, none)).toBe("any");
      expect(matchPylonTrigger({ events: ["issue.created"] }, none)).toBeNull();
    });
  });

  describe("pylonEventParams", () => {
    it("flattens the event, joining tags and serializing the payload", () => {
      const ev = normalizePylonEvent({ event: "issue.created", issue });
      expect(pylonEventParams(ev)).toEqual({
        source: "pylon",
        event: "issue.created",
        issueId: "iss_123",
        issueNumber: "456",
        title: "Login broken",
        body: "<p>Can't sign in</p>",
        state: "new",
        url: "https://app.usepylon.com/issues/456",
        account: "Acme",
        requester: "alice@acme.test",
        assignee: "bob@optio.test",
        tags: "bug,urgent",
        payload: JSON.stringify({ event: "issue.created", issue }),
      });
    });

    it("caps the payload at 20 000 characters", () => {
      const ev = normalizePylonEvent({ event: "x", blob: "y".repeat(30_000) });
      expect(pylonEventParams(ev).payload).toHaveLength(20_000);
    });
  });

  it("firingFor titles the firing by the issue, with a fallback", () => {
    const ev = normalizePylonEvent({ event: "issue.created", issue });
    const firing = firingFor("pylon", ev, { events: ["issue.created"] })!;
    expect(firing).toMatchObject({
      source: "pylon",
      matched: "issue.created",
      title: "#456 Login broken",
      ticket: {
        source: "pylon",
        externalId: "iss_123",
        url: "https://app.usepylon.com/issues/456",
      },
    });
    expect(firing.message).toContain("Pylon issue.created: #456 Login broken");
    expect(firing.message).toContain("Account: Acme");
    expect(firingFor("pylon", ev, { events: ["issue.closed"] })).toBeNull();
    const bare = firingFor("pylon", normalizePylonEvent({ hello: "world" }), {})!;
    expect(bare.title).toBeUndefined();
    expect(bare.message).toBe("Pylon event");
    expect(bare.ticket).toBeUndefined();
  });
});

describe("PagerDuty", () => {
  const delivery = (over: Record<string, unknown> = {}, eventType = "incident.triggered") => ({
    event: {
      id: "01EV",
      event_type: eventType,
      resource_type: "incident",
      occurred_at: "2026-10-04T10:00:00Z",
      agent: { type: "service_reference" },
      data: {
        id: "PINC1",
        type: "incident",
        incident_number: 1234,
        title: "Checkout latency",
        html_url: "https://acme.pagerduty.com/incidents/PINC1",
        urgency: "high",
        status: "triggered",
        priority: { summary: "P1" },
        service: { id: "PSVC1", summary: "Checkout" },
        assignees: [{ summary: "Alice" }, { summary: "Bob" }],
        ...over,
      },
    },
  });

  describe("normalizePagerDutyEvent", () => {
    it("reads a v3 incident event", () => {
      expect(normalizePagerDutyEvent(delivery())).toEqual({
        kind: "incident.triggered",
        id: "PINC1",
        incidentNumber: 1234,
        title: "Checkout latency",
        url: "https://acme.pagerduty.com/incidents/PINC1",
        urgency: "high",
        priority: "P1",
        service: "Checkout",
        serviceId: "PSVC1",
        status: "triggered",
        assignees: ["Alice", "Bob"],
        eventId: "01EV",
      });
    });

    it("tolerates missing priority, assignees and number", () => {
      const ev = normalizePagerDutyEvent(
        delivery({ priority: null, assignees: [], incident_number: undefined, urgency: "low" }),
      )!;
      expect(ev.priority).toBeNull();
      expect(ev.assignees).toEqual([]);
      expect(ev.incidentNumber).toBeNull();
      expect(ev.urgency).toBe("low");
    });

    it("drops unknown event types, pings, and events without an incident id", () => {
      expect(normalizePagerDutyEvent(delivery({}, "pagey.ping"))).toBeNull();
      expect(normalizePagerDutyEvent(delivery({}, "service.updated"))).toBeNull();
      expect(normalizePagerDutyEvent(delivery({ id: "" }))).toBeNull();
      expect(normalizePagerDutyEvent({})).toBeNull();
      expect(normalizePagerDutyEvent(null)).toBeNull();
    });
  });

  describe("matchPagerDutyTrigger", () => {
    const ev = normalizePagerDutyEvent(delivery())!;
    it("filters by event type", () => {
      expect(matchPagerDutyTrigger({}, ev)).toBe("incident.triggered");
      expect(matchPagerDutyTrigger({ events: ["incident.triggered"] }, ev)).toBe(
        "incident.triggered",
      );
      expect(matchPagerDutyTrigger({ events: ["incident.resolved"] }, ev)).toBeNull();
    });

    it("filters by service, by id or by name, case-insensitively", () => {
      expect(matchPagerDutyTrigger({ services: ["PSVC1"] }, ev)).toBe("incident.triggered");
      expect(matchPagerDutyTrigger({ services: ["psvc1"] }, ev)).toBe("incident.triggered");
      expect(matchPagerDutyTrigger({ services: ["checkout"] }, ev)).toBe("incident.triggered");
      expect(matchPagerDutyTrigger({ services: ["Billing", "Checkout"] }, ev)).toBe(
        "incident.triggered",
      );
      expect(matchPagerDutyTrigger({ services: ["Billing"] }, ev)).toBeNull();
      expect(matchPagerDutyTrigger({ services: [] }, ev)).toBe("incident.triggered");
    });

    it("filters by urgency", () => {
      expect(matchPagerDutyTrigger({ urgency: "high" }, ev)).toBe("incident.triggered");
      expect(matchPagerDutyTrigger({ urgency: "low" }, ev)).toBeNull();
      const low = normalizePagerDutyEvent(delivery({ urgency: "low" }))!;
      expect(matchPagerDutyTrigger({ urgency: "low" }, low)).toBe("incident.triggered");
      const unknown = normalizePagerDutyEvent(delivery({ urgency: undefined }))!;
      expect(matchPagerDutyTrigger({ urgency: "high" }, unknown)).toBeNull();
      expect(matchPagerDutyTrigger({}, unknown)).toBe("incident.triggered");
    });
  });

  describe("pagerDutyEventParams", () => {
    it("flattens the event with multiple assignees and the ticket aliases", () => {
      const ev = normalizePagerDutyEvent(delivery())!;
      expect(pagerDutyEventParams(ev)).toEqual({
        source: "pagerduty",
        event: "incident.triggered",
        incidentId: "PINC1",
        incidentNumber: "1234",
        title: "Checkout latency",
        url: "https://acme.pagerduty.com/incidents/PINC1",
        urgency: "high",
        priority: "P1",
        service: "Checkout",
        serviceId: "PSVC1",
        status: "triggered",
        assignees: "Alice,Bob",
        ticketSource: "pagerduty",
        ticketExternalId: "PINC1",
        ticketTitle: "Checkout latency",
        ticketBody: "",
        ticketUrl: "https://acme.pagerduty.com/incidents/PINC1",
        ticketLabels: "",
      });
    });
  });

  it("firingFor links the incident as a ticket and titles it by number", () => {
    const ev = normalizePagerDutyEvent(delivery({}, "incident.acknowledged"))!;
    const firing = firingFor("pagerduty", ev, { services: ["Checkout"] })!;
    expect(firing).toMatchObject({
      source: "pagerduty",
      matched: "incident.acknowledged",
      title: "#1234 Checkout latency",
      ticket: {
        source: "pagerduty",
        externalId: "PINC1",
        url: "https://acme.pagerduty.com/incidents/PINC1",
      },
    });
    expect(firing.message).toContain("PagerDuty incident acknowledged: #1234 Checkout latency");
    expect(firing.message).toContain("Assigned to: Alice, Bob");
    expect(firingFor("pagerduty", ev, { urgency: "low" })).toBeNull();
  });
});
