/**
 * The event sources added after GitHub / Slack / Linear / Pylon / PagerDuty:
 * GitHub's repo-level kinds (push, release, workflow runs, merges, labels),
 * GitLab, Jira, Sentry, Alertmanager (Grafana) and Datadog — each source's
 * normalize → match → params → firing, as pure functions.
 */
import { describe, expect, it } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("./trigger-dispatch.js", () => ({ fireTrigger: vi.fn() }));

import { vi } from "vitest";
import {
  alertmanagerEventParams,
  datadogEventParams,
  datadogKindOf,
  firingFor,
  githubEventParams,
  gitlabEventParams,
  jiraEventParams,
  jiraMentions,
  jiraText,
  matchAlertmanagerTrigger,
  matchDatadogTrigger,
  matchGitHubTrigger,
  matchGitLabTrigger,
  matchJiraTrigger,
  matchSentryTrigger,
  matchesAnyPattern,
  normalizeAlertmanagerEvent,
  normalizeDatadogEvent,
  normalizeGitHubEvent,
  normalizeGitLabEvent,
  normalizeJiraEvent,
  normalizeSentryEvent,
  sentryEventParams,
} from "./event-trigger-service.js";

describe("matchesAnyPattern", () => {
  it("takes exact names and globs, case-insensitively; nothing wanted = anything", () => {
    expect(matchesAnyPattern(undefined, "main")).toBe(true);
    expect(matchesAnyPattern([], "main")).toBe(true);
    expect(matchesAnyPattern(["Main"], "main")).toBe(true);
    expect(matchesAnyPattern(["release/*"], "release/1.2")).toBe(true);
    expect(matchesAnyPattern(["release/*"], "feat/x")).toBe(false);
    expect(matchesAnyPattern(["v?"], "v1")).toBe(true);
    expect(matchesAnyPattern(["main"], null)).toBe(false);
    expect(matchesAnyPattern(["a.b"], "aXb")).toBe(false);
  });
});

// ── GitHub repo events ──────────────────────────────────────────────────────

const REPO = { full_name: "acme/optio", html_url: "https://github.com/acme/optio" };

describe("GitHub repo events", () => {
  const push = (over: Record<string, unknown> = {}) =>
    normalizeGitHubEvent("push", {
      ref: "refs/heads/main",
      before: "aaaa111",
      after: "b1c2d3e4f5a6",
      compare: "https://github.com/acme/optio/compare/aaaa111...b1c2d3e",
      deleted: false,
      repository: REPO,
      pusher: { name: "alice" },
      sender: { login: "alice" },
      head_commit: { id: "b1c2d3e4f5a6", message: "fix: thing\n\nlonger body" },
      commits: [
        { id: "0000000aaaa", message: "chore: prep" },
        { id: "b1c2d3e4f5a6", message: "fix: thing\n\nlonger body" },
      ],
      ...over,
    });

  it("normalizes a branch push with its commits, and drops tags and deletions", () => {
    const ev = push()!;
    expect(ev.kinds).toEqual(["push"]);
    expect(ev.kind).toBe("push");
    expect(ev.headBranch).toBe("main");
    expect(ev.ref).toBe("refs/heads/main");
    expect(ev.sha).toBe("b1c2d3e4f5a6");
    expect(ev.title).toBe("fix: thing");
    expect(ev.commits).toBe("0000000 chore: prep\nb1c2d3e fix: thing");
    expect(ev.url).toBe("https://github.com/acme/optio/compare/aaaa111...b1c2d3e");
    expect(ev.author).toBe("alice");
    expect(ev.number).toBe(0);
    expect(push({ deleted: true })).toBeNull();
    expect(push({ after: "0000000000000000000000000000000000000000" })).toBeNull();
    // A tag push is its own kind, with the tag; a deleted tag is nothing.
    const tag = push({ ref: "refs/tags/v1.2.0" })!;
    expect(tag.kinds).toEqual(["tag_pushed"]);
    expect(tag.kind).toBe("tag");
    expect(tag.tag).toBe("v1.2.0");
    expect(tag.headBranch).toBeNull();
    expect(tag.title).toBe("Tag v1.2.0");
    expect(tag.url).toBe("https://github.com/acme/optio/releases/tag/v1.2.0");
    expect(matchGitHubTrigger({ events: ["push"] }, tag)).toBeNull();
    expect(matchGitHubTrigger({ events: ["tag_pushed"] }, tag)).toBe("tag_pushed");
    expect(push({ ref: "refs/tags/v1.2.0", deleted: true })).toBeNull();
  });

  it("matches a push on branch patterns only", () => {
    const ev = push()!;
    expect(matchGitHubTrigger({ events: ["push"] }, ev)).toBe("push");
    expect(matchGitHubTrigger({ events: ["push"], branches: ["main"] }, ev)).toBe("push");
    expect(matchGitHubTrigger({ events: ["push"], branches: ["release/*"] }, ev)).toBeNull();
    expect(matchGitHubTrigger({ events: ["pr_opened"] }, ev)).toBeNull();
    // Nothing personal about a push: no login needed.
    expect(matchGitHubTrigger({ events: ["push", "mentioned"], login: "" }, ev)).toBe("push");
  });

  it("normalizes a published release, not a drafted or edited one", () => {
    const payload = (action: string) => ({
      action,
      repository: REPO,
      sender: { login: "bot" },
      release: {
        tag_name: "v1.2.0",
        name: "1.2.0",
        body: "Notes",
        html_url: "https://github.com/acme/optio/releases/tag/v1.2.0",
        author: { login: "alice" },
        target_commitish: "main",
      },
    });
    const ev = normalizeGitHubEvent("release", payload("published"))!;
    expect(ev.kinds).toEqual(["release_published"]);
    expect(ev.kind).toBe("release");
    expect(ev.tag).toBe("v1.2.0");
    expect(ev.title).toBe("1.2.0");
    expect(ev.body).toBe("Notes");
    expect(ev.author).toBe("alice");
    expect(normalizeGitHubEvent("release", payload("created"))).toBeNull();
    expect(normalizeGitHubEvent("release", payload("edited"))).toBeNull();
    expect(matchGitHubTrigger({ events: ["release_published"] }, ev)).toBe("release_published");
  });

  it("turns a completed workflow run into succeeded / failed, with the PR it ran for", () => {
    const run = (conclusion: string, action = "completed") =>
      normalizeGitHubEvent("workflow_run", {
        action,
        repository: REPO,
        sender: { login: "alice" },
        workflow: { name: "CI" },
        workflow_run: {
          name: "CI",
          conclusion,
          head_branch: "feat/x",
          head_sha: "deadbeef",
          html_url: "https://github.com/acme/optio/actions/runs/1",
          display_title: "feat: x",
          actor: { login: "alice" },
          pull_requests: [{ number: 42 }],
        },
      });
    const failed = run("failure")!;
    expect(failed.kinds).toEqual(["workflow_failed"]);
    expect(failed.kind).toBe("workflow");
    expect(failed.workflow).toBe("CI");
    expect(failed.conclusion).toBe("failure");
    expect(failed.headBranch).toBe("feat/x");
    expect(failed.number).toBe(42);
    expect(failed.title).toBe("CI failure on feat/x");
    expect(run("success")!.kinds).toEqual(["workflow_succeeded"]);
    expect(run("timed_out")!.kinds).toEqual(["workflow_failed"]);
    expect(run("cancelled")).toBeNull();
    expect(run("success", "requested")).toBeNull();

    expect(matchGitHubTrigger({ events: ["workflow_failed"] }, failed)).toBe("workflow_failed");
    expect(matchGitHubTrigger({ events: ["workflow_failed"], workflows: ["ci"] }, failed)).toBe(
      "workflow_failed",
    );
    expect(
      matchGitHubTrigger({ events: ["workflow_failed"], workflows: ["Deploy"] }, failed),
    ).toBeNull();
    expect(
      matchGitHubTrigger({ events: ["workflow_failed"], branches: ["main"] }, failed),
    ).toBeNull();
    expect(matchGitHubTrigger({ events: ["workflow_succeeded"] }, failed)).toBeNull();
  });

  it("takes an external CI's check suite but not GitHub Actions' (workflow_run covers it)", () => {
    const suite = (slug: string) =>
      normalizeGitHubEvent("check_suite", {
        action: "completed",
        repository: REPO,
        sender: { login: "alice" },
        check_suite: {
          conclusion: "success",
          head_branch: "main",
          head_sha: "cafe0001",
          app: { slug, name: slug === "circleci" ? "CircleCI Checks" : "GitHub Actions" },
          head_commit: { message: "fix: thing\n\nbody" },
          pull_requests: [],
        },
      });
    expect(suite("github-actions")).toBeNull();
    const ev = suite("circleci")!;
    expect(ev.kinds).toEqual(["workflow_succeeded"]);
    expect(ev.workflow).toBe("CircleCI Checks");
    expect(ev.url).toBe("https://github.com/acme/optio/commit/cafe0001/checks");
    expect(ev.body).toBe("fix: thing");
  });

  it("sees a merged PR, a label landing, and filters PR / issue kinds by their labels", () => {
    const pr = {
      number: 9,
      title: "feat: y",
      body: "",
      html_url: "https://github.com/acme/optio/pull/9",
      user: { login: "alice" },
      head: { ref: "feat/y" },
      base: { ref: "main" },
      labels: [{ name: "backend" }],
    };
    const merged = normalizeGitHubEvent("pull_request", {
      action: "closed",
      repository: REPO,
      pull_request: { ...pr, merged: true },
    })!;
    expect(merged.kinds).toEqual(["pr_merged"]);
    expect(merged.merged).toBe(true);
    expect(merged.labels).toEqual(["backend"]);
    // Closed without merging is `pr_closed`, never `pr_merged`.
    const closed = normalizeGitHubEvent("pull_request", {
      action: "closed",
      repository: REPO,
      pull_request: { ...pr, merged: false },
    })!;
    expect(closed.kinds).toEqual(["pr_closed"]);
    expect(closed.merged).toBe(false);
    expect(matchGitHubTrigger({ events: ["pr_merged"] }, closed)).toBeNull();
    expect(matchGitHubTrigger({ events: ["pr_closed"] }, closed)).toBe("pr_closed");
    expect(matchGitHubTrigger({ events: ["pr_merged"], labels: ["Backend"] }, merged)).toBe(
      "pr_merged",
    );
    expect(matchGitHubTrigger({ events: ["pr_merged"], labels: ["docs"] }, merged)).toBeNull();

    const labeled = normalizeGitHubEvent("issues", {
      action: "labeled",
      repository: REPO,
      issue: { ...pr, labels: [{ name: "backend" }, { name: "bug" }] },
      label: { name: "bug" },
    })!;
    expect(labeled.kinds).toEqual(["labeled"]);
    expect(labeled.kind).toBe("issue");
    expect(labeled.label).toBe("bug");
    expect(matchGitHubTrigger({ events: ["labeled"] }, labeled)).toBe("labeled");
    expect(matchGitHubTrigger({ events: ["labeled"], labels: ["bug"] }, labeled)).toBe("labeled");
    // The label that landed must be one of the wanted ones, not just any the issue carries.
    expect(matchGitHubTrigger({ events: ["labeled"], labels: ["backend"] }, labeled)).toBeNull();

    const opened = normalizeGitHubEvent("issues", {
      action: "opened",
      repository: REPO,
      issue: { ...pr, labels: [{ name: "bug" }] },
    })!;
    expect(matchGitHubTrigger({ events: ["issue_opened"], labels: ["bug"] }, opened)).toBe(
      "issue_opened",
    );
    expect(matchGitHubTrigger({ events: ["issue_opened"], labels: ["docs"] }, opened)).toBeNull();
  });

  it("renders the repo-level fields as params and titles a push firing without a ticket", () => {
    const ev = push()!;
    expect(githubEventParams(ev, "push")).toMatchObject({
      source: "github",
      event: "push",
      kind: "push",
      number: "0",
      headBranch: "main",
      ref: "refs/heads/main",
      sha: "b1c2d3e4f5a6",
      commits: "0000000 chore: prep\nb1c2d3e fix: thing",
      compareUrl: "https://github.com/acme/optio/compare/aaaa111...b1c2d3e",
      merged: "false",
      tag: "",
      workflow: "",
    });
    const firing = firingFor("github", ev, { events: ["push"] })!;
    expect(firing.matched).toBe("push");
    expect(firing.ticket).toBeUndefined();
    expect(firing.title).toBe("fix: thing");
    expect(firing.repoUrlHint).toBe("https://github.com/acme/optio");
    expect(firing.message).toContain("GitHub push: acme/optio — fix: thing");
  });
});

// ── GitLab ──────────────────────────────────────────────────────────────────

const PROJECT = { path_with_namespace: "acme/optio", web_url: "https://gitlab.com/acme/optio" };
const MR_ATTRS = {
  iid: 7,
  title: "feat: widgets",
  description: "cc @Jon please look",
  action: "open",
  url: "https://gitlab.com/acme/optio/-/merge_requests/7",
  source_branch: "feat/widgets",
  target_branch: "main",
  last_commit: { id: "c1c1c1" },
};

describe("GitLab", () => {
  it("normalizes a push with commits and a compare URL; drops tag pushes and deletions", () => {
    const ev = normalizeGitLabEvent({
      object_kind: "push",
      ref: "refs/heads/main",
      before: "aaaa1111",
      after: "bbbb2222",
      user_username: "alice",
      project: PROJECT,
      commits: [{ id: "bbbb2222", title: "fix: x", message: "fix: x\n\nmore" }],
    })!;
    expect(ev.kinds).toEqual(["push"]);
    expect(ev.kind).toBe("push");
    expect(ev.project).toBe("acme/optio");
    expect(ev.projectUrl).toBe("https://gitlab.com/acme/optio");
    expect(ev.sourceBranch).toBe("main");
    expect(ev.sha).toBe("bbbb2222");
    expect(ev.title).toBe("fix: x");
    expect(ev.commits).toBe("bbbb222 fix: x");
    expect(ev.compareUrl).toBe("https://gitlab.com/acme/optio/-/compare/aaaa1111...bbbb2222");
    expect(ev.author).toBe("alice");
    expect(
      normalizeGitLabEvent({ object_kind: "tag_push", ref: "refs/tags/v1", project: PROJECT }),
    ).toBeNull();
    expect(
      normalizeGitLabEvent({
        object_kind: "push",
        ref: "refs/heads/gone",
        after: "0000000000000000000000000000000000000000",
        project: PROJECT,
      }),
    ).toBeNull();
    expect(normalizeGitLabEvent({ object_kind: "push", ref: "refs/heads/main" })).toBeNull();
  });

  it("normalizes an opened MR with its reviewers, assignees, labels and mentions", () => {
    const ev = normalizeGitLabEvent({
      object_kind: "merge_request",
      user: { username: "alice" },
      project: PROJECT,
      object_attributes: MR_ATTRS,
      labels: [{ title: "backend" }],
      reviewers: [{ username: "Jon" }],
      assignees: [{ username: "bob" }],
    })!;
    expect(ev.kinds.sort()).toEqual(["assigned", "mentioned", "mr_opened", "review_requested"]);
    expect(ev.targets.sort()).toEqual(["bob", "jon"]);
    expect(ev.kind).toBe("mr");
    expect(ev.iid).toBe(7);
    expect(ev.labels).toEqual(["backend"]);
    expect(ev.sourceBranch).toBe("feat/widgets");
    expect(ev.targetBranch).toBe("main");
    expect(ev.sha).toBe("c1c1c1");
    expect(ev.author).toBe("alice");

    expect(matchGitLabTrigger({ username: "@jon" }, ev)).toBe("review_requested");
    expect(matchGitLabTrigger({ username: "bob" }, ev)).toBe("assigned");
    expect(
      matchGitLabTrigger(
        { username: "carol", events: ["review_requested", "assigned", "mentioned"] },
        ev,
      ),
    ).toBeNull();
    // Each personal kind is about its own people.
    expect(ev.reviewers).toEqual(["jon"]);
    expect(ev.assignees).toEqual(["bob"]);
    expect(ev.mentions).toEqual(["jon"]);
    expect(matchGitLabTrigger({ username: "bob", events: ["review_requested"] }, ev)).toBeNull();
    expect(matchGitLabTrigger({ events: ["mr_opened"] }, ev)).toBe("mr_opened");
    expect(matchGitLabTrigger({ events: ["mr_opened"], labels: ["Backend"] }, ev)).toBe(
      "mr_opened",
    );
    expect(matchGitLabTrigger({ events: ["mr_opened"], labels: ["frontend"] }, ev)).toBeNull();
    expect(matchGitLabTrigger({ events: ["mr_opened"], projects: ["acme/other"] }, ev)).toBeNull();
    expect(matchGitLabTrigger({ events: ["mr_opened"], projects: ["ACME/optio"] }, ev)).toBe(
      "mr_opened",
    );
  });

  it("reads MR updates from `changes`: new reviewers, assignees and labels; ignores the rest", () => {
    const update = (changes: Record<string, unknown>) =>
      normalizeGitLabEvent({
        object_kind: "merge_request",
        user: { username: "alice" },
        project: PROJECT,
        object_attributes: { ...MR_ATTRS, action: "update" },
        changes,
      });
    const reviewed = update({ reviewers: { previous: [], current: [{ username: "jon" }] } })!;
    expect(reviewed.kinds).toEqual(["review_requested"]);
    expect(reviewed.targets).toEqual(["jon"]);
    const labeled = update({
      labels: {
        previous: [{ title: "backend" }],
        current: [{ title: "backend" }, { title: "urgent" }],
      },
    })!;
    expect(labeled.kinds).toEqual(["labeled"]);
    expect(labeled.label).toBe("urgent");
    expect(matchGitLabTrigger({ events: ["labeled"], labels: ["urgent"] }, labeled)).toBe(
      "labeled",
    );
    expect(matchGitLabTrigger({ events: ["labeled"], labels: ["backend"] }, labeled)).toBeNull();
    expect(update({ title: { previous: "a", current: "b" } })).toBeNull();
    expect(
      normalizeGitLabEvent({
        object_kind: "merge_request",
        user: { username: "alice" },
        project: PROJECT,
        object_attributes: { ...MR_ATTRS, action: "approved" },
      }),
    ).toBeNull();
  });

  it("sees a merge, an opened issue, a mention in a note, and a pipeline's result", () => {
    const merged = normalizeGitLabEvent({
      object_kind: "merge_request",
      user: { username: "alice" },
      project: PROJECT,
      object_attributes: { ...MR_ATTRS, action: "merge" },
    })!;
    expect(merged.kinds).toEqual(["mr_merged"]);

    const issue = normalizeGitLabEvent({
      object_kind: "issue",
      user: { username: "alice" },
      project: PROJECT,
      object_attributes: {
        iid: 3,
        title: "Login broken",
        description: "",
        action: "open",
        url: "https://gitlab.com/acme/optio/-/issues/3",
      },
      labels: [{ title: "bug" }],
    })!;
    expect(issue.kinds).toEqual(["issue_opened"]);
    expect(issue.kind).toBe("issue");
    expect(issue.labels).toEqual(["bug"]);

    const note = normalizeGitLabEvent({
      object_kind: "note",
      user: { username: "bob" },
      project: PROJECT,
      object_attributes: {
        note: "@jon ptal",
        noteable_type: "MergeRequest",
        url: "https://gitlab.com/acme/optio/-/merge_requests/7#note_1",
      },
      merge_request: MR_ATTRS,
    })!;
    expect(note.kinds).toEqual(["mentioned"]);
    expect(note.kind).toBe("mr");
    expect(note.commentBody).toBe("@jon ptal");
    expect(note.commentUrl).toBe("https://gitlab.com/acme/optio/-/merge_requests/7#note_1");
    expect(matchGitLabTrigger({ username: "jon" }, note)).toBe("mentioned");
    // Your own note mentioning yourself isn't a mention of you.
    expect(matchGitLabTrigger({ username: "jon" }, { ...note, author: "jon" })).toBeNull();
    expect(
      normalizeGitLabEvent({
        object_kind: "note",
        user: { username: "bob" },
        project: PROJECT,
        object_attributes: { note: "nice", noteable_type: "Commit", url: "" },
      }),
    ).toBeNull();

    const pipeline = (status: string, tag = false) =>
      normalizeGitLabEvent({
        object_kind: "pipeline",
        user: { username: "alice" },
        project: PROJECT,
        object_attributes: { id: 99, ref: "main", sha: "s1", status, tag },
        commit: { title: "fix: x", message: "fix: x" },
      });
    const failed = pipeline("failed")!;
    expect(failed.kinds).toEqual(["pipeline_failed"]);
    expect(failed.kind).toBe("pipeline");
    expect(failed.url).toBe("https://gitlab.com/acme/optio/-/pipelines/99");
    expect(failed.sourceBranch).toBe("main");
    expect(failed.pipelineStatus).toBe("failed");
    expect(failed.title).toBe("Pipeline failed on main: fix: x");
    expect(pipeline("success")!.kinds).toEqual(["pipeline_succeeded"]);
    expect(pipeline("running")).toBeNull();
    expect(pipeline("failed", true)).toBeNull();
    expect(matchGitLabTrigger({ events: ["pipeline_failed"], branches: ["main"] }, failed)).toBe(
      "pipeline_failed",
    );
    expect(
      matchGitLabTrigger({ events: ["pipeline_failed"], branches: ["release/*"] }, failed),
    ).toBeNull();

    const release = normalizeGitLabEvent({
      object_kind: "release",
      action: "create",
      name: "1.0",
      tag: "v1.0",
      description: "notes",
      url: "https://gitlab.com/acme/optio/-/releases/v1.0",
      project: PROJECT,
    })!;
    expect(release.kinds).toEqual(["release_published"]);
    expect(release.tag).toBe("v1.0");
    expect(
      normalizeGitLabEvent({ object_kind: "release", action: "update", project: PROJECT }),
    ).toBeNull();
  });

  it("renders params and a firing that links an MR as a ticket", () => {
    const ev = normalizeGitLabEvent({
      object_kind: "merge_request",
      user: { username: "alice" },
      project: PROJECT,
      object_attributes: MR_ATTRS,
    })!;
    expect(gitlabEventParams(ev, "mr_opened")).toMatchObject({
      source: "gitlab",
      event: "mr_opened",
      kind: "mr",
      project: "acme/optio",
      iid: "7",
      title: "feat: widgets",
      sourceBranch: "feat/widgets",
      targetBranch: "main",
      sha: "c1c1c1",
      action: "open",
    });
    const firing = firingFor("gitlab", ev, { events: ["mr_opened"] })!;
    expect(firing.matched).toBe("mr_opened");
    expect(firing.ticket).toEqual({
      source: "gitlab",
      externalId: "acme/optio!7",
      url: "https://gitlab.com/acme/optio/-/merge_requests/7",
    });
    expect(firing.title).toBe("MR !7 feat: widgets");
    expect(firing.repoUrlHint).toBe("https://gitlab.com/acme/optio");
    expect(firing.message).toContain("GitLab mr opened: acme/optio MR !7 — feat: widgets");
  });
});

// ── Jira ────────────────────────────────────────────────────────────────────

const JIRA_ISSUE = {
  id: "10001",
  key: "ENG-42",
  self: "https://acme.atlassian.net/rest/api/2/issue/10001",
  fields: {
    summary: "Login broken",
    description: "Please fix [~accountid:5b10ac8d]",
    status: { name: "To Do" },
    project: { key: "ENG", name: "Engineering" },
    assignee: { accountId: "5b10ac8d", displayName: "Jon Wiggins", emailAddress: "jon@acme.test" },
    priority: { name: "High" },
    labels: ["bug"],
    issuetype: { name: "Bug" },
  },
};

describe("Jira", () => {
  it("flattens ADF and finds mentions in wiki markup and ADF alike", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hi " },
            { type: "mention", attrs: { id: "5b10ac8d", text: "@Jon Wiggins" } },
          ],
        },
      ],
    };
    expect(jiraText(adf)).toBe("Hi @Jon Wiggins\n");
    expect(jiraText("plain")).toBe("plain");
    expect(jiraMentions(adf).sort()).toEqual(["5b10ac8d", "jon wiggins"]);
    expect(jiraMentions("[~accountid:5b10ac8d] and [~alice]").sort()).toEqual([
      "5b10ac8d",
      "alice",
    ]);
  });

  it("normalizes a created issue with its assignee and mentions, and a browse URL", () => {
    const ev = normalizeJiraEvent({
      webhookEvent: "jira:issue_created",
      issue_event_type_name: "issue_created",
      user: { accountId: "a1", displayName: "Alice" },
      issue: JIRA_ISSUE,
    })!;
    expect(ev.kinds.sort()).toEqual(["assigned", "created", "mentioned"]);
    expect(ev.targets).toEqual(
      expect.arrayContaining(["5b10ac8d", "jon wiggins", "jon@acme.test"]),
    );
    expect(ev.key).toBe("ENG-42");
    expect(ev.url).toBe("https://acme.atlassian.net/browse/ENG-42");
    expect(ev.project).toBe("ENG");
    expect(ev.projectName).toBe("Engineering");
    expect(ev.status).toBe("To Do");
    expect(ev.assignee).toBe("Jon Wiggins");
    expect(ev.priority).toBe("High");
    expect(ev.labels).toEqual(["bug"]);
    expect(ev.issueType).toBe("Bug");
    expect(ev.actor).toBe("Alice");
    expect(ev.actorKeys).toEqual(["a1", "alice"]);

    expect(matchJiraTrigger({ user: "Jon Wiggins" }, ev)).toBe("assigned");
    expect(matchJiraTrigger({ user: "5b10ac8d", events: ["mentioned"] }, ev)).toBe("mentioned");
    expect(matchJiraTrigger({ user: "someone", events: ["assigned", "mentioned"] }, ev)).toBeNull();
    // Each personal kind is about its own people: the mentioned one isn't "assigned".
    const mentionedOnly = normalizeJiraEvent({
      webhookEvent: "jira:issue_created",
      issue: {
        ...JIRA_ISSUE,
        fields: {
          ...JIRA_ISSUE.fields,
          assignee: { accountId: "b2", displayName: "Bob" },
          description: "see [~accountid:5b10ac8d]",
        },
      },
    })!;
    expect(mentionedOnly.assignees).toEqual(["b2", "bob"]);
    expect(mentionedOnly.mentions).toEqual(["5b10ac8d"]);
    expect(matchJiraTrigger({ user: "5b10ac8d" }, mentionedOnly)).toBe("mentioned");
    expect(matchJiraTrigger({ user: "bob" }, mentionedOnly)).toBe("assigned");
    expect(matchJiraTrigger({ events: ["created"] }, ev)).toBe("created");
    expect(matchJiraTrigger({ events: ["created"], projects: ["ops"] }, ev)).toBeNull();
    expect(matchJiraTrigger({ events: ["created"], projects: ["eng"] }, ev)).toBe("created");
    expect(matchJiraTrigger({ events: ["created"], issueTypes: ["Bug"] }, ev)).toBe("created");
    expect(matchJiraTrigger({ events: ["created"], issueTypes: ["Story"] }, ev)).toBeNull();
    expect(matchJiraTrigger({ events: ["created"], labels: ["docs"] }, ev)).toBeNull();
    expect(
      normalizeJiraEvent({ webhookEvent: "jira:issue_deleted", issue: JIRA_ISSUE }),
    ).toBeNull();
  });

  it("reads an update's changelog: a transition, new labels, a new assignee; ignores the rest", () => {
    const update = (items: Record<string, unknown>[], fields: Record<string, unknown> = {}) =>
      normalizeJiraEvent({
        webhookEvent: "jira:issue_updated",
        issue_event_type_name: "issue_generic",
        user: { accountId: "a1", displayName: "Alice" },
        issue: { ...JIRA_ISSUE, fields: { ...JIRA_ISSUE.fields, ...fields } },
        changelog: { items },
      });
    const moved = update([{ field: "status", fromString: "To Do", toString: "In Progress" }], {
      status: { name: "In Progress" },
    })!;
    expect(moved.kinds).toEqual(["transitioned"]);
    expect(moved.previousStatus).toBe("To Do");
    expect(moved.status).toBe("In Progress");
    expect(matchJiraTrigger({ events: ["transitioned"], statuses: ["in progress"] }, moved)).toBe(
      "transitioned",
    );
    expect(matchJiraTrigger({ events: ["transitioned"], statuses: ["Done"] }, moved)).toBeNull();

    expect(update([{ field: "labels", fromString: "bug", toString: "bug urgent" }])!.kinds).toEqual(
      ["labeled"],
    );
    expect(update([{ field: "labels", fromString: "bug urgent", toString: "bug" }])).toBeNull();
    const assigned = update([
      { field: "assignee", from: null, to: "5b10ac8d", fromString: null, toString: "Jon Wiggins" },
    ])!;
    expect(assigned.kinds).toEqual(["assigned"]);
    expect(matchJiraTrigger({ user: "jon wiggins" }, assigned)).toBe("assigned");
    expect(update([{ field: "summary", fromString: "a", toString: "b" }])).toBeNull();
  });

  it("normalizes a comment (either delivery) with its mentions, skipping your own", () => {
    const comment = (author: Record<string, unknown>) =>
      normalizeJiraEvent({
        webhookEvent: "comment_created",
        issue: JIRA_ISSUE,
        comment: { id: "77", body: "ping [~accountid:5b10ac8d]", author },
      })!;
    const ev = comment({ accountId: "a1", displayName: "Alice" });
    expect(ev.kinds.sort()).toEqual(["commented", "mentioned"]);
    expect(ev.commentBody).toBe("ping [~accountid:5b10ac8d]");
    expect(ev.commentUrl).toBe("https://acme.atlassian.net/browse/ENG-42?focusedCommentId=77");
    expect(ev.actor).toBe("Alice");
    expect(matchJiraTrigger({ user: "5b10ac8d" }, ev)).toBe("mentioned");
    expect(matchJiraTrigger({ events: ["commented"] }, ev)).toBe("commented");
    const own = comment({ accountId: "5b10ac8d", displayName: "Jon Wiggins" });
    expect(matchJiraTrigger({ user: "5b10ac8d", events: ["mentioned"] }, own)).toBeNull();
    expect(matchJiraTrigger({ events: ["commented"] }, own)).toBe("commented");

    // The same comment through the issue-updated webhook.
    const viaUpdate = normalizeJiraEvent({
      webhookEvent: "jira:issue_updated",
      issue_event_type_name: "issue_commented",
      user: { accountId: "a1", displayName: "Alice" },
      issue: JIRA_ISSUE,
      comment: { id: "77", body: "ping", author: { accountId: "a1", displayName: "Alice" } },
    })!;
    expect(viaUpdate.kinds).toEqual(["commented"]);
  });

  it("renders params with ticket aliases and a firing linked as a ticket", () => {
    const ev = normalizeJiraEvent({
      webhookEvent: "jira:issue_created",
      user: { accountId: "a1", displayName: "Alice" },
      issue: JIRA_ISSUE,
    })!;
    expect(jiraEventParams(ev, "created")).toMatchObject({
      source: "jira",
      event: "created",
      key: "ENG-42",
      title: "Login broken",
      project: "ENG",
      status: "To Do",
      assignee: "Jon Wiggins",
      labels: "bug",
      issueType: "Bug",
      ticketSource: "jira",
      ticketExternalId: "ENG-42",
      ticketUrl: "https://acme.atlassian.net/browse/ENG-42",
    });
    const firing = firingFor("jira", ev, { events: ["created"] })!;
    expect(firing.ticket).toEqual({
      source: "jira",
      externalId: "ENG-42",
      url: "https://acme.atlassian.net/browse/ENG-42",
    });
    expect(firing.title).toBe("ENG-42 Login broken");
    expect(firing.message).toContain("Jira created: ENG-42 — Login broken");
    expect(firing.message).toContain("Assignee: Jon Wiggins");
  });

  it("keeps a Jira Server context path in the browse URL", () => {
    const ev = normalizeJiraEvent({
      webhookEvent: "jira:issue_created",
      issue: { ...JIRA_ISSUE, self: "https://jira.acme.com/jira/rest/api/2/issue/10001" },
    })!;
    expect(ev.url).toBe("https://jira.acme.com/jira/browse/ENG-42");
  });
});

// ── Sentry ──────────────────────────────────────────────────────────────────

describe("Sentry", () => {
  const issue = (action: string) =>
    normalizeSentryEvent("issue", {
      action,
      installation: { uuid: "inst" },
      actor: { type: "application", id: "sentry", name: "Sentry" },
      data: {
        issue: {
          id: "123",
          shortId: "API-1A",
          title: "TypeError: x is undefined",
          culprit: "app/views.py in render",
          level: "error",
          status: "unresolved",
          project: { id: 1, slug: "api", name: "API" },
          web_url: "https://sentry.io/organizations/acme/issues/123/",
          count: "12",
          userCount: 3,
          firstSeen: "2026-10-01T00:00:00Z",
          lastSeen: "2026-10-02T00:00:00Z",
        },
      },
    });

  it("normalizes issue state changes", () => {
    const ev = issue("created")!;
    expect(ev.kind).toBe("issue_created");
    expect(ev.issueId).toBe("123");
    expect(ev.shortId).toBe("API-1A");
    expect(ev.project).toBe("api");
    expect(ev.projectName).toBe("API");
    expect(ev.level).toBe("error");
    expect(ev.count).toBe("12");
    expect(ev.userCount).toBe("3");
    expect(ev.url).toBe("https://sentry.io/organizations/acme/issues/123/");
    expect(ev.actor).toBe("Sentry");
    expect(ev.eventId).toBe("issue:created:123");
    expect(issue("resolved")!.kind).toBe("issue_resolved");
    expect(issue("assigned")!.kind).toBe("issue_assigned");
    expect(issue("archived")!.kind).toBe("issue_archived");
    expect(issue("ignored")!.kind).toBe("issue_archived");
    expect(issue("unresolved")!.kind).toBe("issue_unresolved");
    expect(issue("deleted")).toBeNull();
    expect(normalizeSentryEvent("installation", { action: "created" })).toBeNull();
    expect(normalizeSentryEvent("error", { action: "created", data: { error: {} } })).toBeNull();
  });

  it("normalizes an issue alert firing and a metric alert", () => {
    const alert = normalizeSentryEvent("event_alert", {
      action: "triggered",
      data: {
        event: {
          event_id: "e1",
          title: "ValueError",
          culprit: "c",
          level: "warning",
          project: 1,
          web_url: "https://sentry.io/organizations/acme/issues/999/events/e1/",
          issue_url: "https://sentry.io/api/0/issues/999/",
          tags: [
            ["level", "warning"],
            ["environment", "prod"],
          ],
        },
        triggered_rule: "High volume",
      },
    })!;
    expect(alert.kind).toBe("alert_triggered");
    expect(alert.issueId).toBe("999");
    expect(alert.environment).toBe("prod");
    expect(alert.level).toBe("warning");
    expect(alert.alertRule).toBe("High volume");
    expect(alert.project).toBe("1");

    const metric = normalizeSentryEvent("metric_alert", {
      action: "critical",
      data: {
        metric_alert: {
          id: "7",
          title: "Error rate",
          alert_rule: { name: "Error rate", projects: ["api"], environment: "prod" },
          status: 20,
          date_detected: "2026-10-01T00:00:00Z",
        },
        description_title: "Critical: Error rate",
        description_text: "1000 events in the last hour",
        web_url: "https://sentry.io/organizations/acme/alerts/7/",
      },
    })!;
    expect(metric.kind).toBe("metric_alert_critical");
    expect(metric.project).toBe("api");
    expect(metric.environment).toBe("prod");
    expect(metric.alertRule).toBe("Error rate");
    expect(metric.culprit).toBe("1000 events in the last hour");
    expect(metric.level).toBeNull();
    expect(
      normalizeSentryEvent("metric_alert", {
        action: "resolved",
        data: { metric_alert: { id: 7 } },
      })!.kind,
    ).toBe("metric_alert_resolved");
  });

  it("matches on kinds, projects, environments and levels; absent fields don't exclude", () => {
    const ev = issue("created")!;
    expect(matchSentryTrigger({}, ev)).toBe("issue_created");
    expect(matchSentryTrigger({ events: ["issue_created"], projects: ["API"] }, ev)).toBe(
      "issue_created",
    );
    expect(matchSentryTrigger({ events: ["issue_resolved"] }, ev)).toBeNull();
    expect(matchSentryTrigger({ projects: ["web"] }, ev)).toBeNull();
    expect(matchSentryTrigger({ levels: ["warning"] }, ev)).toBeNull();
    expect(matchSentryTrigger({ levels: ["error"] }, ev)).toBe("issue_created");
    // An issue names no environment: an environment filter doesn't exclude it.
    expect(matchSentryTrigger({ environments: ["prod"] }, ev)).toBe("issue_created");
    expect(
      matchSentryTrigger({ environments: ["prod"] }, { ...ev, environment: "staging" }),
    ).toBeNull();
  });

  it("renders params with ticket aliases and a firing titled by the short id", () => {
    const ev = issue("created")!;
    expect(sentryEventParams(ev)).toMatchObject({
      source: "sentry",
      event: "issue_created",
      issueId: "123",
      shortId: "API-1A",
      project: "api",
      level: "error",
      ticketSource: "sentry",
      ticketExternalId: "API-1A",
      ticketUrl: "https://sentry.io/organizations/acme/issues/123/",
    });
    const firing = firingFor("sentry", ev, { events: ["issue_created"] })!;
    expect(firing.title).toBe("API-1A TypeError: x is undefined");
    expect(firing.ticket).toEqual({
      source: "sentry",
      externalId: "API-1A",
      url: "https://sentry.io/organizations/acme/issues/123/",
    });
    expect(firing.message).toContain("Project: api · Level: error");
  });
});

// ── Alertmanager ────────────────────────────────────────────────────────────

const GROUP = {
  version: "4",
  groupKey: '{}:{alertname="HighLatency"}',
  truncatedAlerts: 0,
  status: "firing",
  receiver: "optio",
  groupLabels: { alertname: "HighLatency" },
  commonLabels: { alertname: "HighLatency", severity: "critical", service: "checkout" },
  commonAnnotations: { summary: "p99 over 2s" },
  externalURL: "https://am.acme.test",
  alerts: [
    {
      status: "firing",
      labels: { alertname: "HighLatency", severity: "critical", instance: "a" },
      annotations: { summary: "p99 over 2s", runbook_url: "https://rb" },
      startsAt: "2026-10-01T00:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL: "https://prom/graph",
      fingerprint: "f1",
    },
    {
      status: "firing",
      labels: { alertname: "HighLatency", severity: "critical", instance: "b" },
      annotations: {},
      startsAt: "2026-10-01T00:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL: "",
      fingerprint: "f2",
    },
  ],
};

describe("Alertmanager", () => {
  it("normalizes an alert group with a title and message of its own when none is sent", () => {
    const ev = normalizeAlertmanagerEvent(GROUP)!;
    expect(ev.kind).toBe("firing");
    expect(ev.receiver).toBe("optio");
    expect(ev.alertnames).toEqual(["HighLatency"]);
    expect(ev.severities).toEqual(["critical"]);
    expect(ev.title).toBe("[FIRING:2] HighLatency");
    expect(ev.message).toBe("HighLatency: p99 over 2s");
    expect(ev.firing).toBe(2);
    expect(ev.resolved).toBe(0);
    expect(ev.alerts[0]).toMatchObject({
      status: "firing",
      labels: { instance: "a" },
      annotations: { runbook_url: "https://rb" },
      generatorUrl: "https://prom/graph",
      fingerprint: "f1",
    });
    expect(ev.commonLabels.service).toBe("checkout");
  });

  it("takes Grafana's title and message, and a resolved group", () => {
    const grafana = normalizeAlertmanagerEvent({
      ...GROUP,
      status: "resolved",
      title: "[RESOLVED] HighLatency",
      message: "All good",
      alerts: GROUP.alerts.map((a) => ({ ...a, status: "resolved", dashboardURL: "https://g/d" })),
    })!;
    expect(grafana.kind).toBe("resolved");
    expect(grafana.title).toBe("[RESOLVED] HighLatency");
    expect(grafana.message).toBe("All good");
    expect(grafana.resolved).toBe(2);
    expect(grafana.alerts[0].dashboardUrl).toBe("https://g/d");
    expect(normalizeAlertmanagerEvent({})).toBeNull();
    expect(normalizeAlertmanagerEvent("nope")).toBeNull();
  });

  it("matches on status, alert names, severities and receiver", () => {
    const ev = normalizeAlertmanagerEvent(GROUP)!;
    expect(matchAlertmanagerTrigger({}, ev)).toBe("firing");
    expect(matchAlertmanagerTrigger({ events: ["firing"], alertnames: ["highlatency"] }, ev)).toBe(
      "firing",
    );
    expect(matchAlertmanagerTrigger({ events: ["resolved"] }, ev)).toBeNull();
    expect(matchAlertmanagerTrigger({ alertnames: ["DiskFull"] }, ev)).toBeNull();
    expect(matchAlertmanagerTrigger({ severities: ["warning"] }, ev)).toBeNull();
    expect(matchAlertmanagerTrigger({ severities: ["Critical"] }, ev)).toBe("firing");
    expect(matchAlertmanagerTrigger({ receivers: ["other"] }, ev)).toBeNull();
  });

  it("renders params with the alerts as JSON and a firing that lists them", () => {
    const ev = normalizeAlertmanagerEvent(GROUP)!;
    const params = alertmanagerEventParams(ev);
    expect(params).toMatchObject({
      source: "alertmanager",
      event: "firing",
      receiver: "optio",
      title: "[FIRING:2] HighLatency",
      alertnames: "HighLatency",
      severities: "critical",
      count: "2",
      firing: "2",
      resolved: "0",
      externalUrl: "https://am.acme.test",
    });
    expect(JSON.parse(params.labels)).toEqual(GROUP.commonLabels);
    expect(JSON.parse(params.alerts)).toHaveLength(2);
    const firing = firingFor("alertmanager", ev, { events: ["firing"] })!;
    expect(firing.title).toBe("[FIRING:2] HighLatency");
    expect(firing.ticket).toBeUndefined();
    expect(firing.message).toContain("Alertmanager firing: [FIRING:2] HighLatency");
    expect(firing.message).toContain(
      "- [firing] alertname=HighLatency severity=critical instance=a",
    );
  });
});

// ── Datadog ─────────────────────────────────────────────────────────────────

const DATADOG = {
  id: "123",
  event_type: "query_alert_monitor",
  title: "[Triggered] CPU high on web-1",
  body: "CPU over 90% for 5 minutes",
  date: "1700000000000",
  alert_id: "555",
  alert_title: "CPU high",
  alert_transition: "Triggered",
  alert_type: "error",
  alert_status: "",
  alert_query: "avg(last_5m):avg:system.cpu.user{*} > 90",
  alert_scope: "host:web-1",
  alert_metric: "system.cpu.user",
  priority: "p1",
  tags: "env:prod, team:core",
  hostname: "web-1",
  link: "https://app.datadoghq.com/event/event?id=123",
  org: { id: "1", name: "Acme" },
};

describe("Datadog", () => {
  it("maps transitions (and alert types when there's none) to kinds", () => {
    expect(datadogKindOf("Triggered", "")).toBe("triggered");
    expect(datadogKindOf("Re-Triggered", "")).toBe("triggered");
    expect(datadogKindOf("Recovered", "")).toBe("recovered");
    expect(datadogKindOf("Warn", "")).toBe("warning");
    expect(datadogKindOf("No Data", "")).toBe("no_data");
    expect(datadogKindOf("", "error")).toBe("triggered");
    expect(datadogKindOf("", "warning")).toBe("warning");
    expect(datadogKindOf("", "success")).toBe("recovered");
    expect(datadogKindOf("", "info")).toBeNull();
    expect(datadogKindOf("", "")).toBeNull();
  });

  it("normalizes the recommended template, and the default one", () => {
    const ev = normalizeDatadogEvent(DATADOG);
    expect(ev.kind).toBe("triggered");
    expect(ev.transition).toBe("Triggered");
    expect(ev.alertType).toBe("error");
    expect(ev.eventId).toBe("123");
    expect(ev.alertId).toBe("555");
    expect(ev.title).toBe("[Triggered] CPU high on web-1");
    expect(ev.body).toBe("CPU over 90% for 5 minutes");
    expect(ev.priority).toBe("P1");
    expect(ev.tags).toEqual(["env:prod", "team:core"]);
    expect(ev.hostname).toBe("web-1");
    expect(ev.query).toContain("system.cpu.user");
    expect(ev.scope).toBe("host:web-1");
    expect(ev.metric).toBe("system.cpu.user");
    expect(ev.org).toBe("Acme");
    expect(ev.link).toContain("datadoghq.com");

    const plain = normalizeDatadogEvent({
      body: "msg",
      last_updated: "1700000000000",
      event_type: "query_alert_monitor",
      title: "[Recovered] CPU high",
      date: "1700000000000",
      org: { id: "1", name: "Acme" },
      id: "9",
    });
    expect(plain.kind).toBeNull();
    expect(plain.title).toBe("[Recovered] CPU high");
    expect(plain.date).toBe("1700000000000");
    expect(normalizeDatadogEvent("nope").kind).toBeNull();
    expect(
      normalizeDatadogEvent({ $ALERT_TRANSITION: "Recovered", tags: ["a", "b"] }),
    ).toMatchObject({ kind: "recovered", tags: ["a", "b"] });
  });

  it("matches on kind, priority, tags and monitor; a payload with no transition only matches unfiltered", () => {
    const ev = normalizeDatadogEvent(DATADOG);
    expect(matchDatadogTrigger({}, ev)).toBe("triggered");
    expect(matchDatadogTrigger({ events: ["triggered"], priorities: ["P1"] }, ev)).toBe(
      "triggered",
    );
    expect(matchDatadogTrigger({ events: ["recovered"] }, ev)).toBeNull();
    expect(matchDatadogTrigger({ priorities: ["P3"] }, ev)).toBeNull();
    expect(matchDatadogTrigger({ tags: ["team:core"] }, ev)).toBe("triggered");
    expect(matchDatadogTrigger({ tags: ["team:web"] }, ev)).toBeNull();
    expect(matchDatadogTrigger({ monitors: ["cpu high"] }, ev)).toBe("triggered");
    expect(matchDatadogTrigger({ monitors: ["555"] }, ev)).toBe("triggered");
    expect(matchDatadogTrigger({ monitors: ["disk"] }, ev)).toBeNull();
    const bare = normalizeDatadogEvent({ title: "x" });
    expect(matchDatadogTrigger({}, bare)).toBe("any");
    expect(matchDatadogTrigger({ events: ["triggered"] }, bare)).toBeNull();
  });

  it("renders params and a firing titled by the event", () => {
    const ev = normalizeDatadogEvent(DATADOG);
    const params = datadogEventParams(ev);
    expect(params).toMatchObject({
      source: "datadog",
      event: "triggered",
      transition: "Triggered",
      alertId: "555",
      priority: "P1",
      tags: "env:prod,team:core",
      hostname: "web-1",
      org: "Acme",
    });
    expect(JSON.parse(params.payload)).toMatchObject({ alert_id: "555" });
    const firing = firingFor("datadog", ev, { events: ["triggered"] })!;
    expect(firing.matched).toBe("triggered");
    expect(firing.title).toBe("[Triggered] CPU high on web-1");
    expect(firing.message).toContain("Datadog Triggered: [Triggered] CPU high on web-1");
    expect(firing.message).toContain("Priority: P1 · Host: web-1 · Tags: env:prod, team:core");
    expect(firingFor("datadog", ev, { events: ["recovered"] })).toBeNull();
  });
});

// ── GitHub conversation, repo and security events (#687) ───────────────────

describe("GitHub conversation events", () => {
  const issue = {
    number: 12,
    title: "Crash on start",
    body: "It crashes",
    html_url: "https://github.com/acme/optio/issues/12",
    user: { login: "Reporter" },
    labels: [{ name: "needs-info" }],
  };
  const comment = (login: string, body: string, type = "User") =>
    normalizeGitHubEvent("issue_comment", {
      action: "created",
      repository: REPO,
      issue,
      comment: { body, html_url: "https://c/1", user: { login, type } },
      sender: { login, type },
    })!;

  it("normalizes an issue comment with who wrote it, and tells people from bots", () => {
    const ev = comment("Reporter", "Here are the logs");
    expect(ev.kinds).toEqual(["issue_commented"]);
    expect(ev.kind).toBe("issue");
    expect(ev.author).toBe("Reporter");
    expect(ev.actor).toBe("reporter");
    expect(ev.actorIsBot).toBe(false);
    expect(ev.commentBody).toBe("Here are the logs");
    expect(ev.labels).toEqual(["needs-info"]);
    expect(comment("optio-triage[bot]", "What version?").actorIsBot).toBe(true);
    expect(comment("optio-app", "What version?", "Bot").actorIsBot).toBe(true);
  });

  it("fires the triage flow: the reporter's reply on a needs-info issue, never the agent's own comment", () => {
    const triage = {
      events: ["issue_commented", "issue_edited"] as const,
      labels: ["needs-info"],
      authorOnly: true,
    };
    const config = { ...triage, events: [...triage.events] };
    expect(matchGitHubTrigger(config, comment("reporter", "Version 1.2"))).toBe("issue_commented");
    // Someone else chiming in isn't the author.
    expect(matchGitHubTrigger(config, comment("bystander", "same here"))).toBeNull();
    // The agent's own comment: a bot by default, and never the trigger's own login.
    expect(matchGitHubTrigger(config, comment("optio[bot]", "What version?"))).toBeNull();
    expect(
      matchGitHubTrigger(
        { events: ["issue_commented"], login: "Optio-Agent" },
        comment("optio-agent", "What version?"),
      ),
    ).toBeNull();
    expect(
      matchGitHubTrigger(
        { events: ["issue_commented"], ignoreLogins: ["@Helper"] },
        comment("helper", "I can help"),
      ),
    ).toBeNull();
    // Without the label the issue doesn't qualify.
    const unlabeled = normalizeGitHubEvent("issue_comment", {
      action: "created",
      repository: REPO,
      issue: { ...issue, labels: [] },
      comment: { body: "Version 1.2", user: { login: "reporter" } },
    })!;
    expect(matchGitHubTrigger(config, unlabeled)).toBeNull();
  });

  it("ignores ignoreLogins for every kind, and the trigger's own login for what it writes", () => {
    const pr = {
      number: 5,
      title: "fix: y",
      body: "",
      html_url: "https://github.com/acme/optio/pull/5",
      user: { login: "alice" },
      head: { ref: "fix/y" },
      base: { ref: "main" },
    };
    // An agent pushing fixes to a PR with a personal token is a person to GitHub.
    const sync = normalizeGitHubEvent("pull_request", {
      action: "synchronize",
      repository: REPO,
      pull_request: pr,
      sender: { login: "Optio-Agent", type: "User" },
    })!;
    expect(matchGitHubTrigger({ events: ["pr_synchronized"], postedBy: "anyone" }, sync)).toBe(
      "pr_synchronized",
    );
    expect(
      matchGitHubTrigger(
        { events: ["pr_synchronized"], postedBy: "anyone", ignoreLogins: ["@optio-agent"] },
        sync,
      ),
    ).toBeNull();
    expect(
      matchGitHubTrigger(
        { events: ["pr_synchronized"], postedBy: "anyone", login: "optio-agent" },
        sync,
      ),
    ).toBeNull();
    // A push to a PR by an App is a bot's: people-only by default.
    const botSync = normalizeGitHubEvent("pull_request", {
      action: "synchronize",
      repository: REPO,
      pull_request: pr,
      sender: { login: "optio-app[bot]", type: "Bot" },
    })!;
    expect(matchGitHubTrigger({ events: ["pr_synchronized"] }, botSync)).toBeNull();
    expect(matchGitHubTrigger({ events: ["pr_synchronized"], postedBy: "bots" }, botSync)).toBe(
      "pr_synchronized",
    );
    // A PR the agent opens doesn't wake a reviewer that ignores it.
    const opened = normalizeGitHubEvent("pull_request", {
      action: "opened",
      repository: REPO,
      pull_request: { ...pr, user: { login: "optio-agent" } },
      sender: { login: "optio-agent" },
    })!;
    expect(matchGitHubTrigger({ events: ["pr_opened"] }, opened)).toBe("pr_opened");
    expect(
      matchGitHubTrigger({ events: ["pr_opened"], ignoreLogins: ["Optio-Agent"] }, opened),
    ).toBeNull();
    // `login` only skips what that account writes; assigning yourself still fires `assigned`.
    const selfAssigned = normalizeGitHubEvent("issues", {
      action: "assigned",
      repository: REPO,
      issue: { ...pr, user: { login: "someone" } },
      assignee: { login: "jon" },
      sender: { login: "jon" },
    })!;
    expect(matchGitHubTrigger({ events: ["assigned"], login: "jon" }, selfAssigned)).toBe(
      "assigned",
    );
    expect(
      matchGitHubTrigger(
        { events: ["assigned"], login: "jon", ignoreLogins: ["jon"] },
        selfAssigned,
      ),
    ).toBeNull();
  });

  it("filters who fires it with postedBy, like Slack", () => {
    const person = comment("reporter", "hi");
    const bot = comment("dependabot[bot]", "bump");
    expect(matchGitHubTrigger({ events: ["issue_commented"] }, bot)).toBeNull();
    expect(matchGitHubTrigger({ events: ["issue_commented"], postedBy: "bots" }, bot)).toBe(
      "issue_commented",
    );
    expect(
      matchGitHubTrigger({ events: ["issue_commented"], postedBy: "bots" }, person),
    ).toBeNull();
    expect(matchGitHubTrigger({ events: ["issue_commented"], postedBy: "anyone" }, bot)).toBe(
      "issue_commented",
    );
    expect(matchGitHubTrigger({ events: ["issue_commented"], postedBy: "anyone" }, person)).toBe(
      "issue_commented",
    );
    // postedBy is about who writes; a bot's push still fires `push`.
    const botPush = normalizeGitHubEvent("push", {
      ref: "refs/heads/main",
      after: "b1c2d3e4f5a6",
      repository: REPO,
      pusher: { name: "github-actions[bot]" },
      sender: { login: "github-actions[bot]", type: "Bot" },
      head_commit: { id: "b1c2d3e4f5a6", message: "chore: release" },
      commits: [],
    })!;
    expect(matchGitHubTrigger({ events: ["push"] }, botPush)).toBe("push");
  });

  it("matches slash commands with bodyMatches, as a prefix or a regex", () => {
    const retry = comment("reporter", "  /optio retry");
    const chat = comment("reporter", "could you /optio retry this?");
    expect(
      matchGitHubTrigger({ events: ["issue_commented"], bodyMatches: "/optio retry" }, retry),
    ).toBe("issue_commented");
    expect(
      matchGitHubTrigger({ events: ["issue_commented"], bodyMatches: "/optio retry" }, chat),
    ).toBeNull();
    expect(
      matchGitHubTrigger(
        { events: ["issue_commented"], bodyMatches: "/\\/optio (retry|rerun)/i" },
        chat,
      ),
    ).toBe("issue_commented");
    // Mentions prefer the personal kind; a slash command on a trigger that has both still fires once.
    const both = comment("reporter", "/optio retry @bot");
    expect(
      matchGitHubTrigger(
        { events: ["issue_commented", "mentioned"], login: "bot", bodyMatches: "/optio" },
        both,
      ),
    ).toBe("mentioned");
  });

  it("normalizes an issue edit with what changed, a reopen, a close, and a label leaving", () => {
    const edited = normalizeGitHubEvent("issues", {
      action: "edited",
      repository: REPO,
      issue: { ...issue, body: "It crashes on 1.2 with this trace: …" },
      changes: { body: { from: "It crashes" }, title: { from: "Crash" } },
      sender: { login: "Reporter" },
    })!;
    expect(edited.kinds).toEqual(["issue_edited"]);
    expect(edited.actor).toBe("reporter");
    expect(edited.changes).toBe("body (before):\nIt crashes\ntitle: Crash → Crash on start");
    expect(matchGitHubTrigger({ events: ["issue_edited"], authorOnly: true }, edited)).toBe(
      "issue_edited",
    );
    const editedByOther = normalizeGitHubEvent("issues", {
      action: "edited",
      repository: REPO,
      issue,
      changes: { title: { from: "Crash" } },
      sender: { login: "maintainer" },
    })!;
    expect(
      matchGitHubTrigger({ events: ["issue_edited"], authorOnly: true }, editedByOther),
    ).toBeNull();
    expect(matchGitHubTrigger({ events: ["issue_edited"] }, editedByOther)).toBe("issue_edited");

    const reopened = normalizeGitHubEvent("issues", {
      action: "reopened",
      repository: REPO,
      issue,
    })!;
    expect(reopened.kinds).toEqual(["issue_reopened"]);
    const closed = normalizeGitHubEvent("issues", { action: "closed", repository: REPO, issue })!;
    expect(closed.kinds).toEqual(["issue_closed"]);
    expect(matchGitHubTrigger({ events: ["issue_closed"], labels: ["bug"] }, closed)).toBeNull();

    const unlabeled = normalizeGitHubEvent("issues", {
      action: "unlabeled",
      repository: REPO,
      issue: { ...issue, labels: [] },
      label: { name: "needs-info" },
    })!;
    expect(unlabeled.kinds).toEqual(["unlabeled"]);
    expect(unlabeled.label).toBe("needs-info");
    expect(matchGitHubTrigger({ events: ["unlabeled"], labels: ["needs-info"] }, unlabeled)).toBe(
      "unlabeled",
    );
    expect(matchGitHubTrigger({ events: ["unlabeled"], labels: ["bug"] }, unlabeled)).toBeNull();
    // An edit's params carry the changes; a firing's message shows them.
    expect(githubEventParams(edited, "issue_edited")).toMatchObject({
      event: "issue_edited",
      actor: "reporter",
      changes: expect.stringContaining("body (before)"),
      commentAuthor: "",
    });
    const firing = firingFor("github", edited, { events: ["issue_edited"] })!;
    expect(firing.message).toContain("GitHub issue edited: acme/optio Issue #12");
    expect(firing.message).toContain("body (before):");
  });

  it("normalizes PR comments, review comments, submitted reviews and new commits", () => {
    const pr = {
      number: 42,
      title: "feat: x",
      body: "",
      html_url: "https://github.com/acme/optio/pull/42",
      user: { login: "alice" },
      head: { ref: "feat/x" },
      base: { ref: "main" },
    };
    const prComment = normalizeGitHubEvent("issue_comment", {
      action: "created",
      repository: REPO,
      issue: { ...pr, pull_request: { url: "x" } },
      comment: { body: "/optio retry", user: { login: "bob" } },
    })!;
    expect(prComment.kinds).toEqual(["pr_commented"]);
    expect(prComment.kind).toBe("pr");
    expect(matchGitHubTrigger({ events: ["issue_commented"] }, prComment)).toBeNull();
    expect(matchGitHubTrigger({ events: ["pr_commented"] }, prComment)).toBe("pr_commented");

    const lineComment = normalizeGitHubEvent("pull_request_review_comment", {
      action: "created",
      repository: REPO,
      pull_request: pr,
      comment: { body: "nit: rename", html_url: "https://c/2", user: { login: "carol" } },
    })!;
    expect(lineComment.kinds).toEqual(["pr_commented"]);
    expect(lineComment.actor).toBe("carol");

    const review = normalizeGitHubEvent("pull_request_review", {
      action: "submitted",
      repository: REPO,
      pull_request: pr,
      review: {
        state: "changes_requested",
        body: "Please add tests",
        html_url: "https://r/1",
        user: { login: "dave" },
      },
      sender: { login: "dave" },
    })!;
    expect(review.kinds).toEqual(["pr_review_submitted"]);
    expect(review.reviewState).toBe("changes_requested");
    expect(matchGitHubTrigger({ events: ["pr_review_submitted"] }, review)).toBe(
      "pr_review_submitted",
    );
    expect(
      matchGitHubTrigger(
        { events: ["pr_review_submitted"], reviewStates: ["changes_requested"] },
        review,
      ),
    ).toBe("pr_review_submitted");
    expect(
      matchGitHubTrigger({ events: ["pr_review_submitted"], reviewStates: ["approved"] }, review),
    ).toBeNull();
    // The PR author reviewing their own PR (a comment review) isn't a review by someone else.
    expect(
      matchGitHubTrigger({ events: ["pr_review_submitted"], authorOnly: true }, review),
    ).toBeNull();
    expect(githubEventParams(review, "pr_review_submitted")).toMatchObject({
      reviewState: "changes_requested",
      commentAuthor: "dave",
      commentBody: "Please add tests",
    });
    const firing = firingFor("github", review, { events: ["pr_review_submitted"] })!;
    expect(firing.message).toContain("dave (changes requested): Please add tests");
    expect(firing.ticket).toEqual({
      source: "github",
      externalId: "acme/optio#42",
      url: "https://github.com/acme/optio/pull/42",
    });
    // An approval with no body still fires (nothing for bodyMatches to read, unless one is
    // set), and names who approved.
    const bare = normalizeGitHubEvent("pull_request_review", {
      action: "submitted",
      repository: REPO,
      pull_request: pr,
      review: { state: "approved", body: null, user: { login: "dave" } },
    })!;
    expect(matchGitHubTrigger({ events: ["pr_review_submitted"] }, bare)).toBe(
      "pr_review_submitted",
    );
    expect(
      matchGitHubTrigger({ events: ["pr_review_submitted"], bodyMatches: "LGTM" }, bare),
    ).toBeNull();
    expect(githubEventParams(bare, "pr_review_submitted")).toMatchObject({
      reviewState: "approved",
      commentAuthor: "dave",
      commentBody: "",
    });
    // The empty "commented" review GitHub wraps around every single inline
    // comment isn't a review (the comment itself arrives as pr_commented).
    expect(
      normalizeGitHubEvent("pull_request_review", {
        action: "submitted",
        repository: REPO,
        pull_request: pr,
        review: { state: "commented", body: "", user: { login: "dave" } },
      }),
    ).toBeNull();
    const commentedReview = normalizeGitHubEvent("pull_request_review", {
      action: "submitted",
      repository: REPO,
      pull_request: pr,
      review: { state: "commented", body: "Overall fine, two nits", user: { login: "dave" } },
    })!;
    expect(commentedReview.kinds).toEqual(["pr_review_submitted"]);

    const sync = normalizeGitHubEvent("pull_request", {
      action: "synchronize",
      repository: REPO,
      pull_request: pr,
      after: "c0ffee",
    })!;
    expect(sync.kinds).toEqual(["pr_synchronized"]);
    expect(sync.headBranch).toBe("feat/x");
    expect(matchGitHubTrigger({ events: ["pr_synchronized"] }, sync)).toBe("pr_synchronized");
  });

  it("normalizes discussions and their comments", () => {
    const discussion = {
      number: 3,
      title: "How do I deploy?",
      body: "cc @helper",
      html_url: "https://github.com/acme/optio/discussions/3",
      user: { login: "newbie" },
      labels: [{ name: "question" }],
    };
    const created = normalizeGitHubEvent("discussion", {
      action: "created",
      repository: REPO,
      discussion,
      sender: { login: "newbie" },
    })!;
    expect(created.kinds.sort()).toEqual(["discussion_created", "mentioned"]);
    expect(created.kind).toBe("discussion");
    expect(
      matchGitHubTrigger({ events: ["discussion_created"], labels: ["question"] }, created),
    ).toBe("discussion_created");
    const firing = firingFor("github", created, { events: ["discussion_created"] })!;
    expect(firing.title).toBe("Discussion #3 How do I deploy?");
    expect(firing.ticket).toBeUndefined();

    const commented = normalizeGitHubEvent("discussion_comment", {
      action: "created",
      repository: REPO,
      discussion,
      comment: { body: "Use helm", html_url: "https://d/1", user: { login: "helper" } },
      sender: { login: "helper" },
    })!;
    expect(commented.kinds).toEqual(["discussion_commented"]);
    expect(commented.actor).toBe("helper");
    expect(
      matchGitHubTrigger({ events: ["discussion_commented"], authorOnly: true }, commented),
    ).toBeNull();
    expect(matchGitHubTrigger({ events: ["discussion_commented"] }, commented)).toBe(
      "discussion_commented",
    );
    expect(
      normalizeGitHubEvent("discussion", { action: "edited", repository: REPO, discussion }),
    ).toBeNull();
  });
});

describe("GitHub repo and security events", () => {
  it("normalizes branches created and deleted, matching them on branch patterns", () => {
    const created = normalizeGitHubEvent("create", {
      ref: "release/1.3",
      ref_type: "branch",
      master_branch: "main",
      description: "Optio",
      repository: REPO,
      sender: { login: "alice" },
    })!;
    expect(created.kinds).toEqual(["branch_created"]);
    expect(created.kind).toBe("branch");
    expect(created.headBranch).toBe("release/1.3");
    expect(created.baseBranch).toBe("main");
    expect(created.url).toBe("https://github.com/acme/optio/tree/release/1.3");
    expect(
      matchGitHubTrigger({ events: ["branch_created"], branches: ["release/*"] }, created),
    ).toBe("branch_created");
    expect(
      matchGitHubTrigger({ events: ["branch_created"], branches: ["main"] }, created),
    ).toBeNull();
    // A new tag comes through `push` as `tag_pushed`; `create` doesn't double it.
    expect(
      normalizeGitHubEvent("create", { ref: "v1", ref_type: "tag", repository: REPO }),
    ).toBeNull();
    const deleted = normalizeGitHubEvent("delete", {
      ref: "feat/old",
      ref_type: "branch",
      repository: REPO,
      sender: { login: "alice" },
    })!;
    expect(deleted.kinds).toEqual(["branch_deleted"]);
    expect(deleted.headBranch).toBe("feat/old");
    expect(
      normalizeGitHubEvent("delete", { ref: "v1", ref_type: "tag", repository: REPO }),
    ).toBeNull();
  });

  it("normalizes a deployment's final status, not a pending one", () => {
    const status = (state: string) =>
      normalizeGitHubEvent("deployment_status", {
        action: "created",
        repository: REPO,
        deployment_status: {
          state,
          description: "Deploy finished",
          target_url: "https://deploys/1",
          environment: "production",
          creator: { login: "deploy-bot[bot]", type: "Bot" },
        },
        deployment: { ref: "main", sha: "abc123", environment: "production", description: "" },
        sender: { login: "deploy-bot[bot]", type: "Bot" },
      });
    const ok = status("success")!;
    expect(ok.kinds).toEqual(["deployment_succeeded"]);
    expect(ok.kind).toBe("deployment");
    expect(ok.environment).toBe("production");
    expect(ok.headBranch).toBe("main");
    expect(ok.sha).toBe("abc123");
    expect(ok.title).toBe("Deployment to production success (main)");
    expect(ok.url).toBe("https://deploys/1");
    const failed = status("failure")!;
    expect(failed.kinds).toEqual(["deployment_failed"]);
    expect(status("error")!.kinds).toEqual(["deployment_failed"]);
    expect(status("pending")).toBeNull();
    expect(status("in_progress")).toBeNull();
    expect(matchGitHubTrigger({ events: ["deployment_failed"], branches: ["main"] }, failed)).toBe(
      "deployment_failed",
    );
    expect(
      matchGitHubTrigger({ events: ["deployment_failed"], branches: ["staging"] }, failed),
    ).toBeNull();
    expect(githubEventParams(failed, "deployment_failed")).toMatchObject({
      environment: "production",
      conclusion: "failure",
    });
  });

  it("normalizes a repository_dispatch with its event type and client payload", () => {
    const ev = normalizeGitHubEvent("repository_dispatch", {
      action: "deploy-docs",
      branch: "main",
      client_payload: { version: "1.2.3", urgent: true },
      repository: REPO,
      sender: { login: "ci-user" },
    })!;
    expect(ev.kinds).toEqual(["repository_dispatch"]);
    expect(ev.kind).toBe("dispatch");
    expect(ev.title).toBe("deploy-docs");
    expect(ev.dispatchType).toBe("deploy-docs");
    expect(ev.dispatchPayload).toBe('{"version":"1.2.3","urgent":true}');
    expect(matchGitHubTrigger({ events: ["repository_dispatch"] }, ev)).toBe("repository_dispatch");
    expect(githubEventParams(ev, "repository_dispatch")).toMatchObject({
      dispatchType: "deploy-docs",
      dispatchPayload: '{"version":"1.2.3","urgent":true}',
    });
    const firing = firingFor("github", ev, {})!;
    expect(firing.title).toBe("deploy-docs");
    expect(firing.ticket).toBeUndefined();
    // No payload at all is still a dispatch.
    expect(
      normalizeGitHubEvent("repository_dispatch", { action: "ping", repository: REPO })!.kinds,
    ).toEqual(["repository_dispatch"]);
  });

  it("normalizes Dependabot, code scanning and secret scanning alerts, filtered by severity", () => {
    const dependabot = normalizeGitHubEvent("dependabot_alert", {
      action: "created",
      repository: REPO,
      alert: {
        number: 7,
        html_url: "https://github.com/acme/optio/security/dependabot/7",
        dependency: { package: { ecosystem: "npm", name: "lodash" } },
        security_advisory: {
          summary: "Prototype pollution",
          description: "Details…",
          severity: "high",
        },
        security_vulnerability: {
          severity: "HIGH",
          vulnerable_version_range: "< 4.17.21",
          first_patched_version: { identifier: "4.17.21" },
        },
      },
      sender: { login: "github" },
    })!;
    expect(dependabot.kinds).toEqual(["dependabot_alert"]);
    expect(dependabot.kind).toBe("alert");
    expect(dependabot.number).toBe(7);
    expect(dependabot.severity).toBe("high");
    expect(dependabot.title).toBe("Prototype pollution");
    expect(dependabot.body).toContain("Package: lodash (npm)");
    expect(dependabot.body).toContain("Patched in: 4.17.21");
    expect(
      matchGitHubTrigger(
        { events: ["dependabot_alert"], severities: ["critical", "High"] },
        dependabot,
      ),
    ).toBe("dependabot_alert");
    expect(
      matchGitHubTrigger({ events: ["dependabot_alert"], severities: ["critical"] }, dependabot),
    ).toBeNull();
    expect(
      normalizeGitHubEvent("dependabot_alert", {
        action: "fixed",
        repository: REPO,
        alert: { number: 7 },
      }),
    ).toBeNull();
    expect(
      normalizeGitHubEvent("dependabot_alert", {
        action: "auto_reopened",
        repository: REPO,
        alert: { number: 7 },
      })!.kinds,
    ).toEqual(["dependabot_alert"]);
    expect(githubEventParams(dependabot, "dependabot_alert")).toMatchObject({
      alertSeverity: "high",
      number: "7",
    });

    const codeql = normalizeGitHubEvent("code_scanning_alert", {
      action: "created",
      ref: "refs/heads/main",
      commit_oid: "deadbeef",
      repository: REPO,
      alert: {
        number: 3,
        html_url: "https://github.com/acme/optio/security/code-scanning/3",
        rule: {
          id: "js/sql-injection",
          description: "SQL injection",
          security_severity_level: "critical",
        },
        tool: { name: "CodeQL" },
        most_recent_instance: {
          ref: "refs/heads/main",
          message: { text: "Query built from user input" },
          location: { path: "src/db.ts", start_line: 42 },
        },
      },
    })!;
    expect(codeql.kinds).toEqual(["code_scanning_alert"]);
    expect(codeql.severity).toBe("critical");
    expect(codeql.title).toBe("SQL injection");
    expect(codeql.headBranch).toBe("main");
    expect(codeql.sha).toBe("deadbeef");
    expect(codeql.body).toContain("src/db.ts:42");
    expect(
      matchGitHubTrigger({ events: ["code_scanning_alert"], severities: ["critical"] }, codeql),
    ).toBe("code_scanning_alert");
    expect(
      normalizeGitHubEvent("code_scanning_alert", {
        action: "closed_by_user",
        repository: REPO,
        alert: {},
      }),
    ).toBeNull();

    const secret = normalizeGitHubEvent("secret_scanning_alert", {
      action: "created",
      repository: REPO,
      alert: {
        number: 1,
        html_url: "https://github.com/acme/optio/security/secret-scanning/1",
        secret_type: "aws_access_key_id",
        secret_type_display_name: "Amazon AWS Access Key ID",
        publicly_leaked: true,
      },
    })!;
    expect(secret.kinds).toEqual(["secret_scanning_alert"]);
    expect(secret.title).toBe("Amazon AWS Access Key ID detected");
    expect(secret.severity).toBeNull();
    expect(secret.body).toContain("Publicly leaked");
    // No severity to compare: a severities filter doesn't exclude it.
    expect(
      matchGitHubTrigger({ events: ["secret_scanning_alert"], severities: ["critical"] }, secret),
    ).toBe("secret_scanning_alert");
    expect(
      normalizeGitHubEvent("secret_scanning_alert", {
        action: "resolved",
        repository: REPO,
        alert: {},
      }),
    ).toBeNull();
    const firing = firingFor("github", secret, { events: ["secret_scanning_alert"] })!;
    expect(firing.title).toBe("Amazon AWS Access Key ID detected");
    expect(firing.message).toContain(
      "GitHub secret scanning alert: acme/optio — Amazon AWS Access Key ID detected",
    );
  });
});
