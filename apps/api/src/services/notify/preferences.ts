import { eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  notificationPreferences,
  type NotifyChannelPrefs,
  type NotifyDigestPrefs,
} from "../../db/schema.js";
import { DEFAULT_PREFERENCES } from "../notification-service.js";
import { emailByDefault, NOTIFY_KINDS } from "./kinds.js";
import type { RecipientReason } from "./templates.js";

/** Per-person email and chat-hook choices and the existing browser/phone push
 * preferences. Push remains in the original preferences JSON; email and chat
 * choices use channels. Chat (the person's own hook, chat-hooks.ts) has the
 * same defaults as email. The daily digest's choice (digest.ts) lives in
 * channels too.
 */

export interface ChannelChoices {
  email: Record<string, boolean>;
  chat: Record<string, boolean>;
  push: Record<string, boolean>;
  teamWork: boolean;
  digest: NotifyDigestPrefs;
}

export interface ChannelPatch {
  email?: Record<string, boolean>;
  chat?: Record<string, boolean>;
  push?: Record<string, boolean>;
  teamWork?: boolean;
  digest?: Partial<NotifyDigestPrefs>;
}

/** The digest until the person turns it on: 8 in the morning, UTC, by email. */
export const DEFAULT_DIGEST: NotifyDigestPrefs = {
  enabled: false,
  hour: 8,
  timeZone: "UTC",
  via: "email",
};

/** Whether `tz` is an IANA time zone this Node knows. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A stored digest choice with anything missing or wrong replaced by the default. */
export function digestOf(d: Partial<NotifyDigestPrefs> | null | undefined): NotifyDigestPrefs {
  const hour = Number(d?.hour);
  const tz = d?.timeZone;
  const via = d?.via;
  return {
    enabled: d?.enabled === true,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_DIGEST.hour,
    timeZone: isTimeZone(tz) ? tz : DEFAULT_DIGEST.timeZone,
    via: via === "chat" || via === "both" ? via : "email",
  };
}

type PushPrefs = Record<string, { push: boolean }>;

/** The stored row with every default filled in. */
export function mergeChoices(
  row: { preferences: PushPrefs; channels: NotifyChannelPrefs | null } | undefined,
): ChannelChoices {
  const email: Record<string, boolean> = {};
  const chat: Record<string, boolean> = {};
  const push: Record<string, boolean> = {};
  for (const k of NOTIFY_KINDS) {
    email[k.kind] = row?.channels?.email?.[k.kind] ?? k.email;
    chat[k.kind] = row?.channels?.chat?.[k.kind] ?? k.email;
    if (k.push) {
      const def = DEFAULT_PREFERENCES[k.kind as keyof typeof DEFAULT_PREFERENCES];
      push[k.kind] = row?.preferences?.[k.kind]?.push ?? def?.push ?? false;
    }
  }
  // Kinds someone chose for that aren't listed (any more) keep their choice.
  for (const [k, v] of Object.entries(row?.channels?.email ?? {})) {
    if (!(k in email)) email[k] = v;
  }
  for (const [k, v] of Object.entries(row?.channels?.chat ?? {})) {
    if (!(k in chat)) chat[k] = v;
  }
  return {
    email,
    chat,
    push,
    teamWork: row?.channels?.teamWork ?? true,
    digest: digestOf(row?.channels?.digest),
  };
}

/** The person's choices, defaults filled in. */
export async function getChannelChoices(userId: string): Promise<ChannelChoices> {
  const [row] = await db
    .select({
      preferences: notificationPreferences.preferences,
      channels: notificationPreferences.channels,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));
  return mergeChoices(
    row as { preferences: PushPrefs; channels: NotifyChannelPrefs | null } | undefined,
  );
}

/**
 * Change some choices and keep the rest: the push switches go into
 * upstream's `preferences` key by key (its other keys untouched), email, chat
 * and `teamWork` into `channels`. Saves at the same moment (Settings saves each
 * switch as it flips) don't lose each other: the person's row is made first
 * when missing (empty: upstream fills its defaults in on read), so the
 * SELECT … FOR UPDATE always has a row to hold while it merges.
 */
export async function updateChannelChoices(
  userId: string,
  patch: ChannelPatch,
): Promise<ChannelChoices> {
  await db.transaction(async (tx) => {
    await tx
      .insert(notificationPreferences)
      .values({ userId, preferences: {} })
      .onConflictDoNothing({ target: [notificationPreferences.userId] });
    const [row] = await tx
      .select({
        preferences: notificationPreferences.preferences,
        channels: notificationPreferences.channels,
      })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))
      .for("update");
    const preferences: PushPrefs = { ...((row?.preferences as PushPrefs | undefined) ?? {}) };
    for (const [kind, on] of Object.entries(patch.push ?? {})) {
      const def = DEFAULT_PREFERENCES[kind as keyof typeof DEFAULT_PREFERENCES];
      preferences[kind] = { ...(preferences[kind] ?? def ?? {}), push: on };
    }
    const channels: NotifyChannelPrefs = { ...(row?.channels ?? {}) };
    if (patch.email) channels.email = { ...(channels.email ?? {}), ...patch.email };
    if (patch.chat) channels.chat = { ...(channels.chat ?? {}), ...patch.chat };
    if (patch.teamWork !== undefined) channels.teamWork = patch.teamWork;
    if (patch.digest) channels.digest = digestOf({ ...digestOf(channels.digest), ...patch.digest });
    await tx
      .update(notificationPreferences)
      .set({ preferences, channels, updatedAt: new Date() })
      .where(eq(notificationPreferences.userId, userId));
  });
  return getChannelChoices(userId);
}

/** Whether `reason` lets this email through the person's choices. */
export function wantsEmail(
  choices: ChannelChoices,
  kind: string,
  reason: RecipientReason,
): boolean {
  if (reason.why === "team-admin" && !choices.teamWork) return false;
  return choices.email[kind] ?? emailByDefault(kind);
}

/** Whether `reason` lets this post to the person's own chat hook through their choices. */
export function wantsChat(choices: ChannelChoices, kind: string, reason: RecipientReason): boolean {
  if (reason.why === "team-admin" && !choices.teamWork) return false;
  return choices.chat[kind] ?? emailByDefault(kind);
}

/** Choices for many people at once (one query). */
export async function channelChoicesOf(userIds: string[]): Promise<Map<string, ChannelChoices>> {
  const out = new Map<string, ChannelChoices>();
  if (!userIds.length) return out;
  const rows = await db
    .select({
      userId: notificationPreferences.userId,
      preferences: notificationPreferences.preferences,
      channels: notificationPreferences.channels,
    })
    .from(notificationPreferences)
    .where(inArray(notificationPreferences.userId, userIds));
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  for (const id of userIds) {
    out.set(
      id,
      mergeChoices(
        byUser.get(id) as
          { preferences: PushPrefs; channels: NotifyChannelPrefs | null } | undefined,
      ),
    );
  }
  return out;
}
