import { logger } from "../logger.js";
import { emailAvailable } from "./notify/email.js";
import { prepareFanout, reachPerson } from "./notify/fanout.js";
import { kindInfo } from "./notify/kinds.js";
import { filterVisible, type Candidate, type WorkOwnership } from "./notify/recipients.js";
import { renderNotice } from "./notify/templates.js";

/** Email notices to addressed, enabled people who may see the work, via the retry outbox. */
export interface NotifyInput {
  /** What this is about; a key of NOTIFY_KINDS (notify/kinds.ts) or a new one. */
  kind: string;
  toUserIds?: string[];
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
  if (!emailOn) {
    return { sent: [], skipped: [], error: "Email isn't set up on this Optio" };
  }
  const candidates: Candidate[] = [];
  for (const userId of input.toUserIds ?? [])
    candidates.push({ userId, reason: { why: "addressed" } });
  const workspaceId = input.workspaceId ?? input.work?.workspaceId ?? null;
  const recipients = await filterVisible(candidates, { workspaceId, work: input.work ?? null });

  if (!recipients.length) return { sent: [], skipped: [], error: "No one to send it to" };

  const fan = await prepareFanout(
    recipients.map((r) => r.userId),
    { emailOn, force: input.force },
  );
  const result: NotifyResult = { sent: [], skipped: [] };
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
      },
      workspaceId,
    );
    if (outcome.reached) {
      result.sent.push(r.userId);
    } else {
      result.skipped.push({ userId: r.userId, why: outcome.why ?? "not sent" });
    }
  }
  return result;
}

/** Whether anything can go out at all: a relay for email, or any chat hook. */
export async function canNotify(): Promise<boolean> {
  if (await emailAvailable()) return true;
  return false;
}

/** Whether `kind` is one people can turn off (listed in notify/kinds.ts). */
export function isListedKind(kind: string): boolean {
  return !!kindInfo(kind);
}

export { NOTIFY_KINDS, type NotifyKind } from "./notify/kinds.js";
export { NO_ADDRESS, NO_RELAY } from "./notify/fanout.js";
export type { WorkOwnership } from "./notify/recipients.js";
