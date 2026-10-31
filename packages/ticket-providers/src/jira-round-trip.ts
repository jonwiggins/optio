/**
 * The Jira calls of the ticket round trip (docs/ticket-round-trip.md, the
 * Jira section): comments that keep their id and author, a comment with
 * links, a remote link that is updated rather than duplicated (`globalId`),
 * the statuses a project knows, the transitions an issue has now, and moving
 * it to a status by name. `jiraRoundTrip` puts them behind the
 * provider-neutral TicketRoundTrip (round-trip.ts).
 *
 * The same clients as the sync (jira.ts): Server / Data Center through REST
 * v2 with wiki-markup bodies, Cloud through REST v3 with ADF; the provider's
 * private CA (`caPem`) or NODE_EXTRA_CA_CERTS; the SSRF guard first. A
 * failure throws with `describeJiraError`'s reason, never a token or a body.
 */
import type { TicketProviderConfig } from "@optio/shared";
import {
  adfToPlaintext,
  asJiraConfig,
  cloudClient,
  describeJiraError,
  resolveJiraAuth,
  serverClient,
  type JiraDeployment,
  type JiraProviderConfig,
} from "./jira.js";
import {
  parseTicketTime,
  sameTicketAccount,
  type CommentPart,
  type TicketAccount,
  type TicketCommentRecord,
  type TicketLink,
  type TicketRoundTrip,
} from "./round-trip.js";

export type { CommentPart } from "./round-trip.js";

/** Who a Jira account is: Server names it by `name` / `key`, Cloud by `accountId`. */
export type JiraAccount = TicketAccount;

/** A Jira comment: plain text (Cloud's ADF flattened), `created` as Jira sent it (`…+0000`). */
export type JiraCommentRecord = TicketCommentRecord;

/** Jira updates the link with `globalId` instead of adding another (`optio:<task id>`). */
export type JiraRemoteLink = TicketLink;

export interface JiraStatus {
  name: string;
  category?: string;
}

export interface JiraIssueTransitions {
  /** The issue's status now. */
  status: string | null;
  transitions: Array<{ id: string; name: string; to: string }>;
}

export interface JiraMoveResult {
  moved: boolean;
  from: string | null;
  /** Why it didn't move: already there, or no transition leads there from here. */
  reason?: "already" | "unreachable";
  /** The statuses it could move to now, when unreachable. */
  available?: string[];
}

/**
 * How long one call may take. The round trip runs inside the ticket sync's
 * sweep; a Jira that never answers must not hold it (jira.js sets no timeout).
 */
export const JIRA_CALL_TIMEOUT_MS = 20_000;

/** Any thrown error as one readable line (describeJiraError); a call that hangs fails. */
async function jiraCall<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Jira didn't answer within ${JIRA_CALL_TIMEOUT_MS / 1000} s`)),
      JIRA_CALL_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([fn(), timeout]);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Jira didn't answer")) throw err;
    throw new Error(describeJiraError(err));
  } finally {
    clearTimeout(timer);
  }
}

/** The calls below, the same on both APIs (as jira.ts's JiraCommonClient). */
interface RoundTripClient {
  myself: { getCurrentUser(): Promise<unknown> };
  issueComments: {
    getComments(parameters: {
      issueIdOrKey: string;
      maxResults?: number;
      orderBy?: string;
    }): Promise<unknown>;
  };
  projects: { getAllStatuses(parameters: { projectIdOrKey: string }): Promise<unknown> };
  workflowStatuses: { getStatuses(): Promise<unknown> };
  issues: {
    getIssue(parameters: { issueIdOrKey: string; fields?: string[] }): Promise<unknown>;
    getTransitions(parameters: { issueIdOrKey: string }): Promise<unknown>;
    doTransition(parameters: {
      issueIdOrKey: string;
      transition: { id?: string };
    }): Promise<unknown>;
  };
}

async function ready(config: TicketProviderConfig): Promise<{
  c: JiraProviderConfig;
  deployment: JiraDeployment;
  client: RoundTripClient;
}> {
  const c = asJiraConfig(config);
  const deployment = resolveJiraAuth(c).deployment;
  const client: RoundTripClient = deployment === "server" ? serverClient(c) : cloudClient(c);
  return { c, deployment, client };
}

/** Wiki markup's special characters in plain text, escaped. */
function wikiText(text: string): string {
  return text.replace(/([[\]{}|])/g, "\\$1");
}

/** A link's text in wiki markup: no characters that end the link. */
function wikiLinkText(text: string): string {
  return text.replace(/[[\]|]/g, " ").trim() || "link";
}

/**
 * A comment's body: Server / Data Center take wiki markup (`[text|url]`),
 * Cloud an ADF document with link marks and hard breaks.
 */
export function jiraCommentBody(parts: CommentPart[], deployment: JiraDeployment): unknown {
  if (deployment === "server") {
    return parts
      .map((p) => (typeof p === "string" ? wikiText(p) : `[${wikiLinkText(p.text)}|${p.href}]`))
      .join("");
  }
  const content: unknown[] = [];
  for (const p of parts) {
    if (typeof p !== "string") {
      content.push({
        type: "text",
        text: p.text || p.href,
        marks: [{ type: "link", attrs: { href: p.href } }],
      });
      continue;
    }
    p.split("\n").forEach((line, i) => {
      if (i > 0) content.push({ type: "hardBreak" });
      if (line) content.push({ type: "text", text: line });
    });
  }
  return { type: "doc", version: 1, content: [{ type: "paragraph", content }] };
}

/** The account the provider's credentials belong to (`/myself`). */
export async function jiraWhoAmI(config: TicketProviderConfig): Promise<JiraAccount> {
  const { client } = await ready(config);
  const me = (await jiraCall(() => client.myself.getCurrentUser())) as JiraAccount;
  return {
    name: me.name ?? null,
    key: me.key ?? null,
    accountId: me.accountId ?? null,
    displayName: me.displayName ?? null,
    emailAddress: me.emailAddress ?? null,
  };
}

/** Whether two accounts are the same one: Cloud's accountId, else Server's key, else name. */
export const sameJiraAccount = sameTicketAccount;

/** An issue's latest comments (at most `maxResults`), oldest first, with ids and authors. */
export async function jiraListComments(
  issueKey: string,
  config: TicketProviderConfig,
  maxResults = 50,
): Promise<JiraCommentRecord[]> {
  const { client } = await ready(config);
  const res = (await jiraCall(() =>
    client.issueComments.getComments({ issueIdOrKey: issueKey, maxResults, orderBy: "-created" }),
  )) as { comments?: any[] };
  const rows = (res.comments ?? []).map((cm: any): JiraCommentRecord => ({
    id: String(cm.id ?? ""),
    author: {
      name: cm.author?.name ?? null,
      key: cm.author?.key ?? null,
      accountId: cm.author?.accountId ?? null,
      displayName: cm.author?.displayName ?? null,
      emailAddress: cm.author?.emailAddress ?? null,
    },
    body: typeof cm.body === "string" ? cm.body : adfToPlaintext(cm.body),
    created: String(cm.created ?? ""),
    // Jira Cloud's account types: an app's comment is no person's, and a
    // Service Management customer may comment on a request without being
    // one of the project's people. A Server sends no type.
    ...(cm.author?.accountType === "app" ? { bot: true } : {}),
    ...(cm.author?.accountType === "customer" ? { trusted: false } : {}),
  }));
  return rows.filter((r) => r.id).sort((a, b) => commentOrder(a) - commentOrder(b));
}

/** Jira's comment ids grow; the creation time breaks a tie for odd ids. */
function commentOrder(c: JiraCommentRecord): number {
  const n = Number(c.id);
  return Number.isFinite(n) ? n : (parseJiraTime(c.created) ?? 0);
}

/** A Jira timestamp (`…+0000`, which Date.parse doesn't take) in ms, or null. */
export const parseJiraTime = parseTicketTime;

/** Posts a comment; its id (for the loop guard: Optio never reads its own comments as instructions). */
export async function jiraPostComment(
  issueKey: string,
  parts: CommentPart[],
  config: TicketProviderConfig,
): Promise<{ id: string | null }> {
  const { c, deployment } = await ready(config);
  const body = jiraCommentBody(parts, deployment);
  const res = (await jiraCall(() =>
    deployment === "server"
      ? serverClient(c).issueComments.addComment({
          issueIdOrKey: issueKey,
          comment: body as string,
        })
      : cloudClient(c).issueComments.addComment({ issueIdOrKey: issueKey, comment: body as any }),
  )) as { id?: string | number } | undefined;
  return { id: res?.id != null ? String(res.id) : null };
}

/** Adds the remote link, or updates the one with the same globalId. */
export async function jiraUpsertRemoteLink(
  issueKey: string,
  link: JiraRemoteLink,
  config: TicketProviderConfig,
): Promise<void> {
  const { c, deployment } = await ready(config);
  const object: Record<string, unknown> = {
    url: link.url,
    title: link.title.slice(0, 255),
    ...(link.summary ? { summary: link.summary.slice(0, 255) } : {}),
    ...(link.iconUrl ? { icon: { url16x16: link.iconUrl, title: "Optio" } } : {}),
    status: { resolved: !!link.resolved },
  };
  const params = {
    issueIdOrKey: issueKey,
    globalId: link.globalId,
    application: { type: "io.optio", name: "Optio" },
    relationship: link.relationship ?? "Optio",
    object,
  };
  await jiraCall(() =>
    deployment === "server"
      ? serverClient(c).issueRemoteLinks.createOrUpdateRemoteIssueLink(params as any)
      : cloudClient(c).issueRemoteLinks.createOrUpdateRemoteIssueLink(params as any),
  );
}

/**
 * The statuses to pick from: the project's (every issue type's, once each)
 * when the provider names a project, else every status the server has.
 */
export async function jiraStatuses(config: TicketProviderConfig): Promise<JiraStatus[]> {
  const { c, client } = await ready(config);
  const seen = new Map<string, JiraStatus>();
  const add = (s: any) => {
    const name = typeof s?.name === "string" ? s.name.trim() : "";
    if (name && !seen.has(name.toLowerCase())) {
      seen.set(name.toLowerCase(), { name, category: s.statusCategory?.name ?? undefined });
    }
  };
  if (c.projectKey) {
    const types = (await jiraCall(() =>
      client.projects.getAllStatuses({ projectIdOrKey: c.projectKey as string }),
    )) as any[];
    for (const t of types ?? []) for (const s of t?.statuses ?? []) add(s);
  } else {
    const all = (await jiraCall(() => client.workflowStatuses.getStatuses())) as any[];
    for (const s of all ?? []) add(s);
  }
  return [...seen.values()];
}

/** The issue's status and the transitions it has from there. */
export async function jiraIssueTransitions(
  issueKey: string,
  config: TicketProviderConfig,
): Promise<JiraIssueTransitions> {
  const { client } = await ready(config);
  const issue = (await jiraCall(() =>
    client.issues.getIssue({ issueIdOrKey: issueKey, fields: ["status"] }),
  )) as { fields?: { status?: { name?: string } } };
  const res = (await jiraCall(() => client.issues.getTransitions({ issueIdOrKey: issueKey }))) as {
    transitions?: Array<{ id?: string; name?: string; to?: { name?: string } }>;
  };
  return {
    status: issue.fields?.status?.name ?? null,
    transitions: (res.transitions ?? [])
      .filter((t) => t.id && t.to?.name)
      .map((t) => ({ id: String(t.id), name: t.name ?? t.to!.name!, to: t.to!.name! })),
  };
}

/**
 * Moves the issue to the status named `statusName` (case doesn't matter)
 * through whichever transition leads there now. Already there, or no
 * transition leads there from its current status: nothing moves, and the
 * result says why — a retry would not help, so it is not an error.
 */
export async function jiraMoveToStatus(
  issueKey: string,
  statusName: string,
  config: TicketProviderConfig,
): Promise<JiraMoveResult> {
  const want = statusName.trim().toLowerCase();
  const { status, transitions } = await jiraIssueTransitions(issueKey, config);
  if (status && status.toLowerCase() === want)
    return { moved: false, from: status, reason: "already" };
  const t = transitions.find((x) => x.to.toLowerCase() === want);
  if (!t) {
    return {
      moved: false,
      from: status,
      reason: "unreachable",
      available: transitions.map((x) => x.to),
    };
  }
  const { client } = await ready(config);
  await jiraCall(() =>
    client.issues.doTransition({ issueIdOrKey: issueKey, transition: { id: t.id } }),
  );
  return { moved: true, from: status };
}

/** GitLab's Jira integration cross-references ("… mentioned this issue in a merge request …"). */
const INTEGRATION_NOTE =
  /mentioned this issue in (?:\[)?(?:a |an )?(?:commit|merge request|branch)/i;

/** A Jira issue key: the project key (a letter first), a dash, a number. */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** Jira's round trip: a remote link per piece of work, statuses through the workflow's transitions. */
export const jiraRoundTrip: TicketRoundTrip = {
  source: "jira",
  capabilities: { links: true, statuses: true },
  normalizeTicketId: (input) => {
    const key = input.trim();
    return ISSUE_KEY.test(key) ? key.toUpperCase() : null;
  },
  whoAmI: jiraWhoAmI,
  listComments: jiraListComments,
  postComment: jiraPostComment,
  upsertLink: async (issueKey, link, config) => {
    await jiraUpsertRemoteLink(issueKey, link, config);
    return { id: null };
  },
  statuses: async (config) => ({
    statuses: await jiraStatuses(config),
    scope: asJiraConfig(config).projectKey ? "project" : "server",
  }),
  issueStatus: async (issueKey, config) => {
    const { status, transitions } = await jiraIssueTransitions(issueKey, config);
    return { status, current: status ? [status] : [], available: transitions.map((t) => t.to) };
  },
  moveToStatus: (issueKey, status, config) => jiraMoveToStatus(issueKey, status, config),
  /** `[~name]` / `[~key]` on Server, `[~accountid:…]` on Cloud. */
  mentionsAccount: (body, account) => {
    const text = body.toLowerCase();
    const handles = [account?.name, account?.key].filter((h): h is string => !!h);
    if (handles.some((h) => text.includes(`[~${h.toLowerCase()}]`))) return true;
    return !!account?.accountId && body.includes(`[~accountid:${account.accountId}]`);
  },
  isIntegrationNote: (body) => INTEGRATION_NOTE.test(body),
};
