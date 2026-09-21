/**
 * Event triggers: GitHub, Slack, and Linear happenings that start work.
 * Rows in `workflow_triggers` with type = "github" | "slack" | "linear",
 * whatever they target — a Job, a scheduled Task, a Local automation, or a
 * persistent agent all take the same trigger, and the dispatcher turns a
 * match into what that target spawns.
 *
 * Shape: each source has a pure `normalize*` (raw webhook payload → one
 * normalized event, or null when it's nothing we care about) and a pure
 * `match*` (trigger config × event → the matched kind, or null). The ingress
 * routes verify signatures, normalize, and call `fireEventTriggers`, which
 * fans the event out to every matching trigger's target.
 *
 * Each trigger's config carries the identity it listens for (`login`,
 * `user`) — the ingress endpoints themselves are workspace-wide, so a repo
 * registered in Optio only ever reaches targets in its own workspace.
 */
import type {
  EventTriggerType,
  GitHubEvent,
  GitHubEventKind,
  GitHubTriggerConfig,
  LinearEvent,
  LinearEventKind,
  LinearTriggerConfig,
  SlackEvent,
  SlackTriggerConfig,
} from "@optio/shared";
import {
  GITHUB_EVENT_KINDS,
  GITHUB_PERSONAL_EVENT_KINDS,
  LINEAR_EVENT_KINDS,
  LINEAR_PERSONAL_EVENT_KINDS,
} from "@optio/shared";
import { db } from "../db/client.js";
import { repos } from "../db/schema.js";
import { logger } from "../logger.js";
import { listEnabledTriggersOfType, type TriggerRow } from "./trigger-service.js";
import { fireTrigger, type TriggerFireResult, type TriggerFiring } from "./trigger-dispatch.js";

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
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

// ── GitHub ──────────────────────────────────────────────────────────────────

/**
 * Turn a GitHub webhook delivery into one normalized event. Returns null for
 * deliveries that aren't about a PR / issue happening to a person (pushes,
 * check runs, label edits, …).
 */
export function normalizeGitHubEvent(eventName: string, payload: unknown): GitHubEvent | null {
  const p = obj(payload);
  const action = str(p.action);
  const repo = obj(p.repository);
  const repoFullName = str(repo.full_name);
  const repoUrl = str(repo.html_url) || (repoFullName ? `https://github.com/${repoFullName}` : "");
  if (!repoFullName) return null;

  const kinds = new Set<GitHubEventKind>();
  const targets = new Set<string>();
  let subject: Obj | null = null;
  let kind: "pr" | "issue" = "issue";
  let commentBody: string | null = null;
  let commentUrl: string | null = null;

  const addMentions = (text: string) => {
    const mentions = extractMentions(text);
    if (mentions.length === 0) return;
    kinds.add("mentioned");
    for (const m of mentions) targets.add(m);
  };

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
      } else {
        return null;
      }
      break;
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
  const sender = obj(p.sender);
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
  };
}

/** Kinds that are "about you" and so need `config.login` to match a target. */
const GITHUB_PERSONAL_KINDS: ReadonlySet<GitHubEventKind> = new Set(GITHUB_PERSONAL_EVENT_KINDS);

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
  ];
  for (const kind of order) {
    if (!wanted.has(kind) || !event.kinds.includes(kind)) continue;
    if (GITHUB_PERSONAL_KINDS.has(kind)) {
      if (!login || !targets.has(login)) continue;
      // Don't fire on your own comments mentioning yourself.
      if (kind === "mentioned" && lower(event.author) === login && event.commentBody) continue;
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
  };
}

// ── Slack ───────────────────────────────────────────────────────────────────

/**
 * Normalize a Slack Events API `event_callback`. Bot messages, edits,
 * joins and other subtypes are dropped — only human `message` and
 * `app_mention` events come through.
 */
export function normalizeSlackEvent(payload: unknown): SlackEvent | null {
  const p = obj(payload);
  if (p.type !== "event_callback") return null;
  const ev = obj(p.event);
  const type = str(ev.type);
  if (type !== "message" && type !== "app_mention") return null;
  if (ev.bot_id || ev.subtype) return null;
  const channelId = str(ev.channel);
  const text = str(ev.text);
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
  };
}

export function matchSlackTrigger(config: SlackTriggerConfig, event: SlackEvent): boolean {
  if (!config.channelId || config.channelId !== event.channelId) return false;
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
  };
}

// ── Linear ──────────────────────────────────────────────────────────────────

function linearLabels(data: Obj): string[] {
  const raw = Array.isArray(data.labels) ? data.labels : [];
  return raw.map((l) => str(obj(l).name)).filter(Boolean);
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

  return {
    kinds: [...kinds],
    targets: [...targets],
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

// ── Fan-out ─────────────────────────────────────────────────────────────────

export type EventFireResult = TriggerFireResult & { triggerId: string; matched: string };

type EventOf<S extends EventTriggerType> = S extends "github"
  ? GitHubEvent
  : S extends "slack"
    ? SlackEvent
    : LinearEvent;

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
  switch (trigger.targetType) {
    case "job": {
      const { getWorkflow } = await import("./workflow-service.js");
      const row = await getWorkflow(trigger.targetId);
      return row ? { workspaceId: row.workspaceId ?? null, repoUrl: null } : null;
    }
    case "task_config": {
      const { getTaskConfig } = await import("./task-config-service.js");
      const row = await getTaskConfig(trigger.targetId);
      return row ? { workspaceId: row.workspaceId ?? null, repoUrl: row.repoUrl } : null;
    }
    case "local_blueprint": {
      const { getBlueprint } = await import("./local-blueprint-service.js");
      const row = await getBlueprint(trigger.targetId);
      return row ? { workspaceId: row.workspaceId ?? null, repoUrl: null } : null;
    }
    case "persistent_agent": {
      const { getPersistentAgentUnscoped } = await import("./persistent-agent-service.js");
      const row = await getPersistentAgentUnscoped(trigger.targetId);
      return row ? { workspaceId: row.workspaceId ?? null, repoUrl: null } : null;
    }
    default:
      return null;
  }
}

/** The event, matched against one trigger's filters, as what its target gets. */
function firingFor<S extends EventTriggerType>(
  source: S,
  event: EventOf<S>,
  config: Record<string, unknown>,
): (TriggerFiring & { matched: string }) | null {
  if (source === "github") {
    const ev = event as GitHubEvent;
    const kind = matchGitHubTrigger(config as GitHubTriggerConfig, ev);
    if (!kind) return null;
    const noun = ev.kind === "pr" ? "PR" : "Issue";
    return {
      source: "github",
      matched: kind,
      params: githubEventParams(ev, kind),
      repoUrlHint: ev.repoUrl,
      ticket: { source: "github", externalId: `${ev.repo}#${ev.number}`, url: ev.url },
      title: `${noun} #${ev.number} ${ev.title}`,
      message: [
        `GitHub ${kind.replace(/_/g, " ")}: ${ev.repo} ${noun} #${ev.number} — ${ev.title}`,
        ev.url,
        ev.commentBody ? `\n${ev.author}: ${ev.commentBody}` : ev.body ? `\n${ev.body}` : null,
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
      message: [`Slack message in ${ev.channelId} from ${ev.userId}:`, ev.text, slackPermalink(ev)]
        .filter(Boolean)
        .join("\n"),
    };
  }
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
  // Unregistered repos (and Slack / Linear, which carry no repo) still match
  // on the trigger's own filters only.
  const repoWorkspace =
    source === "github" ? await workspaceOfRepo((event as GitHubEvent).repoUrl) : null;
  const eventRepo = source === "github" ? normalizeRepoKey((event as GitHubEvent).repoUrl) : null;

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
      // A scheduled Task listens to its own repo unless the trigger names
      // others — a PR in some other repo shouldn't start work in this one.
      const repoFilter = Array.isArray(config.repos) ? (config.repos as string[]) : [];
      if (
        source === "github" &&
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
