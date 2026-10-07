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
    expect(push({ ref: "refs/tags/v1" })).toBeNull();
    expect(push({ deleted: true })).toBeNull();
    expect(push({ after: "0000000000000000000000000000000000000000" })).toBeNull();
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
    expect(
      normalizeGitHubEvent("pull_request", {
        action: "closed",
        repository: REPO,
        pull_request: { ...pr, merged: false },
      }),
    ).toBeNull();
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
