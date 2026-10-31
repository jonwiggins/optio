/**
 * The ticket round trip's calls, one implementation per ticket service
 * (docs/ticket-round-trip.md): comments that keep their id and author, a
 * comment with links, one link per piece of work kept up to date, the
 * statuses to map steps to, a ticket's status now and where it can go, and
 * moving it there. apps/api/src/services/ticket-writeback.ts (what a ticket
 * hears), ticket-follow-ups.ts (comments that resume work) and
 * routes/ticket-round-trip.ts (settings, statuses, the Test button) call
 * them through `getTicketRoundTrip(source)` (index.ts).
 *
 * Implementations: github-round-trip.ts, gitlab-round-trip.ts,
 * jira-round-trip.ts, linear-round-trip.ts, notion-round-trip.ts. A failure
 * throws with a short reason (the service, the HTTP status, its message) —
 * never a token or a request body.
 */
import type { RoundTripSource, TicketProviderConfig } from "@optio/shared";
import { SsrfError, guardedFetch } from "@optio/shared/outbound-http";

/**
 * Who an account on the ticket service is. `accountId` is the stable id
 * (Jira Cloud's accountId, GitHub's and GitLab's numeric user id, Linear's and
 * Notion's user id); `key` is Jira Server's user key; `name` is what a
 * mention uses (Jira Server's user name, a GitHub login, a GitLab username).
 */
export interface TicketAccount {
  accountId?: string | null;
  key?: string | null;
  name?: string | null;
  displayName?: string | null;
  emailAddress?: string | null;
}

export interface TicketCommentRecord {
  id: string;
  author: TicketAccount;
  /** Plain text or the service's markup, as people wrote it. */
  body: string;
  /** When it was written, as the service sent it (ISO 8601, or Jira's `…+0000`). */
  created: string;
  /** Written by an app or integration rather than a person: never an instruction. */
  bot?: boolean;
  /**
   * False when the service says the author may not change the work's
   * repository or project (GitHub's author association below collaborator,
   * a Jira Service Management customer): their comment is never an
   * instruction. Absent: the service doesn't say here (`mayInstruct`).
   */
  trusted?: boolean;
}

/** A piece of a comment: text, or a link with its text. */
export type CommentPart = string | { text: string; href: string };

export interface TicketLink {
  /** One link per piece of work (`optio:<task id>`): updated, never added twice. */
  globalId: string;
  url: string;
  title: string;
  summary?: string;
  /** Done (a merged merge request): Jira strikes the link through. */
  resolved?: boolean;
  iconUrl?: string;
  relationship?: string;
  /** The id `upsertLink` returned last time for this work, when the service needs it to update. */
  previousId?: string | null;
}

export interface TicketStatusOption {
  name: string;
  /** Jira's status category, `State` / `Label`, Linear's state type, Notion's status group. */
  category?: string;
}

export interface TicketStatusList {
  statuses: TicketStatusOption[];
  /** Whose statuses these are. */
  scope: "project" | "group" | "server" | "repository" | "team" | "workspace" | "database";
}

export interface TicketIssueStatus {
  /** The ticket's status now (its state, for a service with labels). */
  status: string | null;
  /** Every status name it is in now (its state and its labels). */
  current: string[];
  /** The statuses it can move to from here. */
  available: string[];
}

export interface TicketMoveResult {
  moved: boolean;
  from: string | null;
  /** Why it didn't move: already there, or it can't get there from here. */
  reason?: "already" | "unreachable";
  /** The statuses it could move to now, when unreachable. */
  available?: string[];
}

export interface TicketRoundTrip {
  readonly source: RoundTripSource;
  /** Whether it keeps a link per piece of work and can move a ticket to a status. */
  readonly capabilities: { links: boolean; statuses: boolean };
  /** A ticket id typed into the Test field as the sync keys the service's tickets, or null. */
  normalizeTicketId(input: string): string | null;
  /** The account the provider's credentials belong to. */
  whoAmI(config: TicketProviderConfig): Promise<TicketAccount>;
  /** A ticket's latest comments (at most `max`), oldest first. */
  listComments(
    ticketId: string,
    config: TicketProviderConfig,
    max?: number,
  ): Promise<TicketCommentRecord[]>;
  /** Posts a comment; its id (Optio never reads its own comments as instructions). */
  postComment(
    ticketId: string,
    parts: CommentPart[],
    config: TicketProviderConfig,
  ): Promise<{ id: string | null }>;
  /** Adds the work's link or updates the one it left before; the id to pass next time. */
  upsertLink(
    ticketId: string,
    link: TicketLink,
    config: TicketProviderConfig,
  ): Promise<{ id: string | null }>;
  /** The statuses a step can be mapped to. */
  statuses(config: TicketProviderConfig): Promise<TicketStatusList>;
  /** Where a ticket is now and where it can go. */
  issueStatus(ticketId: string, config: TicketProviderConfig): Promise<TicketIssueStatus>;
  /**
   * Moves a ticket to `status` (case doesn't matter). `others` are the
   * statuses of the mapping's other steps: a service whose statuses are labels
   * takes those off. Already there, or it can't get there: nothing moves, and
   * the result says why — a retry would not help, so it is not an error.
   */
  moveToStatus(
    ticketId: string,
    status: string,
    config: TicketProviderConfig,
    opts?: { others?: string[] },
  ): Promise<TicketMoveResult>;
  /** Whether a comment mentions the provider's own account, in the service's syntax. */
  mentionsAccount(body: string, account: TicketAccount | null): boolean;
  /**
   * For a service whose comments don't say it (GitLab): whether the author
   * may change the ticket's project, so their comment may steer the work. A
   * service without it trusts the comments `listComments` didn't mark.
   */
  mayInstruct?(
    ticketId: string,
    author: TicketAccount,
    config: TicketProviderConfig,
  ): Promise<boolean>;
  /** A note another integration writes on tickets, which is never an instruction. */
  isIntegrationNote?(body: string): boolean;
}

/** How long one call may take: the round trip runs inside the ticket sync's sweep. */
export const ROUND_TRIP_CALL_TIMEOUT_MS = 20_000;

/** Whether two accounts are the same one: the stable id, else Jira Server's key, else the name. */
export function sameTicketAccount(
  a: TicketAccount | null | undefined,
  b: TicketAccount | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.accountId && b.accountId) return a.accountId === b.accountId;
  if (a.key && b.key) return a.key === b.key;
  if (a.name && b.name) return a.name.toLowerCase() === b.name.toLowerCase();
  return false;
}

/** A timestamp in ms (ISO 8601, or Jira's `…+0000`, which Date.parse doesn't take), or null. */
export function parseTicketTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Markdown's special characters in plain text, escaped. */
export function markdownText(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, "\\$1");
}

/** A URL inside `(…)`: parentheses and spaces percent-encoded. */
function markdownUrl(url: string): string {
  return url.replace(/[()\s]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : "%20"));
}

/** A comment as Markdown (GitHub, GitLab, Linear): text, and `[text](url)` links. */
export function markdownCommentBody(parts: CommentPart[]): string {
  return parts
    .map((p) =>
      typeof p === "string"
        ? markdownText(p)
        : `[${markdownText(p.text || p.href)}](${markdownUrl(p.href)})`,
    )
    .join("");
}

/** Whether `body` @-mentions `handle` (`@octocat`), not as part of an email address or a path. */
export function atMentions(body: string, handle: string | null | undefined): boolean {
  if (!handle) return false;
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@/.])@${escaped}(?![\\w-])`, "i").test(body);
}

/**
 * A comment the round trip leaves as the work's link (a service without
 * remote links: one comment, edited as the work goes). The hidden marker
 * names the work, for a person reading the source.
 */
export function linkCommentBody(link: TicketLink): string {
  const lines = [`**Optio**: [${markdownText(link.title)}](${markdownUrl(link.url)})`];
  if (link.summary) lines.push("", markdownText(link.summary));
  lines.push("", `<!-- ${link.globalId} -->`);
  return lines.join("\n");
}

/** An HTTP failure from a ticket service: its status and its short message. */
export class TicketServiceError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TicketServiceError";
  }
}

/** The short message an error body carries (`message`, `error`, `errors[0]`), if any. */
function serviceMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  const first = Array.isArray(b.errors) ? (b.errors[0] as unknown) : undefined;
  const pick =
    (typeof b.message === "string" && b.message) ||
    (typeof b.error === "string" && b.error) ||
    (typeof first === "string" && first) ||
    (first && typeof first === "object" && typeof (first as any).message === "string"
      ? (first as any).message
      : "") ||
    "";
  return String(pick).slice(0, 200);
}

/**
 * One JSON call to a ticket service, without following redirects, at most
 * ROUND_TRIP_CALL_TIMEOUT_MS. With `guard` (a host the provider names: a
 * self-managed GitLab) it goes through the outbound guard, which vets the
 * address and pins the connection to it; `fetch` replaces only the HTTP
 * client then (tests), never the vetting. A status outside 2xx throws a
 * TicketServiceError; the parsed body (null when empty) and the headers.
 */
export async function serviceCall<T = unknown>(
  service: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  opts: { guard?: boolean; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  let res: Response;
  const request = {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: "error" as const,
    signal: AbortSignal.timeout(ROUND_TRIP_CALL_TIMEOUT_MS),
  };
  try {
    res = opts.guard
      ? await guardedFetch(url, { ...request, ...(opts.fetch ? { fetchImpl: opts.fetch } : {}) })
      : await (opts.fetch ?? fetch)(url, request);
  } catch (err) {
    // The outbound guard said no: its reason names the host, never a credential.
    if (err instanceof SsrfError) throw err;
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error(`${service} didn't answer within ${ROUND_TRIP_CALL_TIMEOUT_MS / 1000} s`);
    }
    throw new Error(`${service} could not be reached${e?.cause?.code ? ` (${e.cause.code})` : ""}`);
  }
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const detail = serviceMessage(body);
    throw new TicketServiceError(
      service,
      res.status,
      `${service} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${detail ? `: ${detail}` : ""}`,
    );
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

/** Whether an error is the service saying the thing isn't there (404). */
export function isNotFound(err: unknown): boolean {
  return err instanceof TicketServiceError && err.status === 404;
}

/** Names that are the same, case aside. */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}
