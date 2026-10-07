/**
 * Event triggers: GitHub, GitLab, Slack, Linear, Jira, Pylon, PagerDuty,
 * Sentry, Alertmanager (Grafana) and Datadog happenings that start work.
 * Rows in `workflow_triggers` with one of those types, whatever they
 * target — a Job, a scheduled Task, a Local automation, or a persistent
 * agent all take the same trigger, and the dispatcher turns a match into
 * what that target spawns.
 *
 * Shape: each source has a pure `normalize*` (raw webhook payload → one
 * normalized event, or null when it's nothing we care about) and a pure
 * `match*` (trigger config × event → the matched kind, or null). The ingress
 * routes verify signatures, normalize, and call `fireEventTriggers`, which
 * fans the event out to every matching trigger's target — except the
 * self-secret sources (Pylon, Alertmanager, Datadog), whose deliveries are
 * addressed to one trigger (`/api/hooks/<type>/:id`, checked against that
 * trigger's secret) and so go through `firingFor` and `fireTrigger` for it
 * alone.
 *
 * Each trigger's config carries the identity it listens for (`login`,
 * `username`, `user`) — the ingress endpoints themselves are workspace-wide,
 * so a repo registered in Optio only ever reaches targets in its own
 * workspace.
 */
import type {
  AlertmanagerAlert,
  AlertmanagerEvent,
  AlertmanagerEventKind,
  AlertmanagerTriggerConfig,
  DatadogEvent,
  DatadogEventKind,
  DatadogTriggerConfig,
  EventTriggerType,
  GitHubEvent,
  GitHubEventKind,
  GitHubTriggerConfig,
  GitLabEvent,
  GitLabEventKind,
  GitLabTriggerConfig,
  JiraEvent,
  JiraEventKind,
  JiraTriggerConfig,
  LinearEvent,
  LinearEventKind,
  LinearTriggerConfig,
  PagerDutyEvent,
  PagerDutyEventKind,
  PagerDutyTriggerConfig,
  PylonEvent,
  PylonTriggerConfig,
  SentryEvent,
  SentryEventKind,
  SentryTriggerConfig,
  SlackBot,
  SlackEvent,
  SlackTriggerConfig,
} from "@optio/shared";
import {
  ALERTMANAGER_EVENT_KINDS,
  DATADOG_EVENT_KINDS,
  GITHUB_EVENT_KINDS,
  GITHUB_PERSONAL_EVENT_KINDS,
  GITLAB_EVENT_KINDS,
  GITLAB_PERSONAL_EVENT_KINDS,
  JIRA_EVENT_KINDS,
  JIRA_PERSONAL_EVENT_KINDS,
  LINEAR_EVENT_KINDS,
  LINEAR_PERSONAL_EVENT_KINDS,
  PAGERDUTY_EVENT_KINDS,
  SENTRY_EVENT_KINDS,
} from "@optio/shared";
import { db } from "../db/client.js";
import { repos } from "../db/schema.js";
import { logger } from "../logger.js";
import { listEnabledTriggersOfType, type TriggerRow } from "./trigger-service.js";
import { definitionKindOf, getDefinition } from "./work-definition-service.js";
import { fireTrigger, type TriggerFireResult, type TriggerFiring } from "./trigger-dispatch.js";

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function lower(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}
function stripAt(v: string): string {
  return v.startsWith("@") ? v.slice(1) : v;
}

/** `@login` mentions in free text (GitHub / Linear / Slack-ish handles). */
export function extractMentions(text: string): string[] {
  const out = new Set<string>();
  const re = /(^|[^\w@/])@([a-z0-9][a-z0-9._-]{0,60})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[2].replace(/[._-]+$/, "").toLowerCase());
  }
  return [...out];
}

/** The first line of a commit message / description. */
function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/** The most commit text a push firing hands on. */
const COMMITS_TEXT_MAX = 10_000;

/** A push's commits as "sha7 subject" lines, oldest first. */
function commitLines(commits: unknown[], idKey = "id"): string {
  return commits
    .map((c) => {
      const o = obj(c);
      const sha = str(o[idKey]).slice(0, 7);
      const subject = firstLine(str(o.message) || str(o.title));
      return [sha, subject].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, COMMITS_TEXT_MAX);
}

/**
 * Whether `value` matches one of the patterns: exact (case-insensitive) or a
 * glob with `*` (any run) and `?` (one character), so `release/*` takes every
 * release branch. No patterns = anything matches.
 */
export function matchesAnyPattern(patterns: string[] | undefined, value: string | null): boolean {
  const wanted = (patterns ?? []).map((p) => p.trim()).filter(Boolean);
  if (wanted.length === 0) return true;
  if (!value) return false;
  const v = value.toLowerCase();
  return wanted.some((pattern) => {
    const p = pattern.toLowerCase();
    if (!/[*?]/.test(p)) return p === v;
    const re = new RegExp(
      `^${p
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    );
    return re.test(v);
  });
}

/** Whether `have` shares a value (case-insensitive) with `wanted`; no `wanted` = yes. */
function anyMatch(wanted: string[] | undefined, have: string[]): boolean {
  const want = (wanted ?? []).map(lower).filter(Boolean);
  if (want.length === 0) return true;
  return have.some((h) => want.includes(lower(h)));
}

/** A branch ref (`refs/heads/main` → `main`); null for tags and anything else. */
function branchOfRef(ref: string): string | null {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
}

const ZERO_SHA = /^0+$/;

// ── GitHub ──────────────────────────────────────────────────────────────────

/** A CI conclusion as a workflow kind: success, failure, or nothing to fire on. */
function workflowKindOf(conclusion: string): GitHubEventKind | null {
  if (conclusion === "success") return "workflow_succeeded";
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") {
    return "workflow_failed";
  }
  return null;
}

/**
 * Turn a GitHub webhook delivery into one normalized event. PR / issue
 * deliveries become the kinds about them (opened, merged, labeled, review
 * requested, assigned, @-mentioned); pushes, releases, workflow runs and
 * check suites become the kinds about the repo. Returns null for everything
 * else (edits, closes without a merge, cancelled runs, pings, …).
 */
export function normalizeGitHubEvent(eventName: string, payload: unknown): GitHubEvent | null {
  const p = obj(payload);
  const action = str(p.action);
  const repo = obj(p.repository);
  const repoFullName = str(repo.full_name);
  const repoUrl = str(repo.html_url) || (repoFullName ? `https://github.com/${repoFullName}` : "");
  if (!repoFullName) return null;
  const sender = obj(p.sender);

  const kinds = new Set<GitHubEventKind>();
  const targets = new Set<string>();
  let subject: Obj | null = null;
  let kind: "pr" | "issue" = "issue";
  let commentBody: string | null = null;
  let commentUrl: string | null = null;
  let label: string | null = null;
  let merged = false;

  const addMentions = (text: string) => {
    const mentions = extractMentions(text);
    if (mentions.length === 0) return;
    kinds.add("mentioned");
    for (const m of mentions) targets.add(m);
  };

  /** An event about the repo rather than a PR / issue. */
  const repoEvent = (
    fields: Partial<GitHubEvent> & { kinds: GitHubEventKind[]; kind: GitHubEvent["kind"] },
  ): GitHubEvent => ({
    targets: [],
    repo: repoFullName,
    repoUrl,
    number: 0,
    title: "",
    body: "",
    url: "",
    author: str(sender.login),
    headBranch: null,
    baseBranch: null,
    commentBody: null,
    commentUrl: null,
    event: eventName,
    action,
    ...fields,
  });

  switch (eventName) {
    case "pull_request": {
      subject = obj(p.pull_request);
      kind = "pr";
      if (action === "opened" || action === "ready_for_review") {
        kinds.add("pr_opened");
        addMentions(str(subject.body));
      } else if (action === "review_requested") {
        kinds.add("review_requested");
        const reviewer = str(obj(p.requested_reviewer).login);
        if (reviewer) targets.add(reviewer.toLowerCase());
        const team = str(obj(p.requested_team).slug);
        if (team) targets.add(`team:${team.toLowerCase()}`);
      } else if (action === "assigned") {
        kinds.add("assigned");
        const assignee = str(obj(p.assignee).login);
        if (assignee) targets.add(assignee.toLowerCase());
      } else if (action === "closed" && subject.merged === true) {
        kinds.add("pr_merged");
        merged = true;
      } else if (action === "labeled") {
        kinds.add("labeled");
        label = strOrNull(obj(p.label).name);
      } else {
        return null;
      }
      break;
    }
    case "issues": {
      subject = obj(p.issue);
      if (action === "opened") {
        kinds.add("issue_opened");
        addMentions(str(subject.body));
      } else if (action === "assigned") {
        kinds.add("assigned");
        const assignee = str(obj(p.assignee).login);
        if (assignee) targets.add(assignee.toLowerCase());
      } else if (action === "labeled") {
        kinds.add("labeled");
        label = strOrNull(obj(p.label).name);
      } else {
        return null;
      }
      break;
    }
    case "push": {
      const branch = branchOfRef(str(p.ref));
      // Tags and branch deletions aren't pushes anyone automates on.
      if (!branch || p.deleted === true || ZERO_SHA.test(str(p.after))) return null;
      const commits = arr(p.commits);
      const head = obj(p.head_commit);
      const compareUrl = str(p.compare) || `${repoUrl}/commits/${branch}`;
      return repoEvent({
        kinds: ["push"],
        kind: "push",
        title: firstLine(str(head.message)) || `Push to ${branch}`,
        body: commitLines(commits),
        url: compareUrl,
        author: str(obj(p.pusher).name) || str(sender.login),
        headBranch: branch,
        ref: str(p.ref),
        sha: strOrNull(p.after) ?? strOrNull(head.id),
        commits: commitLines(commits),
        compareUrl,
      });
    }
    case "release": {
      if (action !== "published") return null;
      const release = obj(p.release);
      const tag = str(release.tag_name);
      return repoEvent({
        kinds: ["release_published"],
        kind: "release",
        title: str(release.name) || tag,
        body: str(release.body),
        url: str(release.html_url),
        author: str(obj(release.author).login) || str(sender.login),
        tag,
        sha: strOrNull(release.target_commitish),
      });
    }
    case "workflow_run": {
      if (action !== "completed") return null;
      const run = obj(p.workflow_run);
      const conclusion = str(run.conclusion);
      const workflowKind = workflowKindOf(conclusion);
      if (!workflowKind) return null;
      const branch = strOrNull(run.head_branch);
      const name = str(run.name) || str(obj(p.workflow).name);
      const pr = obj(arr(run.pull_requests)[0]);
      return repoEvent({
        kinds: [workflowKind],
        kind: "workflow",
        number: Number(pr.number ?? 0),
        title: `${name || "Workflow"} ${conclusion}${branch ? ` on ${branch}` : ""}`,
        body: str(run.display_title),
        url: str(run.html_url),
        author:
          str(obj(run.actor).login) || str(obj(run.triggering_actor).login) || str(sender.login),
        headBranch: branch,
        sha: strOrNull(run.head_sha),
        workflow: name || null,
        conclusion,
      });
    }
    case "check_suite": {
      if (action !== "completed") return null;
      const suite = obj(p.check_suite);
      // GitHub Actions reports through workflow_run as well — one firing.
      const app = obj(suite.app);
      if (str(app.slug) === "github-actions") return null;
      const conclusion = str(suite.conclusion);
      const workflowKind = workflowKindOf(conclusion);
      if (!workflowKind) return null;
      const branch = strOrNull(suite.head_branch);
      const sha = str(suite.head_sha);
      const name = str(app.name);
      const pr = obj(arr(suite.pull_requests)[0]);
      return repoEvent({
        kinds: [workflowKind],
        kind: "workflow",
        number: Number(pr.number ?? 0),
        title: `${name || "Checks"} ${conclusion}${branch ? ` on ${branch}` : ""}`,
        body: firstLine(str(obj(suite.head_commit).message)),
        url: sha ? `${repoUrl}/commit/${sha}/checks` : repoUrl,
        headBranch: branch,
        sha: sha || null,
        workflow: name || null,
        conclusion,
      });
    }
    case "issue_comment": {
      if (action !== "created") return null;
      subject = obj(p.issue);
      kind = "pull_request" in subject && subject.pull_request ? "pr" : "issue";
      const comment = obj(p.comment);
      commentBody = strOrNull(comment.body);
      commentUrl = strOrNull(comment.html_url);
      addMentions(str(comment.body));
      break;
    }
    case "pull_request_review": {
      if (action !== "submitted") return null;
      subject = obj(p.pull_request);
      kind = "pr";
      const review = obj(p.review);
      commentBody = strOrNull(review.body);
      commentUrl = strOrNull(review.html_url);
      addMentions(str(review.body));
      break;
    }
    case "pull_request_review_comment": {
      if (action !== "created") return null;
      subject = obj(p.pull_request);
      kind = "pr";
      const comment = obj(p.comment);
      commentBody = strOrNull(comment.body);
      commentUrl = strOrNull(comment.html_url);
      addMentions(str(comment.body));
      break;
    }
    default:
      return null;
  }

  if (!subject || kinds.size === 0) return null;
  const head = obj(subject.head);
  const base = obj(subject.base);
  const author = str(obj(subject.user).login) || str(sender.login);

  return {
    kinds: [...kinds],
    targets: [...targets],
    repo: repoFullName,
    repoUrl,
    kind,
    number: Number(subject.number ?? 0),
    title: str(subject.title),
    body: str(subject.body),
    url: str(subject.html_url),
    author,
    headBranch: strOrNull(head.ref),
    baseBranch: strOrNull(base.ref),
    commentBody,
    commentUrl,
    event: eventName,
    action,
    labels: arr(subject.labels)
      .map((l) => (typeof l === "string" ? l : str(obj(l).name)))
      .filter(Boolean),
    label,
    merged,
  };
}

/** Kinds that are "about you" and so need `config.login` to match a target. */
const GITHUB_PERSONAL_KINDS: ReadonlySet<GitHubEventKind> = new Set(GITHUB_PERSONAL_EVENT_KINDS);

/** Kinds about a PR / issue, which a `labels` filter narrows by what it carries. */
const GITHUB_SUBJECT_KINDS: ReadonlySet<GitHubEventKind> = new Set([
  "review_requested",
  "assigned",
  "mentioned",
  "pr_opened",
  "issue_opened",
  "pr_merged",
]);

export function matchGitHubTrigger(
  config: GitHubTriggerConfig,
  event: GitHubEvent,
): GitHubEventKind | null {
  const repos = (config.repos ?? []).map(lower).filter(Boolean);
  if (repos.length > 0 && !repos.includes(lower(event.repo))) return null;

  const wanted = new Set<GitHubEventKind>(
    config.events && config.events.length > 0 ? config.events : GITHUB_EVENT_KINDS,
  );
  const login = lower(stripAt(config.login ?? ""));
  const targets = new Set(event.targets.map(lower));

  // Prefer the most specific kind: review_requested > assigned > mentioned > opened.
  const order: GitHubEventKind[] = [
    "review_requested",
    "assigned",
    "mentioned",
    "pr_opened",
    "issue_opened",
    "pr_merged",
    "labeled",
    "push",
    "release_published",
    "workflow_succeeded",
    "workflow_failed",
  ];
  for (const kind of order) {
    if (!wanted.has(kind) || !event.kinds.includes(kind)) continue;
    if (GITHUB_PERSONAL_KINDS.has(kind)) {
      if (!login || !targets.has(login)) continue;
      // Don't fire on your own comments mentioning yourself.
      if (kind === "mentioned" && lower(event.author) === login && event.commentBody) continue;
    }
    if (kind === "labeled" && !anyMatch(config.labels, event.label ? [event.label] : [])) continue;
    if (GITHUB_SUBJECT_KINDS.has(kind) && !anyMatch(config.labels, event.labels ?? [])) continue;
    if (
      (kind === "push" || kind === "workflow_succeeded" || kind === "workflow_failed") &&
      !matchesAnyPattern(config.branches, event.headBranch)
    ) {
      continue;
    }
    if (
      (kind === "workflow_succeeded" || kind === "workflow_failed") &&
      !anyMatch(config.workflows, event.workflow ? [event.workflow] : [])
    ) {
      continue;
    }
    return kind;
  }
  return null;
}

export function githubEventParams(
  event: GitHubEvent,
  matched: GitHubEventKind,
): Record<string, string> {
  return {
    source: "github",
    event: matched,
    kind: event.kind,
    repo: event.repo,
    repoUrl: event.repoUrl,
    number: String(event.number),
    title: event.title,
    body: event.body,
    url: event.url,
    author: event.author,
    headBranch: event.headBranch ?? "",
    baseBranch: event.baseBranch ?? "",
    commentBody: event.commentBody ?? "",
    commentUrl: event.commentUrl ?? "",
    action: event.action,
    labels: (event.labels ?? []).join(","),
    label: event.label ?? "",
    ref: event.ref ?? "",
    sha: event.sha ?? "",
    commits: event.commits ?? "",
    compareUrl: event.compareUrl ?? "",
    tag: event.tag ?? "",
    workflow: event.workflow ?? "",
    conclusion: event.conclusion ?? "",
    merged: event.merged ? "true" : "false",
  };
}

// ── GitLab ──────────────────────────────────────────────────────────────────

/** Usernames in a GitLab user list (`assignees`, `reviewers`, a `changes` side). */
function gitlabUsernames(v: unknown): string[] {
  return arr(v)
    .map((u) => lower(str(obj(u).username)))
    .filter(Boolean);
}

/** Label titles in a GitLab label list. */
function gitlabLabels(v: unknown): string[] {
  return arr(v)
    .map((l) => (typeof l === "string" ? l : str(obj(l).title) || str(obj(l).name)))
    .filter(Boolean);
}

/** What was added between a `changes.<field>` `previous` and `current`. */
function added(change: unknown, pick: (v: unknown) => string[]): string[] {
  const c = obj(change);
  const before = new Set(pick(c.previous));
  return pick(c.current).filter((x) => !before.has(x));
}

/**
 * Turn a GitLab webhook delivery (`object_kind`) into one normalized event:
 * merge requests, issues, notes, pushes, pipelines, releases. Returns null
 * for what nobody automates on (tag pushes, closes, approvals, running
 * pipelines, edits that change nothing a trigger watches).
 */
export function normalizeGitLabEvent(payload: unknown): GitLabEvent | null {
  const p = obj(payload);
  const objectKind = str(p.object_kind) || str(p.event_type);
  const project = obj(p.project);
  const path = str(project.path_with_namespace);
  const projectUrl = str(project.web_url);
  if (!path) return null;
  const user = obj(p.user);
  const author = str(user.username) || str(p.user_username);

  const kinds = new Set<GitLabEventKind>();
  // Who each personal kind is about — kept apart, since an MR can be opened
  // with a reviewer and an assignee at once.
  const people: Record<"review_requested" | "assigned" | "mentioned", Set<string>> = {
    review_requested: new Set(),
    assigned: new Set(),
    mentioned: new Set(),
  };
  const addMentions = (text: string) => {
    const mentions = extractMentions(text);
    if (mentions.length === 0) return;
    kinds.add("mentioned");
    for (const m of mentions) people.mentioned.add(m);
  };
  const addPeople = (kind: "review_requested" | "assigned", usernames: string[]) => {
    if (usernames.length === 0) return;
    kinds.add(kind);
    for (const u of usernames) people[kind].add(u);
  };

  const base = (
    fields: Partial<GitLabEvent> & { kind: GitLabEvent["kind"]; action: string },
  ): GitLabEvent => ({
    kinds: [...kinds],
    targets: [...new Set([...people.review_requested, ...people.assigned, ...people.mentioned])],
    reviewers: [...people.review_requested],
    assignees: [...people.assigned],
    mentions: [...people.mentioned],
    project: path,
    projectUrl,
    iid: 0,
    title: "",
    body: "",
    url: "",
    author,
    sourceBranch: null,
    targetBranch: null,
    commentBody: null,
    commentUrl: null,
    labels: [],
    label: null,
    ref: null,
    sha: null,
    commits: null,
    compareUrl: null,
    tag: null,
    pipelineStatus: null,
    event: objectKind,
    ...fields,
  });

  /** The kinds an MR / issue `open` or `update` carries, from `changes`. */
  const subjectChanges = (attrs: Obj, action: string): string | null => {
    const changes = obj(p.changes);
    let label: string | null = null;
    if (action === "open") {
      addMentions(str(attrs.description));
      addPeople("assigned", gitlabUsernames(p.assignees ?? attrs.assignee_ids));
      addPeople("review_requested", gitlabUsernames(p.reviewers));
    } else if (action === "update") {
      addPeople("assigned", added(changes.assignees, gitlabUsernames));
      addPeople("review_requested", added(changes.reviewers, gitlabUsernames));
      const newLabels = added(changes.labels, gitlabLabels);
      if (newLabels.length > 0) {
        kinds.add("labeled");
        label = newLabels[0];
      }
      if (changes.description) addMentions(str(attrs.description));
    }
    return label;
  };

  switch (objectKind) {
    case "push": {
      const branch = branchOfRef(str(p.ref));
      if (!branch || ZERO_SHA.test(str(p.after))) return null;
      const commits = arr(p.commits);
      const before = str(p.before);
      const after = str(p.after) || str(p.checkout_sha);
      const compareUrl =
        projectUrl && before && !ZERO_SHA.test(before)
          ? `${projectUrl}/-/compare/${before}...${after}`
          : projectUrl
            ? `${projectUrl}/-/commits/${branch}`
            : "";
      const head = obj(commits[commits.length - 1]);
      kinds.add("push");
      return base({
        kind: "push",
        action: "push",
        title: firstLine(str(head.title) || str(head.message)) || `Push to ${branch}`,
        body: commitLines(commits),
        url: compareUrl,
        author: str(p.user_username) || str(p.user_name) || author,
        sourceBranch: branch,
        ref: str(p.ref),
        sha: after || null,
        commits: commitLines(commits),
        compareUrl,
      });
    }
    case "merge_request": {
      const attrs = obj(p.object_attributes);
      const action = str(attrs.action);
      let label: string | null = null;
      if (action === "open") {
        kinds.add("mr_opened");
        label = subjectChanges(attrs, action);
      } else if (action === "merge") {
        kinds.add("mr_merged");
      } else if (action === "update") {
        label = subjectChanges(attrs, action);
      } else {
        return null;
      }
      if (kinds.size === 0) return null;
      return base({
        kind: "mr",
        action,
        iid: Number(attrs.iid ?? 0),
        title: str(attrs.title),
        body: str(attrs.description),
        url: str(attrs.url),
        sourceBranch: strOrNull(attrs.source_branch),
        targetBranch: strOrNull(attrs.target_branch),
        labels: gitlabLabels(p.labels ?? attrs.labels),
        label,
        sha: strOrNull(obj(attrs.last_commit).id),
      });
    }
    case "issue": {
      const attrs = obj(p.object_attributes);
      const action = str(attrs.action);
      let label: string | null = null;
      if (action === "open") {
        kinds.add("issue_opened");
        label = subjectChanges(attrs, action);
      } else if (action === "update") {
        label = subjectChanges(attrs, action);
      } else {
        return null;
      }
      if (kinds.size === 0) return null;
      return base({
        kind: "issue",
        action,
        iid: Number(attrs.iid ?? 0),
        title: str(attrs.title),
        body: str(attrs.description),
        url: str(attrs.url),
        labels: gitlabLabels(p.labels ?? attrs.labels),
        label,
      });
    }
    case "note": {
      const attrs = obj(p.object_attributes);
      const noteable = str(attrs.noteable_type);
      const subject =
        noteable === "MergeRequest"
          ? obj(p.merge_request)
          : noteable === "Issue"
            ? obj(p.issue)
            : null;
      if (!subject) return null;
      const note = str(attrs.note);
      addMentions(note);
      if (kinds.size === 0) return null;
      return base({
        kind: noteable === "MergeRequest" ? "mr" : "issue",
        action: "note",
        iid: Number(subject.iid ?? 0),
        title: str(subject.title),
        body: str(subject.description),
        url: str(subject.url) || str(attrs.url),
        sourceBranch: strOrNull(subject.source_branch),
        targetBranch: strOrNull(subject.target_branch),
        commentBody: note || null,
        commentUrl: strOrNull(attrs.url),
        labels: gitlabLabels(subject.labels),
      });
    }
    case "pipeline": {
      const attrs = obj(p.object_attributes);
      const status = str(attrs.status);
      if (attrs.tag === true) return null;
      if (status === "success") kinds.add("pipeline_succeeded");
      else if (status === "failed") kinds.add("pipeline_failed");
      else return null;
      const ref = strOrNull(attrs.ref);
      const mr = obj(p.merge_request);
      const commit = obj(p.commit);
      const id = text(attrs.id);
      return base({
        kind: "pipeline",
        action: status,
        iid: Number(mr.iid ?? 0),
        title: `Pipeline ${status}${ref ? ` on ${ref}` : ""}${commit.title ? `: ${firstLine(str(commit.title))}` : ""}`,
        body: str(commit.message),
        url: id && projectUrl ? `${projectUrl}/-/pipelines/${id}` : str(mr.url),
        sourceBranch: ref,
        targetBranch: strOrNull(mr.target_branch),
        ref,
        sha: strOrNull(attrs.sha),
        pipelineStatus: status,
      });
    }
    case "release": {
      if (str(p.action) !== "create") return null;
      kinds.add("release_published");
      const tag = str(p.tag);
      return base({
        kind: "release",
        action: "create",
        title: str(p.name) || tag,
        body: str(p.description),
        url: str(p.url),
        tag: tag || null,
      });
    }
    default:
      return null;
  }
}

const GITLAB_PERSONAL_KINDS: ReadonlySet<GitLabEventKind> = new Set(GITLAB_PERSONAL_EVENT_KINDS);

const GITLAB_SUBJECT_KINDS: ReadonlySet<GitLabEventKind> = new Set([
  "review_requested",
  "assigned",
  "mentioned",
  "mr_opened",
  "issue_opened",
  "mr_merged",
]);

export function matchGitLabTrigger(
  config: GitLabTriggerConfig,
  event: GitLabEvent,
): GitLabEventKind | null {
  const projects = (config.projects ?? []).map(lower).filter(Boolean);
  if (projects.length > 0 && !projects.includes(lower(event.project))) return null;

  const wanted = new Set<GitLabEventKind>(
    config.events && config.events.length > 0 ? config.events : GITLAB_EVENT_KINDS,
  );
  const username = lower(stripAt(config.username ?? ""));
  const concerned: Record<string, string[]> = {
    review_requested: event.reviewers,
    assigned: event.assignees,
    mentioned: event.mentions,
  };

  const order: GitLabEventKind[] = [
    "review_requested",
    "assigned",
    "mentioned",
    "mr_opened",
    "issue_opened",
    "mr_merged",
    "labeled",
    "push",
    "release_published",
    "pipeline_succeeded",
    "pipeline_failed",
  ];
  for (const kind of order) {
    if (!wanted.has(kind) || !event.kinds.includes(kind)) continue;
    if (GITLAB_PERSONAL_KINDS.has(kind)) {
      if (!username || !(concerned[kind] ?? []).map(lower).includes(username)) continue;
      if (kind === "mentioned" && lower(event.author) === username && event.commentBody) continue;
    }
    if (kind === "labeled" && !anyMatch(config.labels, event.label ? [event.label] : [])) continue;
    if (GITLAB_SUBJECT_KINDS.has(kind) && !anyMatch(config.labels, event.labels)) continue;
    if (
      (kind === "push" || kind === "pipeline_succeeded" || kind === "pipeline_failed") &&
      !matchesAnyPattern(config.branches, event.sourceBranch)
    ) {
      continue;
    }
    return kind;
  }
  return null;
}

export function gitlabEventParams(
  event: GitLabEvent,
  matched: GitLabEventKind,
): Record<string, string> {
  return {
    source: "gitlab",
    event: matched,
    kind: event.kind,
    project: event.project,
    projectUrl: event.projectUrl,
    iid: String(event.iid),
    title: event.title,
    body: event.body,
    url: event.url,
    author: event.author,
    sourceBranch: event.sourceBranch ?? "",
    targetBranch: event.targetBranch ?? "",
    commentBody: event.commentBody ?? "",
    commentUrl: event.commentUrl ?? "",
    labels: event.labels.join(","),
    label: event.label ?? "",
    ref: event.ref ?? "",
    sha: event.sha ?? "",
    commits: event.commits ?? "",
    compareUrl: event.compareUrl ?? "",
    tag: event.tag ?? "",
    pipelineStatus: event.pipelineStatus ?? "",
    action: event.action,
  };
}

// ── Slack ───────────────────────────────────────────────────────────────────

/** The most message text a Slack firing hands on (to a prompt, a title). */
const SLACK_TEXT_MAX = 20_000;

/**
 * Normalize a Slack Events API `event_callback`: new `message` and
 * `app_mention` posts, by people or by bots (`bot_id`, or the `bot_message`
 * subtype of integrations and incoming webhooks). Edits, deletes, joins and
 * other subtypes are dropped, and so is anything the receiving app posted
 * itself, so Optio's own Slack messages can't start work.
 */
export function normalizeSlackEvent(payload: unknown): SlackEvent | null {
  const p = obj(payload);
  if (p.type !== "event_callback") return null;
  const ev = obj(p.event);
  const type = str(ev.type);
  if (type !== "message" && type !== "app_mention") return null;
  const subtype = str(ev.subtype);
  if (subtype && subtype !== "bot_message") return null;
  const profile = obj(ev.bot_profile);
  const bot: SlackBot | null =
    ev.bot_id || subtype === "bot_message"
      ? {
          id: strOrNull(ev.bot_id),
          appId: strOrNull(ev.app_id) ?? strOrNull(profile.app_id),
          name: strOrNull(profile.name) ?? strOrNull(ev.username),
        }
      : null;
  if (postedByReceivingApp(p, ev, bot)) return null;
  const channelId = str(ev.channel);
  // A person's text is the whole message (their blocks repeat it); a bot's
  // is often a one-line summary with the details in attachments or blocks.
  const text = bot ? slackMessageText(ev) : str(ev.text);
  if (!channelId || !text) return null;
  return {
    event: type,
    channelId,
    userId: str(ev.user),
    text,
    ts: str(ev.ts),
    threadTs: strOrNull(ev.thread_ts),
    teamId: strOrNull(p.team_id),
    eventId: strOrNull(p.event_id),
    bot,
  };
}

/**
 * Whether the app these events are delivered to posted the message itself
 * (its app id, or its bot user): Optio replying in a channel must not start
 * more work there.
 */
function postedByReceivingApp(p: Obj, ev: Obj, bot: SlackBot | null): boolean {
  const appId = str(p.api_app_id);
  if (appId && bot?.appId === appId) return true;
  const user = str(ev.user);
  return (
    !!user &&
    arr(p.authorizations).some((a) => obj(a).is_bot === true && str(obj(a).user_id) === user)
  );
}

/**
 * What a message says: its text, then what its blocks and attachments add
 * (header, sections, fields, context, rich text; an attachment's pretext,
 * title, text, fields and footer, or its fallback when it has none of those).
 * A piece the text already says isn't repeated.
 */
export function slackMessageText(ev: Record<string, unknown>): string {
  const parts: string[] = [];
  const flat = (t: string) => t.replace(/\s+/g, " ");
  const add = (piece: unknown) => {
    const t = typeof piece === "string" ? piece.trim() : "";
    if (t && !flat(parts.join("\n")).includes(flat(t))) parts.push(t);
  };
  add(ev.text);
  for (const block of arr(ev.blocks)) blockText(block).forEach(add);
  for (const raw of arr(ev.attachments)) {
    const a = obj(raw);
    const title = str(a.title);
    const link = str(a.title_link);
    const fields = arr(a.fields).map((f) => {
      const title = str(obj(f).title);
      const value = str(obj(f).value);
      return title && value ? `${title}: ${value}` : value || title;
    });
    const blocks = arr(a.blocks).flatMap(blockText);
    add(a.pretext);
    add(title && link ? `${title} (${link})` : title);
    add(a.text);
    fields.forEach(add);
    blocks.forEach(add);
    add(a.footer);
    if (!a.pretext && !title && !a.text && !fields.length && !blocks.length) add(a.fallback);
  }
  return parts.join("\n").slice(0, SLACK_TEXT_MAX);
}

/** A Block Kit block's text. */
function blockText(block: unknown): string[] {
  const b = obj(block);
  const textOf = (t: unknown) => (typeof t === "string" ? t : str(obj(t).text));
  switch (str(b.type)) {
    case "header":
    case "markdown":
      return [textOf(b.text)];
    case "section":
      return [textOf(b.text), ...arr(b.fields).map(textOf)];
    case "context":
      return [arr(b.elements).map(textOf).filter(Boolean).join(" ")];
    case "rich_text":
      return arr(b.elements).map(richText);
    default:
      return [];
  }
}

/** A rich_text element as plain text. */
function richText(element: unknown): string {
  const e = obj(element);
  switch (str(e.type)) {
    case "text":
      return str(e.text);
    case "link":
      return str(e.text) || str(e.url);
    case "user":
      return `<@${str(e.user_id)}>`;
    case "channel":
      return `<#${str(e.channel_id)}>`;
    case "emoji":
      return `:${str(e.name)}:`;
    case "rich_text_list":
      return arr(e.elements)
        .map((item) => `- ${richText(item)}`)
        .join("\n");
    default:
      return arr(e.elements).map(richText).join("");
  }
}

/**
 * Whether the poster may fire the trigger: people unless it's for bots
 * only; a bot only when it asks for bots, and then only the one it names,
 * if it names one.
 */
function slackPosterMatches(config: SlackTriggerConfig, event: SlackEvent): boolean {
  const postedBy = config.postedBy ?? "people";
  if (!event.bot) return postedBy !== "bots";
  if (postedBy === "people") return false;
  const want = lower(config.bot);
  if (!want) return true;
  const { id, appId, name } = event.bot;
  return [id, appId, name].some((v) => lower(v) === want);
}

export function matchSlackTrigger(config: SlackTriggerConfig, event: SlackEvent): boolean {
  if (!config.channelId || config.channelId !== event.channelId) return false;
  if (!slackPosterMatches(config, event)) return false;
  // An @-mention arrives as both `app_mention` and `message` when the app
  // subscribes to both; a trigger listens to exactly one of them.
  if (config.mentionOnly ? event.event !== "app_mention" : event.event !== "message") return false;
  if (event.threadTs && event.threadTs !== event.ts && !config.includeThreads) return false;
  const keyword = lower(config.keyword);
  if (keyword && !lower(event.text).includes(keyword)) return false;
  return true;
}

export function slackPermalink(event: SlackEvent): string {
  const ts = event.ts.replace(".", "");
  return ts ? `https://slack.com/archives/${event.channelId}/p${ts}` : "";
}

export function slackEventParams(event: SlackEvent): Record<string, string> {
  return {
    source: "slack",
    event: event.event,
    channelId: event.channelId,
    userId: event.userId,
    text: event.text,
    ts: event.ts,
    threadTs: event.threadTs ?? "",
    teamId: event.teamId ?? "",
    permalink: slackPermalink(event),
    botName: event.bot?.name ?? "",
    botId: event.bot?.id ?? "",
  };
}

/** Who posted it, for a firing's message: the bot's name, else the user id. */
function slackPoster(event: SlackEvent): string {
  if (!event.bot) return event.userId;
  return event.bot.name ?? event.bot.id ?? event.bot.appId ?? "a bot";
}

// ── Linear ──────────────────────────────────────────────────────────────────

function linearLabels(data: Obj): string[] {
  const raw = Array.isArray(data.labels) ? data.labels : [];
  return raw.map((l) => str(obj(l).name)).filter(Boolean);
}

/**
 * Every way a Linear payload names a person, lowercased: id, name, display
 * name, email, and the handle in a profile URL (…/profiles/<handle>) — so a
 * trigger's `user` matches however it was written. `extraIds` adds bare ids
 * (`creatorId`, `assigneeId`) given beside the object.
 */
function linearUserKeys(u: Obj, ...extraIds: unknown[]): string[] {
  const keys = new Set<string>();
  const add = (v: unknown) => {
    const s = lower(str(v));
    if (s) keys.add(s);
  };
  for (const v of [u.id, u.name, u.displayName, u.email, u.userDisplayName, ...extraIds]) add(v);
  const handle = /\/profiles\/([^/?#]+)/.exec(str(u.url))?.[1];
  if (handle) add(decodeURIComponent(handle));
  return [...keys];
}

/**
 * Normalize a Linear webhook delivery (Issue / Comment). Returns null for
 * types and updates we don't act on. A Linear `update` names the changed
 * fields in `updatedFrom`, which is how "assigned" and "labeled" are told
 * apart from unrelated edits.
 */
export function normalizeLinearEvent(payload: unknown): LinearEvent | null {
  const p = obj(payload);
  const type = str(p.type);
  const action = str(p.action);
  const data = obj(p.data);
  const updatedFrom = obj(p.updatedFrom);
  const actor = strOrNull(obj(p.actor).name) ?? strOrNull(obj(p.actor).id);

  const kinds = new Set<LinearEventKind>();
  const targets = new Set<string>();
  let issue: Obj;
  let commentBody: string | null = null;
  let commentUrl: string | null = null;

  const addUser = (u: Obj) => {
    for (const v of [u.id, u.name, u.displayName, u.email]) {
      const s = lower(str(v));
      if (s) targets.add(s);
    }
  };
  const addMentions = (text: string) => {
    const mentions = extractMentions(text);
    // Linear renders mentions as markdown links: [@Display Name](https://linear.app/…/profiles/handle)
    const linkRe = /\[@([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(text)) !== null) {
      mentions.push(m[1].toLowerCase());
      const handle = m[2].split("/").filter(Boolean).pop();
      if (handle) mentions.push(handle.toLowerCase());
    }
    if (mentions.length === 0) return;
    kinds.add("mentioned");
    for (const x of mentions) targets.add(x);
  };

  if (type === "Issue") {
    issue = data;
    if (action === "create") {
      kinds.add("created");
      if (data.assignee) {
        kinds.add("assigned");
        addUser(obj(data.assignee));
      }
      addMentions(str(data.description));
    } else if (action === "update") {
      if ("assigneeId" in updatedFrom && data.assigneeId) {
        kinds.add("assigned");
        addUser(obj(data.assignee));
        if (typeof data.assigneeId === "string") targets.add(lower(data.assigneeId));
      }
      if ("labelIds" in updatedFrom) {
        const before = new Set(
          (Array.isArray(updatedFrom.labelIds) ? updatedFrom.labelIds : []).map(String),
        );
        const after = (Array.isArray(data.labelIds) ? data.labelIds : []).map(String);
        if (after.some((id) => !before.has(id))) kinds.add("labeled");
      }
      if ("description" in updatedFrom) addMentions(str(data.description));
    } else {
      return null;
    }
  } else if (type === "Comment") {
    if (action !== "create") return null;
    issue = obj(data.issue);
    commentBody = strOrNull(data.body);
    commentUrl = strOrNull(data.url) ?? strOrNull(p.url);
    addMentions(str(data.body));
    if (!actor) {
      const u = obj(data.user);
      const name = strOrNull(u.name) ?? strOrNull(u.id);
      if (name) targets.delete(lower(name));
    }
  } else {
    return null;
  }

  if (kinds.size === 0) return null;
  const identifier = str(issue.identifier);
  if (!identifier) return null;
  const team = obj(issue.team);
  const assignee = obj(issue.assignee);
  // Who did it: the webhook's actor — or, for an integration acting for a
  // person (an issue filed from Slack), that person too. A comment's author
  // is its actor.
  const actorKeys = new Set([
    ...linearUserKeys(obj(p.actor)),
    ...linearUserKeys(obj(data.botActor)),
    ...(type === "Comment" ? linearUserKeys(obj(data.user), data.userId) : []),
  ]);
  // Who wrote the ticket, when the payload says (issue events carry
  // `creatorId`, and sometimes the creator itself).
  const creatorKeys = linearUserKeys(obj(issue.creator), issue.creatorId);

  return {
    kinds: [...kinds],
    targets: [...targets],
    actorKeys: [...actorKeys],
    creatorKeys,
    assigneeKeys: linearUserKeys(assignee, issue.assigneeId),
    identifier,
    title: str(issue.title),
    description: str(issue.description),
    url: str(issue.url) || str(p.url),
    labels: linearLabels(issue),
    teamKey: strOrNull(team.key),
    assignee: strOrNull(assignee.name) ?? strOrNull(assignee.id),
    priority: typeof issue.priority === "number" ? issue.priority : null,
    state: strOrNull(obj(issue.state).name),
    commentBody,
    commentUrl,
    actor,
    type,
    action,
  };
}

const LINEAR_PERSONAL_KINDS: ReadonlySet<LinearEventKind> = new Set(LINEAR_PERSONAL_EVENT_KINDS);

/**
 * Whether `user` (a trigger's lowercased `user`) wrote the ticket or made
 * this change themselves — what `othersOnly` skips. When the ticket is
 * assigned to `user`, every key of the assignee is theirs too: a trigger set
 * up with a display name still knows its user's id when the payload names the
 * creator only by `creatorId`.
 */
function isOwnLinearEvent(user: string, event: LinearEvent): boolean {
  const me = new Set([user]);
  const assigneeKeys = event.assigneeKeys ?? [];
  if (assigneeKeys.includes(user)) for (const k of assigneeKeys) me.add(k);
  const mine = (keys: string[] | undefined) => (keys ?? []).some((k) => me.has(k));
  return mine(event.actorKeys) || mine(event.creatorKeys);
}

export function matchLinearTrigger(
  config: LinearTriggerConfig,
  event: LinearEvent,
): LinearEventKind | null {
  const teams = (config.teams ?? []).map(lower).filter(Boolean);
  if (teams.length > 0 && !teams.includes(lower(event.teamKey))) return null;
  const labels = (config.labels ?? []).map(lower).filter(Boolean);
  if (labels.length > 0 && !event.labels.some((l) => labels.includes(lower(l)))) return null;

  const wanted = new Set<LinearEventKind>(
    config.events && config.events.length > 0 ? config.events : LINEAR_EVENT_KINDS,
  );
  const user = lower(stripAt(config.user ?? ""));
  const targets = new Set(event.targets.map(lower));
  if (config.othersOnly && user && isOwnLinearEvent(user, event)) return null;

  const order: LinearEventKind[] = ["assigned", "mentioned", "labeled", "created"];
  for (const kind of order) {
    if (!wanted.has(kind) || !event.kinds.includes(kind)) continue;
    if (LINEAR_PERSONAL_KINDS.has(kind)) {
      if (!user || !targets.has(user)) continue;
      if (kind === "mentioned" && lower(event.actor) === user) continue;
    }
    return kind;
  }
  return null;
}

export function linearEventParams(
  event: LinearEvent,
  matched: LinearEventKind,
): Record<string, string> {
  return {
    source: "linear",
    event: matched,
    identifier: event.identifier,
    title: event.title,
    description: event.description,
    url: event.url,
    labels: event.labels.join(","),
    teamKey: event.teamKey ?? "",
    assignee: event.assignee ?? "",
    priority: event.priority == null ? "" : String(event.priority),
    state: event.state ?? "",
    commentBody: event.commentBody ?? "",
    commentUrl: event.commentUrl ?? "",
    actor: event.actor ?? "",
    // Ticket-style aliases so one prompt template works for ticket + linear triggers.
    ticketSource: "linear",
    ticketExternalId: event.identifier,
    ticketTitle: event.title,
    ticketBody: event.description,
    ticketUrl: event.url,
    ticketLabels: event.labels.join(","),
  };
}

// ── Jira ────────────────────────────────────────────────────────────────────

/**
 * Plain text of a Jira rich-text field: a wiki-markup string as-is, an
 * Atlassian Document Format object flattened (text nodes joined, a
 * paragraph per line, mentions as their `@Name`).
 */
export function jiraText(v: unknown): string {
  if (typeof v === "string") return v;
  const node = obj(v);
  if (Object.keys(node).length === 0) return "";
  const type = str(node.type);
  if (type === "text") return str(node.text);
  if (type === "mention") return str(obj(node.attrs).text);
  if (type === "hardBreak") return "\n";
  const inner = arr(node.content).map(jiraText).join("");
  return type === "paragraph" || type === "heading" || type === "listItem" ? `${inner}\n` : inner;
}

/**
 * Who a Jira text mentions, lowercased: wiki-markup `[~accountid:…]` /
 * `[~username]` and ADF `mention` nodes (their account id and their name).
 */
export function jiraMentions(v: unknown): string[] {
  const out = new Set<string>();
  const walk = (n: unknown) => {
    if (typeof n === "string") {
      const re = /\[~(?:accountid:)?([^\]]+)\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(n)) !== null) out.add(m[1].trim().toLowerCase());
      return;
    }
    const node = obj(n);
    if (str(node.type) === "mention") {
      const attrs = obj(node.attrs);
      const id = lower(str(attrs.id));
      const text = lower(stripAt(str(attrs.text)));
      if (id) out.add(id);
      if (text) out.add(text);
    }
    for (const c of arr(node.content)) walk(c);
  };
  walk(v);
  return [...out];
}

/** Every way a Jira payload names a person, lowercased: account id, name, email, (server) username / key. */
function jiraUserKeys(u: Obj): string[] {
  const keys = new Set<string>();
  for (const v of [u.accountId, u.displayName, u.emailAddress, u.name, u.key]) {
    const s = lower(str(v));
    if (s) keys.add(s);
  }
  return [...keys];
}

/** `https://acme.atlassian.net/rest/api/2/issue/10001` + `PROJ-1` → `https://acme.atlassian.net/browse/PROJ-1`. */
function jiraBrowseUrl(self: string, key: string): string {
  const m = /^(https?:\/\/[^/]+)(\/[^/]*?)?\/rest\//.exec(self);
  if (!m || !key) return "";
  // A Jira Server under a context path keeps it: https://jira.acme.com/jira/browse/PROJ-1.
  const prefix = m[2] && m[2] !== "/rest" ? m[2] : "";
  return `${m[1]}${prefix}/browse/${key}`;
}

/**
 * Normalize a Jira Cloud (or Server) webhook: `jira:issue_created`,
 * `jira:issue_updated` (assignment, status, labels and description changes
 * read from the changelog; a comment added through it too) and
 * `comment_created`. Returns null for deletes and updates that change
 * nothing a trigger watches.
 */
export function normalizeJiraEvent(payload: unknown): JiraEvent | null {
  const p = obj(payload);
  const webhookEvent = str(p.webhookEvent);
  const issue = obj(p.issue);
  const fields = obj(issue.fields);
  const key = str(issue.key);
  if (!key) return null;
  const eventTypeName = str(p.issue_event_type_name);
  const comment = obj(p.comment);

  const kinds = new Set<JiraEventKind>();
  // Who each personal kind is about, kept apart: an issue can be created
  // assigned to one person and mentioning another.
  const assignees = new Set<string>();
  const mentions = new Set<string>();
  const addUser = (u: Obj, ...ids: unknown[]) => {
    for (const k of jiraUserKeys(u)) assignees.add(k);
    for (const id of ids) {
      const s = lower(str(id));
      if (s) assignees.add(s);
    }
  };
  const addMentions = (text: unknown) => {
    const found = jiraMentions(text);
    if (found.length === 0) return;
    kinds.add("mentioned");
    for (const m of found) mentions.add(m);
  };

  let previousStatus: string | null = null;
  let commentBody: string | null = null;
  let commentUrl: string | null = null;
  let actorObj = obj(p.user);
  const url = jiraBrowseUrl(str(issue.self), key);

  const addComment = () => {
    if (Object.keys(comment).length === 0) return;
    kinds.add("commented");
    commentBody = jiraText(comment.body) || null;
    const id = str(comment.id);
    commentUrl = url && id ? `${url}?focusedCommentId=${id}` : url || null;
    addMentions(comment.body);
    actorObj = obj(comment.author);
  };

  if (webhookEvent === "jira:issue_created") {
    kinds.add("created");
    const assignee = obj(fields.assignee);
    if (Object.keys(assignee).length > 0) {
      kinds.add("assigned");
      addUser(assignee);
    }
    addMentions(fields.description);
  } else if (webhookEvent === "jira:issue_updated") {
    for (const raw of arr(obj(p.changelog).items)) {
      const item = obj(raw);
      const field = lower(str(item.field) || str(item.fieldId));
      if (field === "assignee") {
        if (str(item.to) || str(item.toString)) {
          kinds.add("assigned");
          addUser(obj(fields.assignee), item.to, item.toString);
        }
      } else if (field === "status") {
        kinds.add("transitioned");
        previousStatus = strOrNull(item.fromString);
      } else if (field === "labels") {
        const before = new Set(str(item.fromString).split(/\s+/).filter(Boolean));
        const after = str(item.toString).split(/\s+/).filter(Boolean);
        if (after.some((l) => !before.has(l))) kinds.add("labeled");
      } else if (field === "description") {
        addMentions(fields.description);
      }
    }
    if (eventTypeName === "issue_commented") addComment();
  } else if (webhookEvent === "comment_created") {
    addComment();
  } else {
    return null;
  }
  if (kinds.size === 0) return null;

  const project = obj(fields.project);
  const assignee = obj(fields.assignee);
  const actorKeys = jiraUserKeys(actorObj);
  // Your own comment mentioning yourself isn't a mention of you.
  const actor = strOrNull(actorObj.displayName) ?? strOrNull(actorObj.accountId);

  return {
    kinds: [...kinds],
    targets: [...new Set([...assignees, ...mentions])],
    assignees: [...assignees],
    mentions: [...mentions],
    actorKeys,
    key,
    title: str(fields.summary),
    description: jiraText(fields.description),
    url,
    project: str(project.key),
    projectName: str(project.name),
    status: strOrNull(obj(fields.status).name),
    previousStatus,
    assignee: strOrNull(assignee.displayName) ?? strOrNull(assignee.accountId),
    priority: strOrNull(obj(fields.priority).name),
    labels: arr(fields.labels).map(str).filter(Boolean),
    issueType: strOrNull(obj(fields.issuetype).name),
    commentBody,
    commentUrl,
    actor,
    event: webhookEvent,
    eventTypeName,
  };
}

const JIRA_PERSONAL_KINDS: ReadonlySet<JiraEventKind> = new Set(JIRA_PERSONAL_EVENT_KINDS);

export function matchJiraTrigger(
  config: JiraTriggerConfig,
  event: JiraEvent,
): JiraEventKind | null {
  if (!anyMatch(config.projects, [event.project])) return null;
  if (!anyMatch(config.labels, event.labels)) return null;
  if (!anyMatch(config.issueTypes, event.issueType ? [event.issueType] : [])) return null;

  const wanted = new Set<JiraEventKind>(
    config.events && config.events.length > 0 ? config.events : JIRA_EVENT_KINDS,
  );
  const user = lower(stripAt(config.user ?? ""));
  const concerned: Record<string, string[]> = {
    assigned: event.assignees,
    mentioned: event.mentions,
  };

  const order: JiraEventKind[] = [
    "assigned",
    "mentioned",
    "transitioned",
    "labeled",
    "commented",
    "created",
  ];
  for (const kind of order) {
    if (!wanted.has(kind) || !event.kinds.includes(kind)) continue;
    if (JIRA_PERSONAL_KINDS.has(kind)) {
      if (!user || !(concerned[kind] ?? []).map(lower).includes(user)) continue;
      if (kind === "mentioned" && event.actorKeys.includes(user) && event.commentBody) continue;
    }
    if (kind === "transitioned" && !anyMatch(config.statuses, event.status ? [event.status] : [])) {
      continue;
    }
    return kind;
  }
  return null;
}

export function jiraEventParams(event: JiraEvent, matched: JiraEventKind): Record<string, string> {
  return {
    source: "jira",
    event: matched,
    key: event.key,
    title: event.title,
    description: event.description,
    url: event.url,
    project: event.project,
    projectName: event.projectName,
    status: event.status ?? "",
    previousStatus: event.previousStatus ?? "",
    assignee: event.assignee ?? "",
    priority: event.priority ?? "",
    labels: event.labels.join(","),
    issueType: event.issueType ?? "",
    commentBody: event.commentBody ?? "",
    commentUrl: event.commentUrl ?? "",
    actor: event.actor ?? "",
    // Ticket-style aliases so one prompt template works for ticket + jira triggers.
    ticketSource: "jira",
    ticketExternalId: event.key,
    ticketTitle: event.title,
    ticketBody: event.description,
    ticketUrl: event.url,
    ticketLabels: event.labels.join(","),
  };
}

// ── Pylon ───────────────────────────────────────────────────────────────────

/** The most of a Pylon payload a firing hands on, serialized. */
const PYLON_PAYLOAD_MAX = 20_000;

/** A string, or a number's digits (ids and issue numbers come either way). */
function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/** The first non-empty string among the keys, on the object. */
function firstText(o: Obj, ...keys: string[]): string {
  for (const k of keys) {
    const v = text(o[k]);
    if (v) return v;
  }
  return "";
}

/**
 * A person or account the payload names: a string as-is, else the object's
 * email / name / id.
 */
function who(v: unknown): string {
  if (typeof v === "string") return v;
  const o = obj(v);
  return firstText(o, "email", "name", "id");
}

/**
 * Normalize a Pylon delivery. The payload is whatever the Pylon trigger's
 * author shaped, so this is best-effort: the issue's fields are read from
 * `issue` (or `data` / `data.issue`) when there is one, else from the top
 * level; the event kind from `event`, `event_type`, `type`, `trigger` or
 * `data.event`. Never null — a delivery without any of this still fires a
 * trigger with no `events` filter, with the whole payload as `payload`.
 */
export function normalizePylonEvent(payload: unknown): PylonEvent {
  const p = obj(payload);
  const data = obj(p.data);
  const issue =
    p.issue && typeof p.issue === "object"
      ? obj(p.issue)
      : data.issue && typeof data.issue === "object"
        ? obj(data.issue)
        : Object.keys(data).length > 0
          ? data
          : p;
  const kind = firstText(p, "event", "event_type", "type", "trigger") || firstText(data, "event");
  const tags = arr(issue.tags)
    .map((t) => (typeof t === "string" ? t : str(obj(t).name)))
    .filter(Boolean);
  return {
    event: kind || null,
    issueId: firstText(issue, "id", "issue_id"),
    issueNumber: firstText(issue, "number", "issue_number"),
    title: firstText(issue, "title", "subject"),
    body: firstText(issue, "body_html", "body", "description"),
    state: firstText(issue, "state", "status"),
    url: firstText(issue, "link", "url", "html_url"),
    account: who(issue.account) || who(p.account),
    requester: who(issue.requester) || who(p.requester),
    assignee: who(issue.assignee) || who(p.assignee),
    tags,
    payload: p,
  };
}

/** Pylon triggers filter on event kind only: the delivery already names its trigger. */
export function matchPylonTrigger(config: PylonTriggerConfig, event: PylonEvent): string | null {
  const wanted = (config.events ?? []).map(lower).filter(Boolean);
  if (wanted.length === 0) return event.event ?? "any";
  if (!event.event || !wanted.includes(lower(event.event))) return null;
  return event.event;
}

export function pylonEventParams(event: PylonEvent): Record<string, string> {
  let payload = "";
  try {
    payload = JSON.stringify(event.payload).slice(0, PYLON_PAYLOAD_MAX);
  } catch {
    payload = "";
  }
  return {
    source: "pylon",
    event: event.event ?? "",
    issueId: event.issueId,
    issueNumber: event.issueNumber,
    title: event.title,
    body: event.body,
    state: event.state,
    url: event.url,
    account: event.account,
    requester: event.requester,
    assignee: event.assignee,
    tags: event.tags.join(","),
    payload,
  };
}

// ── PagerDuty ───────────────────────────────────────────────────────────────

const PAGERDUTY_KINDS: ReadonlySet<string> = new Set(PAGERDUTY_EVENT_KINDS);

/**
 * Normalize a PagerDuty Webhooks v3 delivery (`{ event: { event_type, data,
 * … } }`). Returns null for anything that isn't an incident event type we
 * know, including the `pagey.ping` test event.
 */
export function normalizePagerDutyEvent(payload: unknown): PagerDutyEvent | null {
  const p = obj(payload);
  const ev = obj(p.event);
  const kind = str(ev.event_type);
  if (!PAGERDUTY_KINDS.has(kind)) return null;
  const data = obj(ev.data);
  const id = str(data.id);
  if (!id) return null;
  const service = obj(data.service);
  const urgency = str(data.urgency);
  const priority = obj(data.priority);
  const incidentNumber = Number(data.incident_number);
  return {
    kind: kind as PagerDutyEventKind,
    id,
    incidentNumber:
      Number.isFinite(incidentNumber) && data.incident_number != null ? incidentNumber : null,
    title: str(data.title),
    url: str(data.html_url),
    urgency: urgency === "high" || urgency === "low" ? urgency : null,
    priority: strOrNull(priority.summary) ?? strOrNull(priority.name),
    service: str(service.summary) || str(service.name),
    serviceId: str(service.id),
    status: str(data.status),
    assignees: arr(data.assignees)
      .map((a) => {
        const o = obj(a);
        return str(o.summary) || str(obj(o.assignee).summary);
      })
      .filter(Boolean),
    eventId: str(ev.id),
  };
}

export function matchPagerDutyTrigger(
  config: PagerDutyTriggerConfig,
  event: PagerDutyEvent,
): PagerDutyEventKind | null {
  const wanted = (config.events ?? []).filter(Boolean);
  if (wanted.length > 0 && !wanted.includes(event.kind)) return null;
  const services = (config.services ?? []).map(lower).filter(Boolean);
  if (
    services.length > 0 &&
    !services.includes(lower(event.serviceId)) &&
    !services.includes(lower(event.service))
  ) {
    return null;
  }
  if (config.urgency && config.urgency !== event.urgency) return null;
  return event.kind;
}

export function pagerDutyEventParams(event: PagerDutyEvent): Record<string, string> {
  return {
    source: "pagerduty",
    event: event.kind,
    incidentId: event.id,
    incidentNumber: event.incidentNumber == null ? "" : String(event.incidentNumber),
    title: event.title,
    url: event.url,
    urgency: event.urgency ?? "",
    priority: event.priority ?? "",
    service: event.service,
    serviceId: event.serviceId,
    status: event.status,
    assignees: event.assignees.join(","),
    // Ticket-style aliases so one prompt template works for ticket + event triggers.
    ticketSource: "pagerduty",
    ticketExternalId: event.id,
    ticketTitle: event.title,
    ticketBody: "",
    ticketUrl: event.url,
    ticketLabels: "",
  };
}

// ── Sentry ──────────────────────────────────────────────────────────────────

const SENTRY_KINDS: ReadonlySet<string> = new Set(SENTRY_EVENT_KINDS);

/** A Sentry project reference as its slug, or whatever the payload gives (a name, an id). */
function sentryProject(v: unknown): { slug: string; name: string } {
  if (typeof v === "string" || typeof v === "number") return { slug: String(v), name: "" };
  const o = obj(v);
  return { slug: str(o.slug) || text(o.id), name: str(o.name) };
}

/**
 * Normalize a Sentry internal-integration webhook by its
 * `Sentry-Hook-Resource`: `issue` (created / resolved / assigned /
 * archived / unresolved), `event_alert` (an issue alert rule fired) and
 * `metric_alert` (critical / warning / resolved). Returns null for the
 * rest — `installation`, `comment`, and the per-event `error` resource.
 */
export function normalizeSentryEvent(resource: string, payload: unknown): SentryEvent | null {
  const p = obj(payload);
  const action = str(p.action);
  const data = obj(p.data);
  const actorObj = obj(p.actor);
  const actor =
    strOrNull(actorObj.name) ?? (str(actorObj.type) === "application" ? "Sentry" : null);

  if (resource === "issue") {
    const kind: SentryEventKind | null =
      action === "created"
        ? "issue_created"
        : action === "resolved"
          ? "issue_resolved"
          : action === "assigned"
            ? "issue_assigned"
            : action === "archived" || action === "ignored"
              ? "issue_archived"
              : action === "unresolved"
                ? "issue_unresolved"
                : null;
    if (!kind) return null;
    const issue = obj(data.issue);
    const id = text(issue.id);
    if (!id) return null;
    const project = sentryProject(issue.project);
    const assigned = obj(issue.assignedTo);
    return {
      kind,
      resource,
      action,
      issueId: id,
      shortId: str(issue.shortId),
      title: str(issue.title),
      culprit: str(issue.culprit),
      level: strOrNull(issue.level),
      project: project.slug,
      projectName: project.name,
      url: str(issue.web_url) || str(issue.permalink),
      environment: null,
      status: strOrNull(issue.status),
      assignee: strOrNull(assigned.name) ?? strOrNull(assigned.email),
      count: strOrNull(text(issue.count)),
      userCount: strOrNull(text(issue.userCount)),
      firstSeen: strOrNull(issue.firstSeen),
      lastSeen: strOrNull(issue.lastSeen),
      actor,
      alertRule: null,
      eventId: `issue:${action}:${id}`,
    };
  }
  if (resource === "event_alert") {
    if (action !== "triggered") return null;
    const ev = obj(data.event);
    const issueId = text(ev.issue_id) || /\/issues\/(\d+)/.exec(str(ev.issue_url))?.[1] || "";
    const tags = new Map(
      arr(ev.tags).map((t) => {
        const pair = arr(t);
        return [str(pair[0]), str(pair[1])] as const;
      }),
    );
    const project = sentryProject(ev.project);
    return {
      kind: "alert_triggered",
      resource,
      action,
      issueId,
      shortId: "",
      title: str(ev.title) || str(ev.message),
      culprit: str(ev.culprit),
      level: strOrNull(ev.level) ?? strOrNull(tags.get("level")),
      project: project.slug,
      projectName: project.name,
      url: str(ev.web_url) || str(ev.issue_url),
      environment: strOrNull(ev.environment) ?? strOrNull(tags.get("environment")),
      status: null,
      assignee: null,
      count: null,
      userCount: null,
      firstSeen: null,
      lastSeen: strOrNull(ev.datetime),
      actor,
      alertRule: strOrNull(data.triggered_rule) ?? strOrNull(obj(data.issue_alert).title),
      eventId: `event_alert:${str(ev.event_id) || issueId}:${str(data.triggered_rule)}`,
    };
  }
  if (resource === "metric_alert") {
    const kind: SentryEventKind | null =
      action === "critical"
        ? "metric_alert_critical"
        : action === "warning"
          ? "metric_alert_warning"
          : action === "resolved"
            ? "metric_alert_resolved"
            : null;
    if (!kind) return null;
    const alert = obj(data.metric_alert);
    const rule = obj(alert.alert_rule);
    const id = text(alert.id);
    const project = sentryProject(arr(rule.projects)[0]);
    return {
      kind,
      resource,
      action,
      issueId: id,
      shortId: "",
      title: str(alert.title) || str(rule.name) || str(data.description_title),
      culprit: str(data.description_text),
      level: null,
      project: project.slug,
      projectName: project.name,
      url: str(data.web_url),
      environment: strOrNull(rule.environment),
      status: strOrNull(text(alert.status)),
      assignee: null,
      count: null,
      userCount: null,
      firstSeen: strOrNull(alert.date_started),
      lastSeen: strOrNull(alert.date_detected),
      actor,
      alertRule: strOrNull(rule.name),
      eventId: `metric_alert:${id}:${action}:${str(alert.date_detected)}`,
    };
  }
  return null;
}

export function matchSentryTrigger(
  config: SentryTriggerConfig,
  event: SentryEvent,
): SentryEventKind | null {
  const wanted = (config.events ?? []).filter((e) => SENTRY_KINDS.has(e));
  if (wanted.length > 0 && !wanted.includes(event.kind)) return null;
  if (!anyMatch(config.projects, [event.project, event.projectName])) return null;
  // An event that names no environment / level isn't excluded by a filter on it.
  if (event.environment && !anyMatch(config.environments, [event.environment])) return null;
  if (event.level && !anyMatch(config.levels, [event.level])) return null;
  return event.kind;
}

export function sentryEventParams(event: SentryEvent): Record<string, string> {
  return {
    source: "sentry",
    event: event.kind,
    resource: event.resource,
    action: event.action,
    issueId: event.issueId,
    shortId: event.shortId,
    title: event.title,
    culprit: event.culprit,
    level: event.level ?? "",
    project: event.project,
    projectName: event.projectName,
    url: event.url,
    environment: event.environment ?? "",
    status: event.status ?? "",
    assignee: event.assignee ?? "",
    count: event.count ?? "",
    userCount: event.userCount ?? "",
    firstSeen: event.firstSeen ?? "",
    lastSeen: event.lastSeen ?? "",
    actor: event.actor ?? "",
    alertRule: event.alertRule ?? "",
    // Ticket-style aliases so one prompt template works for ticket + event triggers.
    ticketSource: "sentry",
    ticketExternalId: event.shortId || event.issueId,
    ticketTitle: event.title,
    ticketBody: event.culprit,
    ticketUrl: event.url,
    ticketLabels: event.level ?? "",
  };
}

// ── Alertmanager (Prometheus, Grafana) ──────────────────────────────────────

/** The most serialized alert / payload text an Alertmanager firing hands on. */
const ALERTMANAGER_JSON_MAX = 20_000;

/** A label / annotation map with every value as text. */
function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj(v))) {
    const s = typeof val === "string" ? val : text(val) || (val == null ? "" : JSON.stringify(val));
    out[k] = s;
  }
  return out;
}

function alertmanagerAlert(raw: unknown): AlertmanagerAlert {
  const a = obj(raw);
  return {
    status: str(a.status),
    labels: stringMap(a.labels),
    annotations: stringMap(a.annotations),
    startsAt: str(a.startsAt),
    endsAt: str(a.endsAt),
    generatorUrl: str(a.generatorURL),
    fingerprint: str(a.fingerprint),
    dashboardUrl: str(a.dashboardURL),
    panelUrl: str(a.panelURL),
    silenceUrl: str(a.silenceURL),
  };
}

function jsonText(v: unknown, max = ALERTMANAGER_JSON_MAX): string {
  try {
    return JSON.stringify(v).slice(0, max);
  } catch {
    return "";
  }
}

/**
 * Normalize an Alertmanager webhook delivery (also what Grafana Alerting's
 * webhook contact point sends): one alert group with its alerts. Null when
 * the payload has neither a status nor alerts.
 */
export function normalizeAlertmanagerEvent(payload: unknown): AlertmanagerEvent | null {
  const p = obj(payload);
  const alerts = arr(p.alerts).map(alertmanagerAlert);
  const status = str(p.status);
  if (!status && alerts.length === 0) return null;
  const firing = alerts.filter((a) => a.status === "firing").length;
  const resolved = alerts.filter((a) => a.status === "resolved").length;
  const kind: AlertmanagerEventKind =
    status === "resolved" || (!status && firing === 0) ? "resolved" : "firing";
  const unique = (key: string) => [
    ...new Set(alerts.map((a) => a.labels[key]).filter((v): v is string => !!v)),
  ];
  const commonLabels = stringMap(p.commonLabels);
  const alertnames = unique("alertname");
  if (alertnames.length === 0 && commonLabels.alertname) alertnames.push(commonLabels.alertname);
  const severities = unique("severity");
  if (severities.length === 0 && commonLabels.severity) severities.push(commonLabels.severity);
  const count = alerts.length || 1;
  const title =
    str(p.title) ||
    `[${kind.toUpperCase()}${count > 1 ? `:${count}` : ""}] ${alertnames.join(", ") || "alerts"}`;
  const message =
    str(p.message) ||
    alerts
      .map((a) => {
        const what = a.annotations.summary || a.annotations.description || a.annotations.message;
        if (!what) return "";
        return `${a.labels.alertname ? `${a.labels.alertname}: ` : ""}${what}`.trim();
      })
      .filter(Boolean)
      .join("\n");
  const truncated = Number(p.truncatedAlerts ?? 0);
  return {
    kind,
    receiver: str(p.receiver),
    groupKey: str(p.groupKey),
    externalUrl: str(p.externalURL),
    title,
    message,
    alertnames,
    severities,
    commonLabels,
    commonAnnotations: stringMap(p.commonAnnotations),
    groupLabels: stringMap(p.groupLabels),
    alerts,
    firing,
    resolved,
    truncated: Number.isFinite(truncated) ? truncated : 0,
    payload: p,
  };
}

export function matchAlertmanagerTrigger(
  config: AlertmanagerTriggerConfig,
  event: AlertmanagerEvent,
): AlertmanagerEventKind | null {
  const wanted = (config.events ?? []).filter((e) =>
    (ALERTMANAGER_EVENT_KINDS as readonly string[]).includes(e),
  );
  if (wanted.length > 0 && !wanted.includes(event.kind)) return null;
  if (!anyMatch(config.alertnames, event.alertnames)) return null;
  if (!anyMatch(config.severities, event.severities)) return null;
  if (!anyMatch(config.receivers, [event.receiver])) return null;
  return event.kind;
}

export function alertmanagerEventParams(event: AlertmanagerEvent): Record<string, string> {
  return {
    source: "alertmanager",
    event: event.kind,
    status: event.kind,
    receiver: event.receiver,
    groupKey: event.groupKey,
    title: event.title,
    message: event.message,
    alertnames: event.alertnames.join(","),
    severities: event.severities.join(","),
    count: String(event.alerts.length),
    firing: String(event.firing),
    resolved: String(event.resolved),
    externalUrl: event.externalUrl,
    labels: jsonText(event.commonLabels),
    annotations: jsonText(event.commonAnnotations),
    alerts: jsonText(event.alerts),
    payload: jsonText(event.payload),
  };
}

// ── Datadog ─────────────────────────────────────────────────────────────────

const DATADOG_PAYLOAD_MAX = 20_000;

/**
 * The first non-empty text under any of the keys, matched
 * case-insensitively and ignoring `$` / `_` — so a template that names a
 * field `$ALERT_TRANSITION`, `alert_transition` or `alertTransition` all
 * reach the same place.
 */
function pickText(o: Obj, ...keys: string[]): string {
  const norm = (k: string) => k.replace(/[$_\-\s]/g, "").toLowerCase();
  const wanted = keys.map(norm);
  for (const [k, v] of Object.entries(o)) {
    if (wanted.includes(norm(k))) {
      const t = text(v);
      if (t) return t;
    }
  }
  return "";
}

/** `$ALERT_TRANSITION` → the kind it is. */
export function datadogKindOf(transition: string, alertType: string): DatadogEventKind | null {
  const t = lower(transition);
  if (t) {
    if (/recover/.test(t)) return "recovered";
    if (/no\s*data/.test(t)) return "no_data";
    if (/warn/.test(t)) return "warning";
    if (/trigger/.test(t)) return "triggered";
  }
  switch (lower(alertType)) {
    case "error":
      return "triggered";
    case "warning":
      return "warning";
    case "success":
      return "recovered";
    default:
      return null;
  }
}

/**
 * Normalize a Datadog webhook, best-effort over whatever payload template
 * the webhook was given (the default, or `DATADOG_PAYLOAD_TEMPLATE`). Never
 * null — a payload with none of the fields still fires a trigger with no
 * `events` filter, with the whole payload as `payload`.
 */
export function normalizeDatadogEvent(payload: unknown): DatadogEvent {
  const p = obj(payload);
  const transition = pickText(p, "alert_transition", "transition");
  const alertType = pickText(p, "alert_type", "alertType");
  const rawTags = p.tags ?? p.TAGS ?? p.$TAGS;
  const tags = Array.isArray(rawTags)
    ? rawTags.map(text).filter(Boolean)
    : text(rawTags)
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
  const org = obj(p.org);
  return {
    kind: datadogKindOf(transition, alertType),
    transition: transition || null,
    alertType: alertType || null,
    eventId: pickText(p, "id", "event_id", "eventId"),
    alertId: pickText(p, "alert_id", "alertId", "monitor_id", "monitorId"),
    title: pickText(p, "title", "event_title", "eventTitle", "alert_title", "alertTitle"),
    body: pickText(p, "body", "event_msg", "eventMsg", "message", "text"),
    link: pickText(p, "link", "url", "event_url"),
    priority: pickText(p, "priority").toUpperCase() || null,
    status: pickText(p, "alert_status", "alertStatus", "status") || null,
    tags,
    hostname: pickText(p, "hostname", "host") || null,
    query: pickText(p, "alert_query", "alertQuery", "query") || null,
    scope: pickText(p, "alert_scope", "alertScope", "scope") || null,
    metric: pickText(p, "alert_metric", "alertMetric", "metric") || null,
    org: str(org.name) || pickText(p, "org_name", "orgName") || null,
    date: pickText(p, "date", "last_updated", "lastUpdated") || null,
    payload: p,
  };
}

export function matchDatadogTrigger(
  config: DatadogTriggerConfig,
  event: DatadogEvent,
): DatadogEventKind | "any" | null {
  const wanted = (config.events ?? []).filter((e) =>
    (DATADOG_EVENT_KINDS as readonly string[]).includes(e),
  );
  if (wanted.length > 0 && (!event.kind || !wanted.includes(event.kind))) return null;
  if (!anyMatch(config.priorities, event.priority ? [event.priority] : [])) return null;
  if (!anyMatch(config.tags, event.tags)) return null;
  if (
    !anyMatch(config.monitors, [event.alertId, event.title, pickText(event.payload, "alert_title")])
  ) {
    return null;
  }
  return event.kind ?? "any";
}

export function datadogEventParams(event: DatadogEvent): Record<string, string> {
  return {
    source: "datadog",
    event: event.kind ?? "",
    transition: event.transition ?? "",
    alertType: event.alertType ?? "",
    eventId: event.eventId,
    alertId: event.alertId,
    title: event.title,
    body: event.body,
    link: event.link,
    priority: event.priority ?? "",
    status: event.status ?? "",
    tags: event.tags.join(","),
    hostname: event.hostname ?? "",
    query: event.query ?? "",
    scope: event.scope ?? "",
    metric: event.metric ?? "",
    org: event.org ?? "",
    date: event.date ?? "",
    payload: jsonText(event.payload, DATADOG_PAYLOAD_MAX),
  };
}

// ── Fan-out ─────────────────────────────────────────────────────────────────

export type EventFireResult = TriggerFireResult & { triggerId: string; matched: string };

/** The normalized event each source's ingress hands the fan-out. */
export interface EventBySource {
  github: GitHubEvent;
  gitlab: GitLabEvent;
  slack: SlackEvent;
  linear: LinearEvent;
  jira: JiraEvent;
  pylon: PylonEvent;
  pagerduty: PagerDutyEvent;
  sentry: SentryEvent;
  alertmanager: AlertmanagerEvent;
  datadog: DatadogEvent;
}

export type EventOf<S extends EventTriggerType> = EventBySource[S];

/** "https://github.com/Acme/API.git" and "git@github.com:acme/api" → "github.com/acme/api". */
export function normalizeRepoKey(url: string): string | null {
  const m = url
    .trim()
    .replace(/\.git$/, "")
    .match(/^(?:https?:\/\/|git@|ssh:\/\/git@)?([^/:]+)[/:](.+)$/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** Workspace of a repo registered in Optio, matched by URL; null when unknown. */
async function workspaceOfRepo(repoUrl: string | undefined): Promise<string | null> {
  if (!repoUrl) return null;
  const wanted = normalizeRepoKey(repoUrl);
  if (!wanted) return null;
  const rows = await db
    .select({ repoUrl: repos.repoUrl, workspaceId: repos.workspaceId })
    .from(repos);
  const hit = rows.find((r) => normalizeRepoKey(r.repoUrl) === wanted);
  return hit?.workspaceId ?? null;
}

/** What the fan-out needs to know about a trigger's target before firing it. */
interface TargetFacts {
  workspaceId: string | null;
  /** A scheduled Task's own repo — its default GitHub filter. */
  repoUrl: string | null;
}

async function targetFacts(trigger: TriggerRow): Promise<TargetFacts | null> {
  const kind = definitionKindOf(trigger.targetType);
  if (kind) {
    const row = await getDefinition(trigger.targetId, kind);
    if (!row) return null;
    return {
      workspaceId: row.workspaceId ?? null,
      repoUrl: kind === "repo-blueprint" ? row.repoUrl : null,
    };
  }
  if (trigger.targetType === "persistent_agent") {
    const { getPersistentAgentUnscoped } = await import("./persistent-agent-service.js");
    const row = await getPersistentAgentUnscoped(trigger.targetId);
    if (!row) return null;
    // An agent with a repo listens to that repo, like a scheduled Task.
    const { getRepo } = await import("./repo-service.js");
    const repo = row.repoId ? await getRepo(row.repoId).catch(() => null) : null;
    return { workspaceId: row.workspaceId ?? null, repoUrl: repo?.repoUrl ?? null };
  }
  return null;
}

/**
 * The event, matched against one trigger's filters, as what its target
 * gets: the firing for `fireTrigger`, plus which kind matched. Null when
 * the trigger's filters don't match.
 */
export function firingFor<S extends EventTriggerType>(
  source: S,
  event: EventOf<S>,
  config: Record<string, unknown>,
): (TriggerFiring & { matched: string }) | null {
  if (source === "github") {
    const ev = event as GitHubEvent;
    const kind = matchGitHubTrigger(config as GitHubTriggerConfig, ev);
    if (!kind) return null;
    const about = ev.kind === "pr" || ev.kind === "issue";
    const noun = ev.kind === "pr" ? "PR" : "Issue";
    const what = about
      ? `${ev.repo} ${noun} #${ev.number} — ${ev.title}`
      : `${ev.repo} — ${ev.title}`;
    return {
      source: "github",
      matched: kind,
      params: githubEventParams(ev, kind),
      repoUrlHint: ev.repoUrl,
      ticket: about
        ? { source: "github", externalId: `${ev.repo}#${ev.number}`, url: ev.url }
        : undefined,
      title: about ? `${noun} #${ev.number} ${ev.title}` : ev.title,
      message: [
        `GitHub ${kind.replace(/_/g, " ")}: ${what}`,
        ev.url,
        ev.commentBody ? `\n${ev.author}: ${ev.commentBody}` : ev.body ? `\n${ev.body}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (source === "gitlab") {
    const ev = event as GitLabEvent;
    const kind = matchGitLabTrigger(config as GitLabTriggerConfig, ev);
    if (!kind) return null;
    const about = ev.kind === "mr" || ev.kind === "issue";
    const ref = ev.kind === "mr" ? `!${ev.iid}` : `#${ev.iid}`;
    const noun = ev.kind === "mr" ? "MR" : "Issue";
    const what = about
      ? `${ev.project} ${noun} ${ref} — ${ev.title}`
      : `${ev.project} — ${ev.title}`;
    return {
      source: "gitlab",
      matched: kind,
      params: gitlabEventParams(ev, kind),
      repoUrlHint: ev.projectUrl,
      ticket: about
        ? { source: "gitlab", externalId: `${ev.project}${ref}`, url: ev.url }
        : undefined,
      title: about ? `${noun} ${ref} ${ev.title}` : ev.title,
      message: [
        `GitLab ${kind.replace(/_/g, " ")}: ${what}`,
        ev.url,
        ev.commentBody ? `\n${ev.author}: ${ev.commentBody}` : ev.body ? `\n${ev.body}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (source === "jira") {
    const ev = event as JiraEvent;
    const kind = matchJiraTrigger(config as JiraTriggerConfig, ev);
    if (!kind) return null;
    return {
      source: "jira",
      matched: kind,
      params: jiraEventParams(ev, kind),
      ticket: { source: "jira", externalId: ev.key, url: ev.url },
      title: `${ev.key} ${ev.title}`,
      message: [
        `Jira ${kind}: ${ev.key} — ${ev.title}`,
        ev.url,
        [
          ev.status
            ? `Status: ${ev.previousStatus ? `${ev.previousStatus} → ` : ""}${ev.status}`
            : null,
          ev.assignee ? `Assignee: ${ev.assignee}` : null,
          ev.priority ? `Priority: ${ev.priority}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
        ev.commentBody
          ? `\n${ev.actor ?? "someone"}: ${ev.commentBody}`
          : ev.description
            ? `\n${ev.description}`
            : null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (source === "sentry") {
    const ev = event as SentryEvent;
    const kind = matchSentryTrigger(config as SentryTriggerConfig, ev);
    if (!kind) return null;
    const label = ev.shortId ? `${ev.shortId} ` : "";
    return {
      source: "sentry",
      matched: kind,
      params: sentryEventParams(ev),
      ticket: ev.issueId
        ? { source: "sentry", externalId: ev.shortId || ev.issueId, url: ev.url }
        : undefined,
      title: `${label}${ev.title}`,
      message: [
        `Sentry ${kind.replace(/_/g, " ")}: ${label}${ev.title}`,
        ev.url,
        [
          ev.project ? `Project: ${ev.project}` : null,
          ev.environment ? `Environment: ${ev.environment}` : null,
          ev.level ? `Level: ${ev.level}` : null,
          ev.culprit ? `Culprit: ${ev.culprit}` : null,
          ev.alertRule ? `Rule: ${ev.alertRule}` : null,
          ev.count ? `Events: ${ev.count}` : null,
          ev.userCount ? `Users: ${ev.userCount}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (source === "alertmanager") {
    const ev = event as AlertmanagerEvent;
    const kind = matchAlertmanagerTrigger(config as AlertmanagerTriggerConfig, ev);
    if (!kind) return null;
    return {
      source: "alertmanager",
      matched: kind,
      params: alertmanagerEventParams(ev),
      title: ev.title,
      message: [
        `Alertmanager ${kind}: ${ev.title}`,
        ev.message || null,
        ev.alerts
          .map(
            (a) =>
              `- [${a.status}] ${Object.entries(a.labels)
                .map(([k, v]) => `${k}=${v}`)
                .join(" ")}${a.generatorUrl ? `\n  ${a.generatorUrl}` : ""}`,
          )
          .join("\n") || null,
        ev.externalUrl || null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (source === "datadog") {
    const ev = event as DatadogEvent;
    const kind = matchDatadogTrigger(config as DatadogTriggerConfig, ev);
    if (!kind) return null;
    return {
      source: "datadog",
      matched: kind,
      params: datadogEventParams(ev),
      title: ev.title || undefined,
      message: [
        `Datadog ${ev.transition ?? kind}${ev.title ? `: ${ev.title}` : ""}`,
        ev.link || null,
        [
          ev.priority ? `Priority: ${ev.priority}` : null,
          ev.hostname ? `Host: ${ev.hostname}` : null,
          ev.tags.length ? `Tags: ${ev.tags.join(", ")}` : null,
          ev.query ? `Query: ${ev.query}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
        ev.body ? `\n${ev.body}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (source === "slack") {
    const ev = event as SlackEvent;
    if (!matchSlackTrigger(config as unknown as SlackTriggerConfig, ev)) return null;
    return {
      source: "slack",
      matched: ev.event,
      params: slackEventParams(ev),
      title: ev.text.length > 60 ? `${ev.text.slice(0, 57)}…` : ev.text,
      message: [
        `Slack message in ${ev.channelId} from ${slackPoster(ev)}:`,
        ev.text,
        slackPermalink(ev),
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (source === "linear") {
    const ev = event as LinearEvent;
    const kind = matchLinearTrigger(config as LinearTriggerConfig, ev);
    if (!kind) return null;
    return {
      source: "linear",
      matched: kind,
      params: linearEventParams(ev, kind),
      ticket: { source: "linear", externalId: ev.identifier, url: ev.url },
      title: `${ev.identifier} ${ev.title}`,
      message: [
        `Linear ${kind}: ${ev.identifier} — ${ev.title}`,
        ev.url,
        ev.commentBody
          ? `\n${ev.actor ?? "someone"}: ${ev.commentBody}`
          : ev.description
            ? `\n${ev.description}`
            : null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (source === "pylon") {
    const ev = event as PylonEvent;
    const kind = matchPylonTrigger(config as PylonTriggerConfig, ev);
    if (!kind) return null;
    const label = ev.issueNumber ? `#${ev.issueNumber} ` : "";
    // No issue title: the run keeps its definition's name and an agent's
    // message comes from "Pylon" (the dispatcher's sender name falls back
    // to the source).
    return {
      source: "pylon",
      matched: kind,
      params: pylonEventParams(ev),
      ticket: ev.issueId ? { source: "pylon", externalId: ev.issueId, url: ev.url } : undefined,
      title: ev.title ? `${label}${ev.title}` : undefined,
      message: [
        `Pylon ${ev.event ?? "event"}${ev.title ? `: ${label}${ev.title}` : ""}`,
        ev.url,
        ev.account ? `Account: ${ev.account}` : null,
        ev.requester ? `Requester: ${ev.requester}` : null,
        ev.body ? `\n${ev.body}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  const ev = event as PagerDutyEvent;
  const kind = matchPagerDutyTrigger(config as PagerDutyTriggerConfig, ev);
  if (!kind) return null;
  const number = ev.incidentNumber == null ? "" : `#${ev.incidentNumber} `;
  return {
    source: "pagerduty",
    matched: kind,
    params: pagerDutyEventParams(ev),
    ticket: { source: "pagerduty", externalId: ev.id, url: ev.url },
    title: `${number}${ev.title}`,
    message: [
      `PagerDuty ${kind.replace(/^incident\./, "incident ").replace(/_/g, " ")}: ${number}${ev.title}`,
      ev.url,
      [
        ev.service ? `Service: ${ev.service}` : null,
        ev.urgency ? `Urgency: ${ev.urgency}` : null,
        ev.priority ? `Priority: ${ev.priority}` : null,
        ev.status ? `Status: ${ev.status}` : null,
        ev.assignees.length ? `Assigned to: ${ev.assignees.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * Fire every enabled `source` trigger whose filters match the event,
 * whatever it targets. Each match starts what its target starts — a run, a
 * task, a terminal, an agent turn — with the event's fields as prompt params
 * (and, for an agent, as a message). Failures are per-trigger (logged, not
 * thrown).
 */
export async function fireEventTriggers<S extends EventTriggerType>(
  source: S,
  event: EventOf<S>,
): Promise<EventFireResult[]> {
  const candidates = await listEnabledTriggersOfType(source);
  if (candidates.length === 0) return [];

  // A repo registered in Optio belongs to a workspace; its events must not
  // reach definitions in other workspaces, whatever login they claim.
  // Unregistered repos (and the sources that carry no repo) still match on
  // the trigger's own filters only.
  const eventRepoUrl =
    source === "github"
      ? (event as GitHubEvent).repoUrl
      : source === "gitlab"
        ? (event as GitLabEvent).projectUrl
        : undefined;
  const repoWorkspace = await workspaceOfRepo(eventRepoUrl);
  const eventRepo = eventRepoUrl ? normalizeRepoKey(eventRepoUrl) : null;
  const repoFilterKey = source === "github" ? "repos" : "projects";

  const results: EventFireResult[] = [];
  for (const trigger of candidates) {
    const config = (trigger.config ?? {}) as Record<string, unknown>;
    const firing = firingFor(source, event, config);
    if (!firing) continue;

    try {
      const target = await targetFacts(trigger);
      if (!target) continue;
      // A definition without a workspace is unscoped (auth-disabled dev, or
      // a row from before workspaces) — only one that belongs to a
      // *different* workspace is refused.
      if (repoWorkspace && target.workspaceId && target.workspaceId !== repoWorkspace) {
        logger.info(
          { source, triggerId: trigger.id, targetType: trigger.targetType },
          "Event trigger skipped: repo belongs to another workspace",
        );
        continue;
      }
      // A scheduled Task (or an agent with a repo) listens to its own repo
      // unless the trigger names others — a PR in some other repo shouldn't
      // start work in this one.
      const repoFilter = Array.isArray(config[repoFilterKey])
        ? (config[repoFilterKey] as string[])
        : [];
      if (
        eventRepoUrl !== undefined &&
        target.repoUrl &&
        repoFilter.length === 0 &&
        normalizeRepoKey(target.repoUrl) !== eventRepo
      ) {
        continue;
      }

      const { matched, ...rest } = firing;
      const fired = await fireTrigger(trigger, rest);
      if (fired) results.push({ ...fired, triggerId: trigger.id, matched });
    } catch (err) {
      logger.warn(
        { err, source, triggerId: trigger.id, targetType: trigger.targetType },
        "Event trigger failed to start its target",
      );
    }
  }
  return results;
}
