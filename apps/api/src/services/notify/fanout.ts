import type { OutgoingEmail } from "./email.js";
import { deliver } from "./outbox.js";
import { channelChoicesOf, wantsEmail, type ChannelChoices } from "./preferences.js";
import type { Recipient } from "./recipients.js";

/**
 * One notification to the people it is for, over each person's channels:
 * email (when the relay is set and they have an address) and their own chat
 * hook (when they set one), each as they chose for the kind
 * (preferences.ts) — and to a team's channel. Shared by `notify()` and the
 * work events (dispatch.ts); the recipients come already filtered by the
 * visibility rule (recipients.ts). Every send goes through the outbox
 * (outbox.ts), so a relay or chat outage is retried, not lost.
 */

export interface Fanout {
  emailOn: boolean;
  /** The people's own hooks that are on. */
  /** Their choices; null = `force` (send whatever they chose). */
  choices: Map<string, ChannelChoices> | null;
}

export async function prepareFanout(
  userIds: string[],
  opts: { emailOn: boolean; force?: boolean },
): Promise<Fanout> {
  const choices = opts.force ? null : await channelChoicesOf(userIds);
  return { emailOn: opts.emailOn, choices };
}

export interface PersonOutcome {
  /** At least one channel took it. */
  reached: boolean;
  email: boolean;
  /** Why nothing went out: "turned off", no channel, or the failure. */
  why?: string;
}

/**
 * Why a person got nothing when no channel can carry it to them. Callers that
 * keep a notice due until it is delivered (credential-health/alerts.ts
 * `delivered`) tell the two apart:
 * - NO_ADDRESS: no usable email address and no chat hook. Nothing reaches
 *   them until they add one, as when such people weren't recipients at all.
 * - NO_RELAY: an address, but email isn't set up yet and no chat hook. Email
 *   reaches them once the relay is set.
 */
export const NO_ADDRESS = "No way to reach them: no email address and no chat hook";
export const NO_RELAY = "No way to reach them yet: email isn't set up and they have no chat hook";

/** Send one person their copy: `email()` and `chat()` render it only when it goes there. */
export async function reachPerson(
  r: Recipient,
  kind: string,
  fan: Fanout,
  render: { email: () => OutgoingEmail },
  workspaceId: string | null,
): Promise<PersonOutcome> {
  const c = fan.choices?.get(r.userId) ?? null;
  const force = fan.choices === null;
  const canEmail = fan.emailOn && !!r.email;
  if (!canEmail) {
    return { reached: false, email: false, why: r.email ? NO_RELAY : NO_ADDRESS };
  }
  const doEmail = canEmail && (force || !c || wantsEmail(c, kind, r.reason));
  if (!doEmail) {
    return { reached: false, email: false, why: "turned off" };
  }
  const errors: string[] = [];
  let email = false;
  if (doEmail) {
    const res = await deliver({
      channel: "email",
      kind,
      userId: r.userId,
      workspaceId,
      email: { ...render.email(), to: [r.email!] },
    });
    if (res.ok) email = true;
    else errors.push(res.error);
  }
  const reached = email;
  return { reached, email, ...(reached ? {} : { why: errors.join("; ") }) };
}
