import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { CHAT_FORMAT_IDS, detectChatFormat } from "@optio/shared";
import { db } from "../../db/client.js";
import { notifyChatHooks, users } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { guardedFetch, SsrfError } from "../../utils/outbound-url.js";
import { readLimitedResponseText } from "../../utils/http-response.js";
import { ALG_AES_256_GCM_V1, decrypt, encrypt } from "../secret-service.js";
import {
  isChatHookFormat,
  renderChat,
  type ChatHookFormat,
  type ChatMessage,
} from "./chat-messages.js";

/**
 * A person's own chat hook (docs/notifications.md "Your own chat hook"): an
 * incoming webhook of any chat service (@optio/shared `CHAT_SERVICES`) into
 * their own channel or a direct message, set under Settings → Notifications.
 * It gets what they chose per event (`notification_preferences.channels.chat`).
 * One per person, across workspaces, like their email choices. Team channels
 * follow with teams.
 *
 * A hook's URL lets anyone who has it post to the channel, so it is sealed
 * like a secret (AES-256-GCM, AAD `notify_chat_hook|<id>`) and shown only as
 * a hint (`https://chat.example.com/hooks/…a1b2`). Posts go through the
 * outbound guard (`guardedFetch`: DNS answers vetted against the outbound
 * policy and `outbound.allowedHosts`, the connection pinned to a vetted
 * address), with no redirects. A disabled person's hook gets nothing: their
 * hooks are left out when a message is queued and checked again when it is
 * sent.
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

/** What Settings shows of a hook (never its URL). */
export interface ChatHookView {
  id: string;
  format: ChatHookFormat;
  urlHint: string;
  enabled: boolean;
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
    .where(eq(notifyChatHooks.ownerUserId, userId));
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
        // A new URL starts a fresh record: the old hook's results aren't this one's.
        ...(url
          ? {
              ...seal(existing.id, url),
              urlHint: urlHint(url),
              lastSentAt: null,
              lastError: null,
              lastErrorAt: null,
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
    .where(eq(notifyChatHooks.ownerUserId, userId))
    .returning({ id: notifyChatHooks.id });
  return gone.length > 0;
}

/** The enabled people's own hooks that are on, by person. */
export async function personalHooksOf(userIds: string[]): Promise<Map<string, ChatHookRow>> {
  if (!userIds.length) return new Map();
  const rows = await db
    .select({ hook: notifyChatHooks })
    .from(notifyChatHooks)
    .innerJoin(users, eq(users.id, notifyChatHooks.ownerUserId))
    .where(
      and(
        inArray(notifyChatHooks.ownerUserId, userIds),
        eq(notifyChatHooks.enabled, true),
        isNull(users.disabledAt),
      ),
    );
  return new Map(rows.map(({ hook }) => [hook.ownerUserId, hook]));
}

/** Whether any hook is on: worth looking further for an event. */
export async function anyChatHook(): Promise<boolean> {
  const [row] = await db
    .select({ id: notifyChatHooks.id })
    .from(notifyChatHooks)
    .where(eq(notifyChatHooks.enabled, true))
    .limit(1);
  return !!row;
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
  { ok: true; status: number } | { ok: false; error: string; status?: number; permanent: boolean };

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
    logger.warn({ hook: urlHint(target.url), err }, "notify: a chat post failed");
    return { ok: false, error: chatErrorMeaning(err), permanent: chatErrorIsPermanent(err) };
  }
}

/**
 * What a post that threw says to the person, in a few fixed words. The
 * exception's own text (an address, a TLS detail, how a connection failed)
 * goes to the log only: a hook may point at any host the outbound policy
 * allows, and its result is read back, so it must not tell a closed port
 * from a filtered one.
 */
export function chatErrorMeaning(err: unknown): string {
  if (err instanceof SsrfError) {
    return /could not be resolved/.test(err.message)
      ? "The hook's host name could not be resolved"
      : "The deployment's outbound policy does not allow this host";
  }
  return "Optio could not reach the hook";
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
    logger.warn({ hookId: row.id, error: result.error }, "notify: chat post not delivered");
  }
  return result;
}

/**
 * The hook a queued chat message goes to now: the person's own, while it is
 * on and the person is still enabled (they may have been offboarded since
 * it was queued).
 */
export async function hookForPerson(userId: string): Promise<ChatHookRow | null> {
  const [row] = await db
    .select({ hook: notifyChatHooks })
    .from(notifyChatHooks)
    .innerJoin(users, eq(users.id, notifyChatHooks.ownerUserId))
    .where(
      and(
        eq(notifyChatHooks.ownerUserId, userId),
        eq(notifyChatHooks.enabled, true),
        isNull(users.disabledAt),
      ),
    );
  return row?.hook ?? null;
}
