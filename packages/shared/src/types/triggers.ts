// ── Triggers ────────────────────────────────────────────────────────────────
// One vocabulary for every row in `workflow_triggers`, whatever it starts.
// A trigger is a *When*: the same nine kinds attach to a Job, a scheduled
// Task, a Local automation, or a persistent agent, and the server's trigger
// dispatcher (`services/trigger-dispatch.ts`) turns a firing into whatever
// that target spawns — a run, a task, a terminal, or an agent turn.

/** What a trigger row points at (`workflow_triggers.target_type`). */
export type TriggerTargetType =
  | "job"
  | "task_config"
  | "local_blueprint"
  | "persistent_agent"
  | "pr_review";

export type TriggerType =
  | "manual"
  | "schedule"
  | "webhook"
  | "ticket"
  | "github"
  | "slack"
  | "linear"
  | "pylon"
  | "pagerduty";

export const TRIGGER_TYPES: readonly TriggerType[] = [
  "manual",
  "schedule",
  "webhook",
  "ticket",
  "github",
  "slack",
  "linear",
  "pylon",
  "pagerduty",
];

/**
 * Triggers fed by a provider's event stream rather than a poll or a generic
 * URL: GitHub, Slack, Linear and PagerDuty sign their deliveries; Pylon's
 * are verified by a per-trigger shared secret the receiver checks.
 */
export type EventTriggerType = "github" | "slack" | "linear" | "pylon" | "pagerduty";

export const EVENT_TRIGGER_TYPES: readonly EventTriggerType[] = [
  "github",
  "slack",
  "linear",
  "pylon",
  "pagerduty",
];

export const isEventTriggerType = (t: string): t is EventTriggerType =>
  (EVENT_TRIGGER_TYPES as readonly string[]).includes(t);

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

/** Things that can happen on GitHub that a trigger listens for. */
export type GitHubEventKind =
  | "review_requested"
  | "mentioned"
  | "assigned"
  | "pr_opened"
  | "issue_opened";

export const GITHUB_EVENT_KINDS: readonly GitHubEventKind[] = [
  "review_requested",
  "mentioned",
  "assigned",
  "pr_opened",
  "issue_opened",
];

/** Kinds that are "about someone" and so need `login` to match a target. */
export const GITHUB_PERSONAL_EVENT_KINDS: readonly GitHubEventKind[] = [
  "review_requested",
  "mentioned",
  "assigned",
];

export interface GitHubTriggerConfig {
  /** Which kinds fire this trigger (empty / missing = any). */
  events?: GitHubEventKind[];
  /** A GitHub login: `review_requested` / `mentioned` / `assigned` match against it. */
  login?: string;
  /**
   * Restrict to these `owner/name` repos (empty = any). A scheduled Task
   * with no filter listens to its own repo only.
   */
  repos?: string[];
}

/** One normalized GitHub happening (from the webhook payload). */
export interface GitHubEvent {
  kinds: GitHubEventKind[];
  /** Logins the event concerns: requested reviewer, assignee, @-mentions. */
  targets: string[];
  repo: string;
  repoUrl: string;
  kind: "pr" | "issue";
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  headBranch: string | null;
  baseBranch: string | null;
  /** Comment / review body when the event is a comment or review. */
  commentBody: string | null;
  commentUrl: string | null;
  /** Raw `X-GitHub-Event` + `action`. */
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
