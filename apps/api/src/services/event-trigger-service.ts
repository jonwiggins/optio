/**
 * Event triggers: GitHub, Slack, Linear, Pylon, and PagerDuty happenings
 * that start work. Rows in `workflow_triggers` with type = "github" |
 * "slack" | "linear" | "pylon" | "pagerduty", whatever they target — a Job,
 * a scheduled Task, a Local automation, or a persistent agent all take the
 * same trigger, and the dispatcher turns a match into what that target
 * spawns.
 *
 * Shape: each source has a pure `normalize*` (raw webhook payload → one
 * normalized event, or null when it's nothing we care about) and a pure
 * `match*` (trigger config × event → the matched kind, or null). The ingress
 * routes verify signatures, normalize, and call `fireEventTriggers`, which
 * fans the event out to every matching trigger's target — except Pylon,
 * whose deliveries are addressed to one trigger (`/api/hooks/pylon/:id`,
 * checked against that trigger's secret) and so go through `firingFor` and
 * `fireTrigger` for it alone.
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
  PagerDutyEvent,
  PagerDutyEventKind,
  PagerDutyTriggerConfig,
  PylonEvent,
  PylonTriggerConfig,
  SlackBot,
  SlackEvent,
  SlackTriggerConfig,
} from "@optio/shared";
import {
  GITHUB_EVENT_KINDS,
  GITHUB_PERSONAL_EVENT_KINDS,
  LINEAR_EVENT_KINDS,
  LINEAR_PERSONAL_EVENT_KINDS,
  PAGERDUTY_EVENT_KINDS,
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

// ── Fan-out ─────────────────────────────────────────────────────────────────

export type EventFireResult = TriggerFireResult & { triggerId: string; matched: string };

/** The normalized event each source's ingress hands the fan-out. */
export interface EventBySource {
  github: GitHubEvent;
  slack: SlackEvent;
  linear: LinearEvent;
  pylon: PylonEvent;
  pagerduty: PagerDutyEvent;
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
      // A scheduled Task (or an agent with a repo) listens to its own repo
      // unless the trigger names others — a PR in some other repo shouldn't
      // start work in this one.
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
