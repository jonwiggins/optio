// ── Triggers ────────────────────────────────────────────────────────────────
// One vocabulary for every row in `workflow_triggers`, whatever it starts.
// A trigger is a *When*: the same seven kinds attach to a Job, a scheduled
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
  | "linear";

export const TRIGGER_TYPES: readonly TriggerType[] = [
  "manual",
  "schedule",
  "webhook",
  "ticket",
  "github",
  "slack",
  "linear",
];

/** Triggers fed by a provider's signed event stream rather than a poll or a URL. */
export type EventTriggerType = "github" | "slack" | "linear";

export const EVENT_TRIGGER_TYPES: readonly EventTriggerType[] = ["github", "slack", "linear"];

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

export interface SlackTriggerConfig {
  /** Channel id (C0123…) to listen on. Required. */
  channelId: string;
  /** Only fire when the message contains this text (case-insensitive). */
  keyword?: string;
  /** Only fire for messages that @-mention the app (`app_mention` events). */
  mentionOnly?: boolean;
  /** Also fire for thread replies (default: top-level messages only). */
  includeThreads?: boolean;
}

export interface SlackEvent {
  /** `message` | `app_mention`. */
  event: string;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs: string | null;
  teamId: string | null;
  eventId: string | null;
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
}

export interface LinearEvent {
  kinds: LinearEventKind[];
  /** User ids / names the event concerns: new assignee, @-mentions. */
  targets: string[];
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
