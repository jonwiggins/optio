// ── Triggers ────────────────────────────────────────────────────────────────
// One vocabulary for every row in `workflow_triggers`, whatever it starts.
// A trigger is a *When*: the same fourteen kinds attach to a Job, a scheduled
// Task, a Local automation, or a persistent agent, and the server's trigger
// dispatcher (`services/trigger-dispatch.ts`) turns a firing into whatever
// that target spawns — a run, a task, a terminal, or an agent turn.

/** What a trigger row points at (`workflow_triggers.target_type`). */
export type TriggerTargetType =
  "job" | "task_config" | "local_blueprint" | "persistent_agent" | "pr_review";

export type TriggerType =
  | "manual"
  | "schedule"
  | "webhook"
  | "ticket"
  | "github"
  | "gitlab"
  | "slack"
  | "linear"
  | "jira"
  | "pylon"
  | "pagerduty"
  | "sentry"
  | "alertmanager"
  | "datadog";

export const TRIGGER_TYPES: readonly TriggerType[] = [
  "manual",
  "schedule",
  "webhook",
  "ticket",
  "github",
  "gitlab",
  "slack",
  "linear",
  "jira",
  "pylon",
  "pagerduty",
  "sentry",
  "alertmanager",
  "datadog",
];

/**
 * Triggers fed by a provider's event stream rather than a poll or a generic
 * URL. GitHub, Slack, Linear, Jira, PagerDuty and Sentry sign their
 * deliveries and GitLab sends a shared token, so each has one workspace-wide
 * receiver (`/api/webhooks/<provider>`); Pylon, Alertmanager (Grafana) and
 * Datadog can't sign, so each of their triggers has its own shared secret
 * and its own URL (`/api/hooks/<provider>/<trigger id>`).
 */
export type EventTriggerType =
  | "github"
  | "gitlab"
  | "slack"
  | "linear"
  | "jira"
  | "pylon"
  | "pagerduty"
  | "sentry"
  | "alertmanager"
  | "datadog";

export const EVENT_TRIGGER_TYPES: readonly EventTriggerType[] = [
  "github",
  "gitlab",
  "slack",
  "linear",
  "jira",
  "pylon",
  "pagerduty",
  "sentry",
  "alertmanager",
  "datadog",
];

export const isEventTriggerType = (t: string): t is EventTriggerType =>
  (EVENT_TRIGGER_TYPES as readonly string[]).includes(t);

/**
 * Event triggers whose sender can't sign a delivery, so the trigger itself
 * carries a shared secret (`config.secret`, minted on create and returned
 * once) and listens at its own URL, `/api/hooks/<type>/<trigger id>`. The
 * delivery presents the secret as `X-Optio-Secret`, `Authorization: Bearer`,
 * or the password of HTTP basic auth.
 */
export type SelfSecretTriggerType = "pylon" | "alertmanager" | "datadog";

export const SELF_SECRET_TRIGGER_TYPES: readonly SelfSecretTriggerType[] = [
  "pylon",
  "alertmanager",
  "datadog",
];

export const isSelfSecretTriggerType = (t: string): t is SelfSecretTriggerType =>
  (SELF_SECRET_TRIGGER_TYPES as readonly string[]).includes(t);

/** The header a self-secret delivery carries its trigger's secret in. */
export const TRIGGER_SECRET_HEADER = "X-Optio-Secret";

/**
 * Which trigger types each target accepts. A PR review only re-runs on a
 * schedule; everything else takes the full set.
 */
export const TRIGGER_TYPES_FOR_TARGET: Record<TriggerTargetType, readonly TriggerType[]> = {
  job: TRIGGER_TYPES,
  task_config: TRIGGER_TYPES,
  local_blueprint: TRIGGER_TYPES,
  persistent_agent: TRIGGER_TYPES,
  pr_review: ["schedule"],
};

// ── GitHub ──────────────────────────────────────────────────────────────────

/**
 * Things that can happen on GitHub that a trigger listens for. Grouped as
 * the form shows them: three about a person (review requested, @-mentioned,
 * assigned); PR kinds (opened, commented, a review submitted, new commits
 * pushed, merged, closed unmerged); issue kinds (opened, commented, edited,
 * reopened, closed); labels landing or leaving a PR / issue; repo kinds (a
 * push, a tag, a branch created or deleted, a release, a workflow run or
 * check suite finishing, a deployment finishing, a `repository_dispatch`);
 * security alerts (Dependabot, code scanning, secret scanning); and
 * discussions (created, commented).
 */
export type GitHubEventKind =
  | "review_requested"
  | "mentioned"
  | "assigned"
  | "pr_opened"
  | "pr_commented"
  | "pr_review_submitted"
  | "pr_synchronized"
  | "pr_merged"
  | "pr_closed"
  | "issue_opened"
  | "issue_commented"
  | "issue_edited"
  | "issue_reopened"
  | "issue_closed"
  | "labeled"
  | "unlabeled"
  | "push"
  | "tag_pushed"
  | "branch_created"
  | "branch_deleted"
  | "release_published"
  | "workflow_succeeded"
  | "workflow_failed"
  | "deployment_succeeded"
  | "deployment_failed"
  | "repository_dispatch"
  | "dependabot_alert"
  | "code_scanning_alert"
  | "secret_scanning_alert"
  | "discussion_created"
  | "discussion_commented";

export const GITHUB_EVENT_KINDS: readonly GitHubEventKind[] = [
  "review_requested",
  "mentioned",
  "assigned",
  "pr_opened",
  "pr_commented",
  "pr_review_submitted",
  "pr_synchronized",
  "pr_merged",
  "pr_closed",
  "issue_opened",
  "issue_commented",
  "issue_edited",
  "issue_reopened",
  "issue_closed",
  "labeled",
  "unlabeled",
  "push",
  "tag_pushed",
  "branch_created",
  "branch_deleted",
  "release_published",
  "workflow_succeeded",
  "workflow_failed",
  "deployment_succeeded",
  "deployment_failed",
  "repository_dispatch",
  "dependabot_alert",
  "code_scanning_alert",
  "secret_scanning_alert",
  "discussion_created",
  "discussion_commented",
];

/** Kinds that are "about someone" and so need `login` to match a target. */
export const GITHUB_PERSONAL_EVENT_KINDS: readonly GitHubEventKind[] = [
  "review_requested",
  "mentioned",
  "assigned",
];

/**
 * Kinds that are someone writing or changing something on a PR, an issue
 * or a discussion — what `postedBy` and `authorOnly` filter by who did it
 * (`ignoreLogins` applies to every kind). An agent's own work must never
 * wake it again: by default (`postedBy: "people"`) a bot's comment, review,
 * edit or push to a PR doesn't fire these, and the trigger's own `login`
 * never does.
 */
export const GITHUB_ACTOR_EVENT_KINDS: readonly GitHubEventKind[] = [
  "pr_commented",
  "pr_review_submitted",
  "pr_synchronized",
  "issue_commented",
  "issue_edited",
  "discussion_commented",
];

/** Kinds that carry a comment body, which `bodyMatches` filters on. */
export const GITHUB_COMMENT_EVENT_KINDS: readonly GitHubEventKind[] = [
  "pr_commented",
  "pr_review_submitted",
  "issue_commented",
  "discussion_commented",
];

/** Kinds that are a security alert, which `severities` filters on. */
export const GITHUB_ALERT_EVENT_KINDS: readonly GitHubEventKind[] = [
  "dependabot_alert",
  "code_scanning_alert",
  "secret_scanning_alert",
];

/** The state of a submitted PR review (`pr_review_submitted`). */
export type GitHubReviewState = "approved" | "changes_requested" | "commented";

export const GITHUB_REVIEW_STATES: readonly GitHubReviewState[] = [
  "approved",
  "changes_requested",
  "commented",
];

/**
 * Whose comments, reviews and edits fire the actor kinds: `people` (the
 * default), `bots` (GitHub Apps and accounts ending in `[bot]`), or `anyone`.
 * Same idea as Slack's `postedBy`.
 */
export type GitHubPostedBy = "people" | "bots" | "anyone";

export const GITHUB_POSTED_BY: readonly GitHubPostedBy[] = ["people", "bots", "anyone"];

export interface GitHubTriggerConfig {
  /** Which kinds fire this trigger (empty / missing = any). */
  events?: GitHubEventKind[];
  /**
   * A GitHub login: `review_requested` / `mentioned` / `assigned` match
   * against it, and its own comments, reviews, edits and PR pushes never
   * fire the actor kinds (an agent commenting or pushing as this account
   * doesn't wake itself; assigning yourself still fires `assigned`).
   */
  login?: string;
  /**
   * Restrict to these `owner/name` repos (empty = any). A scheduled Task
   * with no filter listens to its own repo only.
   */
  repos?: string[];
  /**
   * `push` / `workflow_*` / `deployment_*` / `branch_*`: only these branches
   * (empty = any). Exact names or globs (`release/*`); a push to a tag never
   * matches `push` (that's `tag_pushed`).
   */
  branches?: string[];
  /** `workflow_*`: only these workflow names (or a check suite's app name), case-insensitive. */
  workflows?: string[];
  /**
   * Any-match labels: `labeled` / `unlabeled` fire only for one of these,
   * and a PR / issue / discussion kind only when it carries one (empty = any).
   */
  labels?: string[];
  /**
   * Whose comments, reviews, edits and PR pushes fire the actor kinds
   * (`GITHUB_ACTOR_EVENT_KINDS`); default `people`. Other kinds — a push to
   * a branch, a release, a workflow run — fire whoever caused them.
   */
  postedBy?: GitHubPostedBy;
  /**
   * Logins whose actions never fire this trigger, whatever the kind: an
   * agent commenting or pushing with a personal access token is a person to
   * GitHub, so name its account here (or as `login`).
   */
  ignoreLogins?: string[];
  /**
   * Actor kinds: fire only when the PR / issue / discussion author is the
   * one commenting or editing — the reporter replying to a question.
   */
  authorOnly?: boolean;
  /**
   * Comment kinds: only comments whose body starts with this text
   * (case-insensitive) or, written `/pattern/flags`, matches the regex —
   * slash commands like `/optio retry`.
   */
  bodyMatches?: string;
  /** `pr_review_submitted`: only reviews in these states (empty = any). */
  reviewStates?: GitHubReviewState[];
  /**
   * Alert kinds: only these severities (`critical`, `high`, `medium`, `low`,
   * …; empty = any). An alert naming no severity (secret scanning) isn't
   * excluded.
   */
  severities?: string[];
}

/** One normalized GitHub happening (from the webhook payload). */
export interface GitHubEvent {
  kinds: GitHubEventKind[];
  /** Logins the event concerns: requested reviewer, assignee, @-mentions. */
  targets: string[];
  repo: string;
  repoUrl: string;
  kind:
    | "pr"
    | "issue"
    | "discussion"
    | "push"
    | "tag"
    | "branch"
    | "release"
    | "workflow"
    | "deployment"
    | "dispatch"
    | "alert";
  /** PR / issue / discussion / alert number; 0 for a push, release or workflow run. */
  number: number;
  title: string;
  body: string;
  url: string;
  /** Who opened the PR / issue / discussion; else who caused the event. */
  author: string;
  /** Who did this — commented, reviewed, edited, pushed; lowercased login. */
  actor: string;
  /** Whether the actor is a GitHub App or a `[bot]` account. */
  actorIsBot: boolean;
  /** The PR's head, the pushed branch, the workflow run's branch, the deployment's ref. */
  headBranch: string | null;
  baseBranch: string | null;
  /** Comment / review body when the event is a comment or review. */
  commentBody: string | null;
  commentUrl: string | null;
  /** Raw `X-GitHub-Event` + `action`. */
  event: string;
  action: string;
  /** The PR's / issue's labels. */
  labels?: string[];
  /** The label just added (`labeled`) or removed (`unlabeled`). */
  label?: string | null;
  /** A push: the full ref, the head sha, the commit subjects, the compare URL. */
  ref?: string | null;
  sha?: string | null;
  commits?: string | null;
  compareUrl?: string | null;
  /** A release or a tag push: its tag. */
  tag?: string | null;
  /** A workflow run / check suite: its name and conclusion (`success`, `failure`, …). */
  workflow?: string | null;
  conclusion?: string | null;
  /** A closed PR: whether it was merged. */
  merged?: boolean;
  /** An edit: what changed, as text (`title: old → new`, the previous body). */
  changes?: string | null;
  /** A submitted review: `approved`, `changes_requested`, `commented`. */
  reviewState?: string | null;
  /** A deployment: its environment. */
  environment?: string | null;
  /** A security alert: its severity, lowercased, when the alert names one. */
  severity?: string | null;
  /** A `repository_dispatch`: its `event_type` and its `client_payload` as JSON text. */
  dispatchType?: string | null;
  dispatchPayload?: string | null;
}

// ── GitLab ──────────────────────────────────────────────────────────────────

/**
 * Things that can happen on GitLab (gitlab.com or self-hosted) that a
 * trigger listens for — GitHub's kinds in GitLab's words: merge requests,
 * issues, notes, pushes, releases, pipelines.
 */
export type GitLabEventKind =
  | "review_requested"
  | "mentioned"
  | "assigned"
  | "mr_opened"
  | "mr_merged"
  | "issue_opened"
  | "labeled"
  | "push"
  | "release_published"
  | "pipeline_succeeded"
  | "pipeline_failed";

export const GITLAB_EVENT_KINDS: readonly GitLabEventKind[] = [
  "review_requested",
  "mentioned",
  "assigned",
  "mr_opened",
  "mr_merged",
  "issue_opened",
  "labeled",
  "push",
  "release_published",
  "pipeline_succeeded",
  "pipeline_failed",
];

/** Kinds that are "about someone" and so need `username` to match a target. */
export const GITLAB_PERSONAL_EVENT_KINDS: readonly GitLabEventKind[] = [
  "review_requested",
  "mentioned",
  "assigned",
];

export interface GitLabTriggerConfig {
  /** Which kinds fire this trigger (empty / missing = any). */
  events?: GitLabEventKind[];
  /** A GitLab username: `review_requested` / `mentioned` / `assigned` match against it. */
  username?: string;
  /**
   * Restrict to these `group/project` paths (empty = any). A scheduled Task
   * with no filter listens to its own repo only.
   */
  projects?: string[];
  /** `push` / `pipeline_*`: only these branches (empty = any); exact names or globs. */
  branches?: string[];
  /** Any-match labels: `labeled` fires only for one of these, an MR / issue kind only when it carries one. */
  labels?: string[];
}

/** One normalized GitLab happening (from the webhook payload). */
export interface GitLabEvent {
  kinds: GitLabEventKind[];
  /** Usernames the event concerns: new reviewers, new assignees, @-mentions (the three below, together). */
  targets: string[];
  /** Usernames just asked to review (`review_requested`). */
  reviewers: string[];
  /** Usernames just assigned (`assigned`). */
  assignees: string[];
  /** Usernames @-mentioned (`mentioned`). */
  mentions: string[];
  /** `group/project`. */
  project: string;
  /** The project's web URL — matched against a repo registered in Optio. */
  projectUrl: string;
  kind: "mr" | "issue" | "push" | "release" | "pipeline";
  /** The MR's / issue's iid; 0 otherwise. */
  iid: number;
  title: string;
  body: string;
  url: string;
  /** The author's username. */
  author: string;
  /** The MR's source, the pushed branch, the pipeline's branch. */
  sourceBranch: string | null;
  targetBranch: string | null;
  commentBody: string | null;
  commentUrl: string | null;
  labels: string[];
  label: string | null;
  ref: string | null;
  sha: string | null;
  commits: string | null;
  compareUrl: string | null;
  tag: string | null;
  /** A pipeline's status (`success`, `failed`, …). */
  pipelineStatus: string | null;
  /** Raw `object_kind` + `object_attributes.action`. */
  event: string;
  action: string;
}

// ── Slack ───────────────────────────────────────────────────────────────────

/**
 * Whose Slack posts fire a trigger: `people` (the default), `bots` (apps,
 * integrations and incoming webhooks, such as an alerting tool), or `anyone`.
 */
export type SlackPostedBy = "people" | "bots" | "anyone";

export const SLACK_POSTED_BY: readonly SlackPostedBy[] = ["people", "bots", "anyone"];

export interface SlackTriggerConfig {
  /** Channel id (C0123…) to listen on. Required. */
  channelId: string;
  /** Only fire when the message contains this text (case-insensitive). */
  keyword?: string;
  /** Only fire for messages that @-mention the app (`app_mention` events). */
  mentionOnly?: boolean;
  /** Also fire for thread replies (default: top-level messages only). */
  includeThreads?: boolean;
  /**
   * Whose messages fire it (default `people`). Posts by the Slack app Optio
   * receives events as never fire a trigger, whatever this says.
   */
  postedBy?: SlackPostedBy;
  /**
   * With bots: only this one — its name as Slack shows it, its bot id (B…),
   * or its app id (A…); case-insensitive. Empty = any bot.
   */
  bot?: string;
}

/** The bot that posted a Slack message. */
export interface SlackBot {
  /** Bot id (B…); null for an app posting without one. */
  id: string | null;
  /** App id (A…), when Slack says. */
  appId: string | null;
  /** The name Slack shows on the post, when it says. */
  name: string | null;
}

export interface SlackEvent {
  /** `message` | `app_mention`. */
  event: string;
  channelId: string;
  /** Who posted it; empty for a bot's post. */
  userId: string;
  /**
   * What the message says. A bot's post adds what its attachments and blocks
   * say, which is where alerting tools put the details.
   */
  text: string;
  ts: string;
  threadTs: string | null;
  teamId: string | null;
  eventId: string | null;
  /** Set when a bot posted it. */
  bot?: SlackBot | null;
}

// ── Linear ──────────────────────────────────────────────────────────────────

export type LinearEventKind = "assigned" | "mentioned" | "created" | "labeled";

export const LINEAR_EVENT_KINDS: readonly LinearEventKind[] = [
  "assigned",
  "mentioned",
  "created",
  "labeled",
];

/** Kinds that are "about someone" and so need `user` to match a target. */
export const LINEAR_PERSONAL_EVENT_KINDS: readonly LinearEventKind[] = ["assigned", "mentioned"];

export interface LinearTriggerConfig {
  /** Which kinds fire this trigger (empty / missing = any). */
  events?: LinearEventKind[];
  /** A Linear user id, or display name / `@handle` — `assigned` / `mentioned` match against it. */
  user?: string;
  /** Any-match label filter (empty = any). */
  labels?: string[];
  /** Restrict to these team keys (empty = any). */
  teams?: string[];
  /**
   * Only tickets from someone else: skip an issue `user` created, and any
   * change `user` made themselves (assigning it to themselves, mentioning
   * themselves, adding a label). Needs `user`.
   */
  othersOnly?: boolean;
}

export interface LinearEvent {
  kinds: LinearEventKind[];
  /** User ids / names the event concerns: new assignee, @-mentions. */
  targets: string[];
  /** Who did it (the webhook's actor), every way the payload names them: id, name, email, handle. Lowercased. */
  actorKeys: string[];
  /** Who created the issue, when the payload says (issue events): id, name, email, handle. Lowercased. */
  creatorKeys: string[];
  /** The issue's assignee, every way the payload names them. Lowercased. */
  assigneeKeys: string[];
  /** e.g. ENG-123 */
  identifier: string;
  title: string;
  description: string;
  url: string;
  labels: string[];
  teamKey: string | null;
  assignee: string | null;
  priority: number | null;
  state: string | null;
  commentBody: string | null;
  commentUrl: string | null;
  actor: string | null;
  /** Raw `type` + `action`. */
  type: string;
  action: string;
}

// ── Pylon ───────────────────────────────────────────────────────────────────

/**
 * Pylon (support) sends webhooks from Settings → Triggers on Issue / Account /
 * Contact changes. The payload is whatever the trigger's author shaped, and
 * it isn't signed — Pylon only adds custom request headers — so each trigger
 * has its own shared secret, sent as `X-Optio-Secret` (or a Bearer token) to
 * `/api/hooks/pylon/<trigger id>`.
 */
export interface PylonTriggerConfig {
  /**
   * The shared secret the delivery must carry. Generated when the trigger is
   * created and returned once (the create response); every later read says
   * only `hasSecret: true`.
   */
  secret?: string;
  /**
   * Free-text event kinds (whatever the Pylon trigger calls them, e.g.
   * `issue.created`), matched case-insensitively against the payload's
   * `event` / `event_type` / `type` / `trigger` / `data.event`. Empty = any.
   */
  events?: string[];
}

/** One normalized Pylon delivery, best-effort over a user-shaped payload. */
export interface PylonEvent {
  /** The payload's event kind, when it names one. */
  event: string | null;
  issueId: string;
  issueNumber: string;
  title: string;
  body: string;
  state: string;
  url: string;
  account: string;
  requester: string;
  assignee: string;
  tags: string[];
  /** The whole delivery, for prompts that need a field the summary doesn't carry. */
  payload: Record<string, unknown>;
}

// ── PagerDuty ───────────────────────────────────────────────────────────────

/** PagerDuty Webhooks v3 incident event types a trigger listens for. */
export type PagerDutyEventKind =
  | "incident.triggered"
  | "incident.acknowledged"
  | "incident.unacknowledged"
  | "incident.resolved"
  | "incident.escalated"
  | "incident.reassigned"
  | "incident.delegated"
  | "incident.reopened"
  | "incident.priority_updated"
  | "incident.responder.added"
  | "incident.responder.replied"
  | "incident.status_update_published"
  | "incident.annotated";

export const PAGERDUTY_EVENT_KINDS: readonly PagerDutyEventKind[] = [
  "incident.triggered",
  "incident.acknowledged",
  "incident.unacknowledged",
  "incident.resolved",
  "incident.escalated",
  "incident.reassigned",
  "incident.delegated",
  "incident.reopened",
  "incident.priority_updated",
  "incident.responder.added",
  "incident.responder.replied",
  "incident.status_update_published",
  "incident.annotated",
];

export type PagerDutyUrgency = "high" | "low";

export const PAGERDUTY_URGENCIES: readonly PagerDutyUrgency[] = ["high", "low"];

export interface PagerDutyTriggerConfig {
  /** Which event types fire this trigger (empty / missing = any). */
  events?: PagerDutyEventKind[];
  /** Restrict to these services, by id (P1234AB) or name, case-insensitive (empty = any). */
  services?: string[];
  /** Only incidents of this urgency (missing = any). */
  urgency?: PagerDutyUrgency;
}

/** One normalized PagerDuty Webhooks v3 incident event. */
export interface PagerDutyEvent {
  kind: PagerDutyEventKind;
  /** The incident id (`data.id`). */
  id: string;
  incidentNumber: number | null;
  title: string;
  url: string;
  urgency: PagerDutyUrgency | null;
  /** The priority's name (P1, P2, …), when set. */
  priority: string | null;
  /** The service's name. */
  service: string;
  serviceId: string;
  status: string;
  /** The assignees' names. */
  assignees: string[];
  /** The webhook event's own id (`event.id`), for dedupe. */
  eventId: string;
}

// ── Jira ────────────────────────────────────────────────────────────────────

/**
 * Jira Cloud webhooks (Settings → System → WebHooks, or the REST API) for
 * issues and comments. Signed with the webhook's secret as
 * `X-Hub-Signature: sha256=<hex HMAC of the body>`.
 */
export type JiraEventKind =
  "assigned" | "mentioned" | "created" | "commented" | "transitioned" | "labeled";

export const JIRA_EVENT_KINDS: readonly JiraEventKind[] = [
  "assigned",
  "mentioned",
  "created",
  "commented",
  "transitioned",
  "labeled",
];

/** Kinds that are "about someone" and so need `user` to match a target. */
export const JIRA_PERSONAL_EVENT_KINDS: readonly JiraEventKind[] = ["assigned", "mentioned"];

export interface JiraTriggerConfig {
  /** Which kinds fire this trigger (empty / missing = any). */
  events?: JiraEventKind[];
  /** A Jira account id, display name, or email — `assigned` / `mentioned` match against it. */
  user?: string;
  /** Restrict to these project keys (empty = any). */
  projects?: string[];
  /** Any-match label filter (empty = any). */
  labels?: string[];
  /** Restrict to these issue types by name (empty = any). */
  issueTypes?: string[];
  /** `transitioned`: only into these statuses (empty = any). */
  statuses?: string[];
}

/** One normalized Jira issue / comment event. */
export interface JiraEvent {
  kinds: JiraEventKind[];
  /** Account ids / names the event concerns: the new assignee and the mentions, together. Lowercased. */
  targets: string[];
  /** The new assignee, every way the payload names them (`assigned`). Lowercased. */
  assignees: string[];
  /** Who is mentioned: account ids and names (`mentioned`). Lowercased. */
  mentions: string[];
  /** Who did it, every way the payload names them: account id, name, email. Lowercased. */
  actorKeys: string[];
  /** e.g. PROJ-123 */
  key: string;
  title: string;
  description: string;
  url: string;
  /** The project's key and name. */
  project: string;
  projectName: string;
  status: string | null;
  /** `transitioned`: the status it came from. */
  previousStatus: string | null;
  assignee: string | null;
  priority: string | null;
  labels: string[];
  issueType: string | null;
  commentBody: string | null;
  commentUrl: string | null;
  actor: string | null;
  /** Raw `webhookEvent` + `issue_event_type_name`. */
  event: string;
  eventTypeName: string;
}

// ── Sentry ──────────────────────────────────────────────────────────────────

/**
 * Sentry internal-integration webhooks (Settings → Developer Settings →
 * Internal Integrations → Webhooks), signed with the integration's client
 * secret as `Sentry-Hook-Signature`. Issue state changes, issue alert rules
 * firing, and metric alerts; the per-event `error` resource is too chatty
 * to start work from and is dropped.
 */
export type SentryEventKind =
  | "issue_created"
  | "issue_unresolved"
  | "issue_resolved"
  | "issue_assigned"
  | "issue_archived"
  | "alert_triggered"
  | "metric_alert_critical"
  | "metric_alert_warning"
  | "metric_alert_resolved";

export const SENTRY_EVENT_KINDS: readonly SentryEventKind[] = [
  "issue_created",
  "issue_unresolved",
  "issue_resolved",
  "issue_assigned",
  "issue_archived",
  "alert_triggered",
  "metric_alert_critical",
  "metric_alert_warning",
  "metric_alert_resolved",
];

export const SENTRY_LEVELS = ["fatal", "error", "warning", "info", "debug"] as const;

export interface SentryTriggerConfig {
  /** Which kinds fire this trigger (empty / missing = any). */
  events?: SentryEventKind[];
  /** Restrict to these projects, by slug, name or id (empty = any). */
  projects?: string[];
  /** Restrict to these environments (empty = any; an event with no environment matches). */
  environments?: string[];
  /** Only issues / events at these levels (empty = any). */
  levels?: string[];
}

/** One normalized Sentry webhook. */
export interface SentryEvent {
  kind: SentryEventKind;
  /** `Sentry-Hook-Resource`: `issue`, `event_alert`, `metric_alert`. */
  resource: string;
  action: string;
  issueId: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string | null;
  /** The project's slug (or name / id when that's all the payload says). */
  project: string;
  projectName: string;
  url: string;
  environment: string | null;
  status: string | null;
  assignee: string | null;
  /** Event and user counts, when the payload says. */
  count: string | null;
  userCount: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  actor: string | null;
  /** The alert rule's name (issue alerts and metric alerts). */
  alertRule: string | null;
  /** A key that identifies the delivery, for dedupe. */
  eventId: string;
}

// ── Alertmanager (Prometheus, Grafana) ──────────────────────────────────────

/**
 * Prometheus Alertmanager's webhook receiver format (`version: "4"`), which
 * Grafana Alerting's webhook contact point sends too. Neither signs: the
 * receiver takes the trigger's secret as `Authorization: Bearer`, basic auth
 * (any user, the secret as password), or `X-Optio-Secret`. One delivery is
 * one alert group; it fires a trigger once, with every alert in it.
 */
export type AlertmanagerEventKind = "firing" | "resolved";

export const ALERTMANAGER_EVENT_KINDS: readonly AlertmanagerEventKind[] = ["firing", "resolved"];

export interface AlertmanagerTriggerConfig {
  /** The shared secret the delivery must carry (minted on create, shown once). */
  secret?: string;
  /** Which group statuses fire this trigger (empty / missing = any). */
  events?: AlertmanagerEventKind[];
  /** Any-match `alertname` labels, case-insensitive (empty = any). */
  alertnames?: string[];
  /** Any-match `severity` labels, case-insensitive (empty = any). */
  severities?: string[];
  /** Restrict to these receiver names (empty = any). */
  receivers?: string[];
}

/** One alert in an Alertmanager group. */
export interface AlertmanagerAlert {
  status: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorUrl: string;
  fingerprint: string;
  /** Grafana adds these. */
  dashboardUrl: string;
  panelUrl: string;
  silenceUrl: string;
}

/** One normalized Alertmanager / Grafana delivery (an alert group). */
export interface AlertmanagerEvent {
  kind: AlertmanagerEventKind;
  receiver: string;
  groupKey: string;
  externalUrl: string;
  /** Grafana's title, else `[FIRING:2] alertname`. */
  title: string;
  /** Grafana's message, else the alerts' summaries / descriptions. */
  message: string;
  alertnames: string[];
  severities: string[];
  commonLabels: Record<string, string>;
  commonAnnotations: Record<string, string>;
  groupLabels: Record<string, string>;
  alerts: AlertmanagerAlert[];
  firing: number;
  resolved: number;
  truncated: number;
  /** The whole delivery, for prompts that need a field the summary doesn't carry. */
  payload: Record<string, unknown>;
}

// ── Datadog ─────────────────────────────────────────────────────────────────

/**
 * Datadog monitors, through the Webhooks integration (Integrations →
 * Webhooks). Datadog doesn't sign; a custom header carries the trigger's
 * secret. The payload is the webhook's template — the default one or
 * `DATADOG_PAYLOAD_TEMPLATE`, which adds the transition, priority, tags,
 * and the monitor's query so a trigger can filter on them.
 */
export type DatadogEventKind = "triggered" | "warning" | "no_data" | "recovered";

export const DATADOG_EVENT_KINDS: readonly DatadogEventKind[] = [
  "triggered",
  "warning",
  "no_data",
  "recovered",
];

export const DATADOG_PRIORITIES = ["P1", "P2", "P3", "P4", "P5"] as const;

/** The payload template to paste into the Datadog webhook, so every field reaches the trigger. */
export const DATADOG_PAYLOAD_TEMPLATE =
  '{"id":"$ID","event_type":"$EVENT_TYPE","title":"$EVENT_TITLE","body":"$EVENT_MSG",' +
  '"date":"$DATE","alert_id":"$ALERT_ID","alert_title":"$ALERT_TITLE",' +
  '"alert_transition":"$ALERT_TRANSITION","alert_type":"$ALERT_TYPE",' +
  '"alert_status":"$ALERT_STATUS","alert_query":"$ALERT_QUERY","alert_scope":"$ALERT_SCOPE",' +
  '"alert_metric":"$ALERT_METRIC","priority":"$PRIORITY","tags":"$TAGS",' +
  '"hostname":"$HOSTNAME","link":"$LINK","org":{"id":"$ORG_ID","name":"$ORG_NAME"}}';

export interface DatadogTriggerConfig {
  /** The shared secret the delivery must carry (minted on create, shown once). */
  secret?: string;
  /** Which transitions fire this trigger (empty / missing = any, including payloads with no transition). */
  events?: DatadogEventKind[];
  /** Only these priorities (`P1`…`P5`; empty = any). */
  priorities?: string[];
  /** Any-match tags, `key:value` or bare, case-insensitive (empty = any). */
  tags?: string[];
  /** Restrict to these monitors, by id or title, case-insensitive (empty = any). */
  monitors?: string[];
}

/** One normalized Datadog webhook, best-effort over whatever the template sends. */
export interface DatadogEvent {
  /** The transition, when the payload names one. */
  kind: DatadogEventKind | null;
  /** The raw `$ALERT_TRANSITION` (`Triggered`, `Recovered`, `Warn`, `No Data`, …). */
  transition: string | null;
  /** `$ALERT_TYPE`: `error`, `warning`, `success`, `info`. */
  alertType: string | null;
  eventId: string;
  alertId: string;
  /** The event's title (`$EVENT_TITLE`), else the monitor's (`$ALERT_TITLE`). */
  title: string;
  body: string;
  link: string;
  priority: string | null;
  status: string | null;
  tags: string[];
  hostname: string | null;
  query: string | null;
  scope: string | null;
  metric: string | null;
  org: string | null;
  date: string | null;
  /** The whole delivery, for prompts that need a field the summary doesn't carry. */
  payload: Record<string, unknown>;
}
