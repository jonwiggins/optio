/**
 * Event triggers for Local automations: GitHub, Slack, and Linear happenings
 * that spawn a terminal from a blueprint. Rows in `workflow_triggers` with
 * target_type = "local_blueprint" and type = "github" | "slack" | "linear".
 *
 * Shape: each source has a pure `normalize*` (raw webhook payload → one
 * normalized event, or null when it's nothing we care about) and a pure
 * `match*` (trigger config × event → the matched kind, or null). The ingress
 * routes verify signatures, normalize, and call `fireLocalEventTriggers`,
 * which fans the event out to every matching trigger's blueprint.
 *
 * Automations are personal (hosts are the user's own machine), so each
 * trigger's config carries the identity it listens for (`login`, `user`) —
 * the ingress endpoints themselves are workspace-wide.
 */
import { and, eq } from "drizzle-orm";
import type {
  LocalGitHubEvent,
  LocalGitHubEventKind,
  LocalGitHubTriggerConfig,
  LocalLinearEvent,
  LocalLinearEventKind,
  LocalLinearTriggerConfig,
  LocalSlackEvent,
  LocalSlackTriggerConfig,
} from "@optio/shared";
import { LOCAL_GITHUB_EVENT_KINDS, LOCAL_LINEAR_EVENT_KINDS } from "@optio/shared";
import { db } from "../db/client.js";
import { repos, workflowTriggers } from "../db/schema.js";
import { logger } from "../logger.js";
import { getBlueprint, spawnFromBlueprint } from "./local-blueprint-service.js";

export type LocalEventSource = "github" | "slack" | "linear";

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
export function normalizeGitHubEvent(eventName: string, payload: unknown): LocalGitHubEvent | null {
  const p = obj(payload);
  const action = str(p.action);
  const repo = obj(p.repository);
  const repoFullName = str(repo.full_name);
  const repoUrl = str(repo.html_url) || (repoFullName ? `https://github.com/${repoFullName}` : "");
  if (!repoFullName) return null;

  const kinds = new Set<LocalGitHubEventKind>();
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
const GITHUB_PERSONAL_KINDS: ReadonlySet<LocalGitHubEventKind> = new Set([
  "review_requested",
  "mentioned",
  "assigned",
]);

export function matchGitHubTrigger(
  config: LocalGitHubTriggerConfig,
  event: LocalGitHubEvent,
): LocalGitHubEventKind | null {
  const repos = (config.repos ?? []).map(lower).filter(Boolean);
  if (repos.length > 0 && !repos.includes(lower(event.repo))) return null;

  const wanted = new Set<LocalGitHubEventKind>(
    config.events && config.events.length > 0 ? config.events : LOCAL_GITHUB_EVENT_KINDS,
  );
  const login = lower(stripAt(config.login ?? ""));
  const targets = new Set(event.targets.map(lower));

  // Prefer the most specific kind: review_requested > assigned > mentioned > opened.
  const order: LocalGitHubEventKind[] = [
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
  event: LocalGitHubEvent,
  matched: LocalGitHubEventKind,
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
export function normalizeSlackEvent(payload: unknown): LocalSlackEvent | null {
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

export function matchSlackTrigger(
  config: LocalSlackTriggerConfig,
  event: LocalSlackEvent,
): boolean {
  if (!config.channelId || config.channelId !== event.channelId) return false;
  // An @-mention arrives as both `app_mention` and `message` when the app
  // subscribes to both; a trigger listens to exactly one of them.
  if (config.mentionOnly ? event.event !== "app_mention" : event.event !== "message") return false;
  if (event.threadTs && event.threadTs !== event.ts && !config.includeThreads) return false;
  const keyword = lower(config.keyword);
  if (keyword && !lower(event.text).includes(keyword)) return false;
  return true;
}

export function slackPermalink(event: LocalSlackEvent): string {
  const ts = event.ts.replace(".", "");
  return ts ? `https://slack.com/archives/${event.channelId}/p${ts}` : "";
}

export function slackEventParams(event: LocalSlackEvent): Record<string, string> {
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
export function normalizeLinearEvent(payload: unknown): LocalLinearEvent | null {
  const p = obj(payload);
  const type = str(p.type);
  const action = str(p.action);
  const data = obj(p.data);
  const updatedFrom = obj(p.updatedFrom);
  const actor = strOrNull(obj(p.actor).name) ?? strOrNull(obj(p.actor).id);

  const kinds = new Set<LocalLinearEventKind>();
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

const LINEAR_PERSONAL_KINDS: ReadonlySet<LocalLinearEventKind> = new Set(["assigned", "mentioned"]);

export function matchLinearTrigger(
  config: LocalLinearTriggerConfig,
  event: LocalLinearEvent,
): LocalLinearEventKind | null {
  const teams = (config.teams ?? []).map(lower).filter(Boolean);
  if (teams.length > 0 && !teams.includes(lower(event.teamKey))) return null;
  const labels = (config.labels ?? []).map(lower).filter(Boolean);
  if (labels.length > 0 && !event.labels.some((l) => labels.includes(lower(l)))) return null;

  const wanted = new Set<LocalLinearEventKind>(
    config.events && config.events.length > 0 ? config.events : LOCAL_LINEAR_EVENT_KINDS,
  );
  const user = lower(stripAt(config.user ?? ""));
  const targets = new Set(event.targets.map(lower));

  const order: LocalLinearEventKind[] = ["assigned", "mentioned", "labeled", "created"];
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
  event: LocalLinearEvent,
  matched: LocalLinearEventKind,
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

export interface LocalEventFireResult {
  triggerId: string;
  blueprintId: string;
  terminalId: string;
  matched: string;
}

type EventOf<S extends LocalEventSource> = S extends "github"
  ? LocalGitHubEvent
  : S extends "slack"
    ? LocalSlackEvent
    : LocalLinearEvent;

/**
 * Fire every enabled `source` trigger whose filters match the event. Each
 * match spawns a terminal from the trigger's blueprint with the event's
 * fields as prompt params. Failures are per-trigger (logged, not thrown).
 */
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

/** "https://github.com/Acme/API.git" and "git@github.com:acme/api" → "github.com/acme/api". */
export function normalizeRepoKey(url: string): string | null {
  const m = url
    .trim()
    .replace(/\.git$/, "")
    .match(/^(?:https?:\/\/|git@|ssh:\/\/git@)?([^/:]+)[/:](.+)$/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export async function fireLocalEventTriggers<S extends LocalEventSource>(
  source: S,
  event: EventOf<S>,
): Promise<LocalEventFireResult[]> {
  const candidates = await db
    .select()
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.targetType, "local_blueprint"),
        eq(workflowTriggers.type, source),
        eq(workflowTriggers.enabled, true),
      ),
    );

  // A repo registered in Optio belongs to a workspace; its events must not
  // reach automations in other workspaces, whatever login they claim.
  // Unregistered repos (and Slack / Linear, which carry no repo) still match
  // on the trigger's own filters only.
  const repoWorkspace =
    source === "github" ? await workspaceOfRepo((event as LocalGitHubEvent).repoUrl) : undefined;

  const results: LocalEventFireResult[] = [];
  for (const trigger of candidates) {
    const config = (trigger.config ?? {}) as Record<string, unknown>;
    let matched: string | null = null;
    let params: Record<string, string> = {};
    let ticket: { source: string; externalId: string; url?: string } | undefined;
    let repoUrl: string | undefined;
    let title: string | undefined;

    if (source === "github") {
      const ev = event as LocalGitHubEvent;
      const kind = matchGitHubTrigger(config as LocalGitHubTriggerConfig, ev);
      if (!kind) continue;
      matched = kind;
      params = githubEventParams(ev, kind);
      repoUrl = ev.repoUrl;
      ticket = { source: "github", externalId: `${ev.repo}#${ev.number}`, url: ev.url };
      title = `${ev.kind === "pr" ? "PR" : "Issue"} #${ev.number} ${ev.title}`;
    } else if (source === "slack") {
      const ev = event as LocalSlackEvent;
      if (!matchSlackTrigger(config as unknown as LocalSlackTriggerConfig, ev)) continue;
      matched = ev.event;
      params = slackEventParams(ev);
      title = ev.text.length > 60 ? `${ev.text.slice(0, 57)}…` : ev.text;
    } else {
      const ev = event as LocalLinearEvent;
      const kind = matchLinearTrigger(config as LocalLinearTriggerConfig, ev);
      if (!kind) continue;
      matched = kind;
      params = linearEventParams(ev, kind);
      ticket = { source: "linear", externalId: ev.identifier, url: ev.url };
      title = `${ev.identifier} ${ev.title}`;
    }

    try {
      const blueprint = await getBlueprint(trigger.targetId);
      if (!blueprint || !blueprint.enabled) continue;
      if (repoWorkspace && blueprint.workspaceId !== repoWorkspace) {
        logger.info(
          { source, triggerId: trigger.id, blueprintId: blueprint.id },
          "Local event trigger skipped: repo belongs to another workspace",
        );
        continue;
      }
      const terminal = await spawnFromBlueprint(blueprint, {
        triggerId: trigger.id,
        spawnedBy: "trigger",
        params,
        ticket,
        repoUrlHint: repoUrl,
        title: title ? `${blueprint.name} · ${title}` : undefined,
      });
      await db
        .update(workflowTriggers)
        .set({ lastFiredAt: new Date() })
        .where(eq(workflowTriggers.id, trigger.id));
      results.push({
        triggerId: trigger.id,
        blueprintId: blueprint.id,
        terminalId: terminal.id,
        matched,
      });
      logger.info(
        {
          source,
          matched,
          triggerId: trigger.id,
          blueprintId: blueprint.id,
          terminalId: terminal.id,
        },
        "Local event trigger spawned terminal",
      );
    } catch (err) {
      logger.warn(
        { err, source, triggerId: trigger.id, blueprintId: trigger.targetId },
        "Local event trigger failed to spawn terminal",
      );
    }
  }
  return results;
}
