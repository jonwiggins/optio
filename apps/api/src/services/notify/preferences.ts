import { eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { notificationPreferences, type NotifyChannelPrefs } from "../../db/schema.js";
import { DEFAULT_PREFERENCES } from "../notification-service.js";
import { emailByDefault, NOTIFY_KINDS } from "./kinds.js";
import type { RecipientReason } from "./templates.js";

/** Per-person email choices and the existing browser/phone push preferences.
 * Push remains in the original preferences JSON; email choices use channels.
 */

export interface ChannelChoices {
  email: Record<string, boolean>;
  push: Record<string, boolean>;
  teamWork: boolean;
}

export interface ChannelPatch {
  email?: Record<string, boolean>;
  push?: Record<string, boolean>;
  teamWork?: boolean;
}

type PushPrefs = Record<string, { push: boolean }>;

/** The stored row with every default filled in. */
export function mergeChoices(
  row: { preferences: PushPrefs; channels: NotifyChannelPrefs | null } | undefined,
): ChannelChoices {
  const email: Record<string, boolean> = {};
  const push: Record<string, boolean> = {};
  for (const k of NOTIFY_KINDS) {
    email[k.kind] = row?.channels?.email?.[k.kind] ?? k.email;
    if (k.push) {
      const def = DEFAULT_PREFERENCES[k.kind as keyof typeof DEFAULT_PREFERENCES];
      push[k.kind] = row?.preferences?.[k.kind]?.push ?? def?.push ?? false;
    }
  }
  // Kinds someone chose for that aren't listed (any more) keep their choice.
  for (const [k, v] of Object.entries(row?.channels?.email ?? {})) {
    if (!(k in email)) email[k] = v;
  }
  return {
    email,
    push,
    teamWork: row?.channels?.teamWork ?? true,
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
 * upstream's `preferences` key by key (its other keys untouched), email and
 * `teamWork` into `channels`. Saves at the same moment (Settings saves each
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
    if (patch.teamWork !== undefined) channels.teamWork = patch.teamWork;
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
