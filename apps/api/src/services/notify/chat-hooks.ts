import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { CHAT_FORMAT_IDS, detectChatFormat } from "@optio/shared";
import { db } from "../../db/client.js";
import { notifyChatHooks } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { guardedFetch, SsrfError } from "../../utils/outbound-url.js";
import { readLimitedResponseText } from "../../utils/http-response.js";
import { ALG_AES_256_GCM_V1, decrypt, encrypt } from "../secret-service.js";
import { kindInfo, NOTIFY_KINDS } from "./kinds.js";
import {
  isChatHookFormat,
  renderChat,
  type ChatHookFormat,
  type ChatMessage,
} from "./chat-messages.js";

/**
 * Chat incoming webhooks Optio posts to, of any chat service
 * (@optio/shared `CHAT_SERVICES`; docs/notifications.md):
 *
 * - **A person's own hook** (Settings → Notifications → Your chat hook): a
 *   hook into their own channel or a direct message. It gets what they chose
 *   per event (`notification_preferences.channels.chat`), and the digest when
 *   they pick chat for it. One per person, across workspaces, like their
 *   email choices.
 * - **A team's channel** (Teams → the team → Team channel), set by the team's
 *   admins (or a workspace admin): the events of the team's own work, the
 *   kinds it lists in `events`. Never another team's or a person's work.
 *
 * A hook's URL lets anyone who has it post to the channel, so it is sealed
 * like a secret (AES-256-GCM, AAD `notify_chat_hook|<id>`) and shown only as
 * a hint (`https://chat.example.com/hooks/…a1b2`). Posts go through the
 * outbound guard (`guardedFetch`: the outbound policy, `outbound.allowedHosts`;
 * the site CA from the chart's caBundle), with no redirects.
 */

export type ChatHookRow = typeof notifyChatHooks.$inferSelect;

export class ChatHookError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ChatHookError";
  }
}

/** What Settings and the team page show of a hook (never its URL). */
export interface ChatHookView {
  id: string;
  format: ChatHookFormat;
  urlHint: string;
  enabled: boolean;
  /** A team channel's kinds. */
  events?: string[];
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  updatedAt: string;
}

export function hookView(row: ChatHookRow): ChatHookView {
  return {
    id: row.id,
    format: row.format,
    urlHint: row.urlHint,
    enabled: row.enabled,
    ...(row.ownerTeamId ? { events: teamChannelKinds(row) } : {}),
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── The URL ─────────────────────────────────────────────────────────────────

/** A hook URL as typed, checked: http(s), a host, no credentials, not too long. */
export function validateHookUrl(raw: string): string {
  const s = raw.trim();
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new ChatHookError(
      "The hook is a URL, like https://chat.example.com/hooks/abc123: the incoming webhook's address the chat gave you",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ChatHookError("The hook's URL starts with https:// (or http://)");
  }
  if (!url.hostname) throw new ChatHookError("The hook's URL has no host");
  if (url.username || url.password) {
    throw new ChatHookError("Leave the user name and password out of the hook's URL");
  }
  if (s.length > 2048) throw new ChatHookError("The hook's URL is too long");
  return url.toString();
}

/** `https://chat.example.com/hooks/…a1b2`: enough to recognise it, not to use it. */
export function urlHint(url: string): string {
  try {
    const u = new URL(url);
    const rest = `${u.pathname}${u.search}`;
    const tail = rest.replace(/[^A-Za-z0-9]/g, "").slice(-4);
    const first = u.pathname.split("/").filter(Boolean)[0];
    return `${u.protocol}//${u.host}${first ? `/${first}` : ""}/…${tail}`;
  } catch {
    return "…";
  }
}

const aad = (id: string) => Buffer.from(`notify_chat_hook|${id}`);

function seal(id: string, url: string) {
  const blob = encrypt(url, aad(id));
  return { encryptedUrl: blob.ciphertext, urlIv: blob.iv, urlAuthTag: blob.authTag };
}

/** The hook's URL (throws a readable error when the encryption key changed). */
export function hookUrlOf(row: ChatHookRow): string {
  return decrypt(
    {
      alg: ALG_AES_256_GCM_V1,
      iv: row.urlIv,
      ciphertext: row.encryptedUrl,
      authTag: row.urlAuthTag,
    },
    aad(row.id),
    "chat hook URL",
  );
}

// ── A person's own hook ─────────────────────────────────────────────────────

export interface SaveChatHook {
  /** Omitted or "" keeps the saved URL. */
  url?: string | null;
  /** Omitted: the format the URL can only be (`detectChatFormat`), else the saved one. */
  format?: ChatHookFormat | null;
  enabled?: boolean;
}

/**
 * The format to save: the one chosen; else the one the new URL can only be
 * (a Discord or Google Chat address…); else the saved one.
 */
export function chooseHookFormat(
  input: Pick<SaveChatHook, "format">,
  url: string | null,
  existing: Pick<ChatHookRow, "format"> | null,
): ChatHookFormat {
  if (input.format != null) {
    if (!isChatHookFormat(input.format)) {
      throw new ChatHookError(`The format is one of ${CHAT_FORMAT_IDS.join(", ")}`);
    }
    return input.format;
  }
  const format = detectChatFormat(url) ?? existing?.format ?? null;
  if (!format) {
    throw new ChatHookError("Choose the chat: Optio can't tell it from this URL");
  }
  return format;
}

export async function getPersonalHook(userId: string): Promise<ChatHookRow | null> {
  const [row] = await db
    .select()
    .from(notifyChatHooks)
    .where(and(eq(notifyChatHooks.ownerUserId, userId), isNull(notifyChatHooks.ownerTeamId)));
  return row ?? null;
}

export async function setPersonalHook(userId: string, input: SaveChatHook): Promise<ChatHookRow> {
  const url = input.url?.trim() ? validateHookUrl(input.url) : null;
  const existing = await getPersonalHook(userId);
  if (!existing && !url) throw new ChatHookError("Give the hook's URL");
  const format = chooseHookFormat(input, url, existing);
  const now = new Date();
  if (existing) {
    const [row] = await db
      .update(notifyChatHooks)
      .set({
        format,
        enabled: input.enabled ?? existing.enabled,
        ...(url ? { ...seal(existing.id, url), urlHint: urlHint(url), lastError: null } : {}),
        updatedAt: now,
      })
      .where(eq(notifyChatHooks.id, existing.id))
      .returning();
    return row;
  }
  const id = randomUUID();
  const [row] = await db
    .insert(notifyChatHooks)
    .values({
      id,
      ownerUserId: userId,
      format,
      ...seal(id, url!),
      urlHint: urlHint(url!),
      enabled: input.enabled ?? true,
    })
    .onConflictDoNothing()
    .returning();
  // Saved at the same moment from another tab: change that one instead.
  return row ?? setPersonalHook(userId, { ...input, format });
}

export async function deletePersonalHook(userId: string): Promise<boolean> {
  const gone = await db
    .delete(notifyChatHooks)
    .where(and(eq(notifyChatHooks.ownerUserId, userId), isNull(notifyChatHooks.ownerTeamId)))
    .returning({ id: notifyChatHooks.id });
  return gone.length > 0;
}

/** The people's own hooks that are on, by person. */
export async function personalHooksOf(userIds: string[]): Promise<Map<string, ChatHookRow>> {
  if (!userIds.length) return new Map();
  const rows = await db
    .select()
    .from(notifyChatHooks)
    .where(
      and(
        inArray(notifyChatHooks.ownerUserId, userIds),
        isNull(notifyChatHooks.ownerTeamId),
        eq(notifyChatHooks.enabled, true),
      ),
    );
  return new Map(rows.map((r) => [r.ownerUserId, r]));
}

/** Whether any hook (a person's or a team's) is on: worth looking further for an event. */
export async function anyChatHook(): Promise<boolean> {
  const [row] = await db
    .select({ id: notifyChatHooks.id })
    .from(notifyChatHooks)
    .where(eq(notifyChatHooks.enabled, true))
    .limit(1);
  return !!row;
}

// ── A team's channel ────────────────────────────────────────────────────────

/**
 * What a team's channel can post, and what it posts until its admins choose:
 * the events of the team's work, and the notices addressed to the team's
 * admins (its gateway budget, its tokens), off until chosen.
 */
export const TEAM_CHANNEL_KINDS: ReadonlyArray<{ kind: string; byDefault: boolean }> = [
  { kind: "task.pr_opened", byDefault: true },
  { kind: "task.needs_attention", byDefault: true },
  { kind: "task.failed", byDefault: true },
  { kind: "task.completed", byDefault: true },
  { kind: "budget.warning", byDefault: false },
  { kind: "budget.exceeded", byDefault: false },
  { kind: "token.expiring", byDefault: false },
  { kind: "token.invalid", byDefault: false },
];

export function isTeamChannelKind(kind: string): boolean {
  return TEAM_CHANNEL_KINDS.some((k) => k.kind === kind);
}

/** The kinds a team channel posts: its own list, else the defaults. */
export function teamChannelKinds(row: Pick<ChatHookRow, "events">): string[] {
  if (Array.isArray(row.events)) return row.events.filter(isTeamChannelKind);
  return TEAM_CHANNEL_KINDS.filter((k) => k.byDefault).map((k) => k.kind);
}

/** The team channel's choices as Settings lists them (label and description from kinds.ts). */
export function teamChannelKindViews() {
  return TEAM_CHANNEL_KINDS.map((k) => {
    const info = kindInfo(k.kind) ?? NOTIFY_KINDS[0];
    return {
      kind: k.kind,
      label: info.label,
      description: info.description,
      byDefault: k.byDefault,
    };
  });
}

export interface SaveTeamChannel extends SaveChatHook {
  events?: string[] | null;
}

export async function getTeamChannel(teamId: string): Promise<ChatHookRow | null> {
  const [row] = await db
    .select()
    .from(notifyChatHooks)
    .where(eq(notifyChatHooks.ownerTeamId, teamId));
  return row ?? null;
}

/** Set the team's channel; `setBy` is kept as the row's owner_user_id (team rows keep a person). */
export async function setTeamChannel(
  team: { id: string; workspaceId: string },
  setBy: string,
  input: SaveTeamChannel,
): Promise<ChatHookRow> {
  const events =
    input.events === undefined
      ? undefined
      : input.events === null
        ? null
        : [...new Set(input.events)].filter(isTeamChannelKind);
  const url = input.url?.trim() ? validateHookUrl(input.url) : null;
  const existing = await getTeamChannel(team.id);
  if (!existing && !url) throw new ChatHookError("Give the channel's webhook URL");
  const format = chooseHookFormat(input, url, existing);
  const now = new Date();
  if (existing) {
    const [row] = await db
      .update(notifyChatHooks)
      .set({
        format,
        enabled: input.enabled ?? existing.enabled,
        ...(events !== undefined ? { events } : {}),
        ...(url
          ? {
              ...seal(existing.id, url),
              urlHint: urlHint(url),
              lastError: null,
              ownerUserId: setBy,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(notifyChatHooks.id, existing.id))
      .returning();
    return row;
  }
  const id = randomUUID();
  const [row] = await db
    .insert(notifyChatHooks)
    .values({
      id,
      workspaceId: team.workspaceId,
      ownerUserId: setBy,
      ownerTeamId: team.id,
      format,
      ...seal(id, url!),
      urlHint: urlHint(url!),
      events: events ?? null,
      enabled: input.enabled ?? true,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? setTeamChannel(team, setBy, { ...input, format });
}

export async function deleteTeamChannel(teamId: string): Promise<boolean> {
  const gone = await db
    .delete(notifyChatHooks)
    .where(and(eq(notifyChatHooks.ownerTeamId, teamId), isNotNull(notifyChatHooks.ownerTeamId)))
    .returning({ id: notifyChatHooks.id });
  return gone.length > 0;
}

/** The team's channel when it is on and posts `kind`; null otherwise. */
export async function teamChannelFor(teamId: string, kind: string): Promise<ChatHookRow | null> {
  const row = await getTeamChannel(teamId);
  if (!row || !row.enabled) return null;
  return teamChannelKinds(row).includes(kind) ? row : null;
}

// ── Posting ─────────────────────────────────────────────────────────────────

export interface ChatTransport {
  post(url: string, body: Record<string, unknown>): Promise<{ status: number; text: string }>;
}

const POST_TIMEOUT_MS = 10_000;

/** The real one: a JSON POST through the outbound guard, no redirects. */
export const httpChatTransport: ChatTransport = {
  async post(url, body) {
    const res = await guardedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Optio-Notifications/1.0" },
      body: JSON.stringify(body),
      redirect: "error",
      timeoutMs: POST_TIMEOUT_MS,
    });
    const text = (await readLimitedResponseText(res, 2048)) ?? "";
    return { status: res.status, text };
  },
};

/** A transport that keeps what it was given (tests). */
export interface MemoryChatTransport extends ChatTransport {
  posts: Array<{ url: string; body: Record<string, unknown> }>;
  /** Answer the next posts with this status (or throw this message); null: 200 again. */
  failWith(answer: number | string | null): void;
}

export function createMemoryChatTransport(): MemoryChatTransport {
  let failure: number | string | null = null;
  const posts: MemoryChatTransport["posts"] = [];
  return {
    posts,
    failWith(answer) {
      failure = answer;
    },
    async post(url, body) {
      if (typeof failure === "string") throw new Error(failure);
      if (typeof failure === "number") return { status: failure, text: "refused (memory)" };
      posts.push({ url, body });
      return { status: 200, text: "ok" };
    },
  };
}

let override: ChatTransport | null = null;

/** Tests: route chat posts through `t` (null restores HTTP). */
export function setChatTransportForTests(t: ChatTransport | null): void {
  override = t;
}

export type ChatPostResult =
  | { ok: true; status: number }
  | { ok: false; error: string; status?: number; permanent: boolean };

/**
 * Whether an answer means the hook won't take the post however often it's
 * tried: a 4xx (the hook was deleted, the body refused) other than
 * "too many requests" and the timeouts.
 */
export function chatStatusIsPermanent(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

/** What a refusal's status says, in a few words; "" when it says nothing more. */
export function chatStatusMeaning(status: number): string {
  if (status === 400) return "it refused the post; check the URL and the format chosen for it";
  if (status === 401 || status === 403) return "it refused the hook; it may be turned off";
  if (status === 404 || status === 410)
    return "it has no such hook; it was deleted, or the URL is wrong";
  if (status === 413) return "the message was too large for it";
  if (status === 429) return "it asked Optio to slow down";
  if (status >= 500) return "it had a problem on its side";
  return "";
}

/**
 * Post `msg` to `url` in `format`. Never throws.
 *
 * A refusal is told by its status only: the text the far side answered goes
 * to the log, never into the result. Everyone signed in (viewers too) can
 * point their own hook at any host the outbound policy allows and read the
 * result back (the test route, the hook's last error), so a reply's body
 * must not reach them (docs/notifications.md "Your own chat hook").
 */
export async function postChat(
  target: { url: string; format: ChatHookFormat },
  msg: ChatMessage,
): Promise<ChatPostResult> {
  try {
    const res = await (override ?? httpChatTransport).post(
      target.url,
      renderChat(target.format, msg),
    );
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    // A hint only: a hook's URL is a secret (its path lets anyone post).
    logger.warn(
      { hook: urlHint(target.url), status: res.status, answer: res.text.slice(0, 200) },
      "notify: the chat refused a post",
    );
    const meaning = chatStatusMeaning(res.status);
    return {
      ok: false,
      status: res.status,
      error: `The chat answered HTTP ${res.status}${meaning ? `: ${meaning}` : ""}`,
      permanent: chatStatusIsPermanent(res.status),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, permanent: chatErrorIsPermanent(err) };
  }
}

/**
 * Whether a post that threw will fail however often it is tried: the
 * outbound policy refused the host (an admin's change, then a Retry, fixes
 * it). A name that doesn't resolve may resolve later, so it is retried.
 */
export function chatErrorIsPermanent(err: unknown): boolean {
  return err instanceof SsrfError && !/could not be resolved/.test(err.message);
}

/** Post to a stored hook and note the outcome on it (Settings shows the last error). */
export async function postToHook(row: ChatHookRow, msg: ChatMessage): Promise<ChatPostResult> {
  let url: string;
  try {
    url = hookUrlOf(row);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), permanent: true };
  }
  const result = await postChat({ url, format: row.format }, msg);
  const now = new Date();
  await db
    .update(notifyChatHooks)
    .set(
      result.ok
        ? { lastSentAt: now, lastError: null, lastErrorAt: null }
        : { lastError: result.error.slice(0, 500), lastErrorAt: now },
    )
    .where(eq(notifyChatHooks.id, row.id))
    .catch((err) => logger.debug({ err }, "notify: could not note a chat hook's outcome"));
  if (!result.ok) {
    logger.warn(
      { hookId: row.id, team: !!row.ownerTeamId, error: result.error },
      "notify: chat post not delivered",
    );
  }
  return result;
}

/** The hook a queued chat message goes to now: the person's own, or the team's channel. */
export async function hookForTarget(target: {
  userId?: string | null;
  teamId?: string | null;
}): Promise<ChatHookRow | null> {
  const row = target.teamId
    ? await getTeamChannel(target.teamId)
    : target.userId
      ? await getPersonalHook(target.userId)
      : null;
  return row && row.enabled ? row : null;
}
