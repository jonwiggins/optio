import { logger } from "../../logger.js";
import { buildMessage, isEmailAddress } from "./mime.js";
import { smtpSend, type SmtpResult } from "./smtp.js";
import { smtpConfig, type SmtpConfig } from "./smtp-config.js";

/**
 * Sending one email through the deployment's relay (smtp-config.ts says which).
 * The transport is swappable so tests never open a socket:
 * `setEmailTransportForTests(createMemoryEmailTransport())`.
 */

export interface OutgoingEmail {
  to: string[];
  subject: string;
  text: string;
  /** Extra headers, e.g. `X-Optio-Event`. */
  headers?: Record<string, string>;
}

export interface EmailTransport {
  send(config: SmtpConfig, email: OutgoingEmail): Promise<SmtpResult>;
}

/** The real one: MIME text over SMTP. */
export const smtpTransport: EmailTransport = {
  async send(config, email) {
    const data = buildMessage({
      from: config.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      headers: email.headers,
    });
    return smtpSend(config, { from: config.from.address, to: email.to, data });
  },
};

/** A transport that keeps what it was given (tests, and the dev loop). */
export interface MemoryEmailTransport extends EmailTransport {
  sent: Array<OutgoingEmail & { from: string }>;
  /** Make the next sends fail with this message (null: succeed again). */
  failWith(message: string | null): void;
}

export function createMemoryEmailTransport(): MemoryEmailTransport {
  let failure: string | null = null;
  const sent: MemoryEmailTransport["sent"] = [];
  return {
    sent,
    failWith(message) {
      failure = message;
    },
    async send(config, email) {
      if (failure) throw new Error(failure);
      sent.push({ ...email, from: config.from.address });
      return { accepted: [...email.to], rejected: [], response: "250 queued (memory)" };
    },
  };
}

let override: EmailTransport | null = null;

/** Tests: route email through `t` (null restores SMTP). */
export function setEmailTransportForTests(t: EmailTransport | null): void {
  override = t;
}

export type SendEmailResult =
  | { ok: true; accepted: string[]; rejected: SmtpResult["rejected"]; response: string }
  | { ok: false; error: string };

/**
 * Send `email` through the relay in effect (or `opts.config`, for the
 * Settings test). Never throws: a relay that refuses or can't be reached
 * comes back as `{ ok: false, error }`, logged without the message body.
 */
export async function sendEmail(
  email: OutgoingEmail,
  opts: { config?: SmtpConfig | null } = {},
): Promise<SendEmailResult> {
  const to = email.to.filter(isEmailAddress);
  if (!to.length) return { ok: false, error: "No valid recipient address" };
  let config: SmtpConfig | null;
  try {
    config = opts.config !== undefined ? opts.config : await smtpConfig();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!config || !config.enabled) return { ok: false, error: "Email isn't set up on this Optio" };
  try {
    const r = await (override ?? smtpTransport).send(config, { ...email, to });
    return { ok: true, accepted: r.accepted, rejected: r.rejected, response: r.response };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ to: to.length, host: config.host, error }, "notify: email not sent");
    return { ok: false, error };
  }
}

/** Whether email can go out at all (cheap enough to ask before each event). */
export async function emailAvailable(): Promise<boolean> {
  try {
    const c = await smtpConfig();
    return !!c && c.enabled;
  } catch {
    return false;
  }
}
