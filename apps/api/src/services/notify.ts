import { logger } from "../logger.js";
import { anyChatHook } from "./notify/chat-hooks.js";
import { emailAvailable } from "./notify/email.js";
import { prepareFanout, reachPerson, reachTeamChannel } from "./notify/fanout.js";
import { kindInfo } from "./notify/kinds.js";
import {
  filterVisible,
  type Candidate,
  teamAdmins,
  type WorkOwnership,
} from "./notify/recipients.js";
import { renderNotice } from "./notify/templates.js";

/**
 * `notify()` — the one call for telling people something, by email and on
 * their own chat hook, for any part of Optio (budget warnings, a token about
 * to expire, an offboarding notice, …). docs/notifications.md "Sending a
 * notification".
 *
 *   await notify({
 *     kind: "budget.warning",              // list it in notify/kinds.ts so people can turn it off
 *     toTeamAdminsOf: team.id,             // and/or toUserIds: [userId]
 *     workspaceId: team.workspaceId,       // recipients must be members of it
 *     subject: "Platform used 80% of this month's budget",
 *     body: "The team has used 80 of its 100 USD for October.",
 *     link: "/usage",                      // a path under PUBLIC_URL, or a full URL
 *   });
 *
 * - Recipients: `toUserIds` plus the active admins of each team in
 *   `toTeamAdminsOf`, once each. With `workspaceId` only that workspace's
 *   members get it; with `work` (the owner columns of a piece of work) only
 *   people who may see that work (`canSeeWork`) — never pass work without it.
 * - Each person's choice for `kind` applies, per channel (Settings →
 *   Notifications); `force: true` skips it, for what someone must be told
 *   whatever they chose.
 * - A team in `toTeamAdminsOf` whose channel takes `kind` gets it there too
 *   (only its own work's, when `work` is given).
 * - Deliveries go through the outbox (notify/outbox.ts): retried while the
 *   relay or the chat is down. It never throws. Without a relay or any chat
 *   hook it sends nothing and says so in `error`.
 */

export interface NotifyInput {
  /** What this is about; a key of NOTIFY_KINDS (notify/kinds.ts) or a new one. */
  kind: string;
  toUserIds?: string[];
  /** Team ids whose admins get it. */
  toTeamAdminsOf?: string | string[];
  /** Only members of this workspace get it (taken from the team when absent). */
  workspaceId?: string | null;
  /** The work it's about: only people who may see it get it. */
  work?: WorkOwnership | null;
  subject: string;
  /** Plain text; Optio adds the link and a footer. */
  body: string;
  link?: string | null;
  /** Ignore the person's email choice for this kind. */
  force?: boolean;
}

export interface NotifyResult {
  /** User ids it went to (queued for delivery), by email, chat or both. */
  sent: string[];
  skipped: Array<{ userId: string; why: string }>;
  /** Of `sent`, those whose own chat hook got it (absent when none). */
  chat?: string[];
  /** Teams whose channel got it (absent when none). */
  teamChannels?: string[];
  /** Why nothing could go out at all (no relay, no recipients). */
  error?: string;
}

export async function notify(input: NotifyInput): Promise<NotifyResult> {
  try {
    return await deliver(input);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ kind: input.kind, error }, "notify: not sent");
    return { sent: [], skipped: [], error };
  }
}

async function deliver(input: NotifyInput): Promise<NotifyResult> {
  const emailOn = await emailAvailable();
  const chatOn = await anyChatHook().catch(() => false);
  if (!emailOn && !chatOn) {
    return { sent: [], skipped: [], error: "Email isn't set up on this Optio" };
  }
  const candidates: Candidate[] = [];
  const teamsTold: string[] = [];
  for (const userId of input.toUserIds ?? [])
    candidates.push({ userId, reason: { why: "addressed" } });
  let workspaceId = input.workspaceId ?? input.work?.workspaceId ?? null;
  const teamIds = [input.toTeamAdminsOf ?? []].flat().filter(Boolean);
  for (const teamId of teamIds) {
    const admins = await teamAdmins(teamId);
    workspaceId ??= admins.workspaceId;
    // A team of another workspace than the one named gets nothing.
    if (admins.workspaceId && workspaceId && admins.workspaceId !== workspaceId) continue;
    teamsTold.push(teamId);
    for (const userId of admins.userIds) {
      candidates.push({ userId, reason: { why: "team", teamName: admins.teamName } });
    }
  }
  const recipients = await filterVisible(candidates, { workspaceId, work: input.work ?? null });
  const message = {
    type: "notice" as const,
    subject: input.subject,
    body: input.body,
    link: input.link ?? null,
  };

  // The teams' own channels: a notice to the team (its budget, its token),
  // or the team's own work — never another's.
  const teamChannels: string[] = [];
  if (chatOn) {
    for (const teamId of teamsTold) {
      if (input.work && input.work.ownerTeamId !== teamId) continue;
      if (await reachTeamChannel(teamId, input.kind, message, workspaceId)) {
        teamChannels.push(teamId);
      }
    }
  }
  const told = teamChannels.length ? { teamChannels } : {};
  if (!recipients.length) return { sent: [], skipped: [], error: "No one to send it to", ...told };

  const fan = await prepareFanout(
    recipients.map((r) => r.userId),
    { emailOn, chatOn, force: input.force },
  );
  const result: NotifyResult = { sent: [], skipped: [] };
  const chat: string[] = [];
  for (const r of recipients) {
    const outcome = await reachPerson(
      r,
      input.kind,
      fan,
      {
        email: () => {
          const email = renderNotice(input, r.reason);
          return {
            to: [],
            subject: email.subject,
            text: email.text,
            headers: { "X-Optio-Event": input.kind },
          };
        },
        chat: () => message,
      },
      workspaceId,
    );
    if (outcome.reached) {
      result.sent.push(r.userId);
      if (outcome.chat) chat.push(r.userId);
    } else {
      result.skipped.push({ userId: r.userId, why: outcome.why ?? "not sent" });
    }
  }
  return { ...result, ...(chat.length ? { chat } : {}), ...told };
}

/** Whether anything can go out at all: a relay for email, or any chat hook. */
export async function canNotify(): Promise<boolean> {
  if (await emailAvailable()) return true;
  return anyChatHook().catch(() => false);
}

/** Whether `kind` is one people can turn off (listed in notify/kinds.ts). */
export function isListedKind(kind: string): boolean {
  return !!kindInfo(kind);
}

export { NOTIFY_KINDS, type NotifyKind } from "./notify/kinds.js";
export { NO_ADDRESS, NO_RELAY } from "./notify/fanout.js";
export type { WorkOwnership } from "./notify/recipients.js";
