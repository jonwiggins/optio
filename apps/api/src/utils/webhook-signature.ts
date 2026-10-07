/**
 * Signature checks and raw-body capture for the inbound webhook receivers
 * (Slack Events + interactive actions, Linear, PagerDuty, Jira, Sentry,
 * GitLab's shared token) and the shared secret check for self-secret
 * deliveries (Pylon, Alertmanager, Datadog). These routes are public — the
 * providers can't hold an Optio session — so the provider's HMAC over the
 * exact request bytes (or the trigger's own secret in a header) is their
 * only authentication. See the PUBLIC_WEBHOOK_RECEIVERS list in
 * plugins/auth.ts.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

/** Slack: 5 minutes; Linear documents a 60 s window. */
const SLACK_MAX_SKEW_MS = 5 * 60 * 1000;
const LINEAR_MAX_SKEW_MS = 60 * 1000;

export function hmacHex(secret: string, message: string | Buffer): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Slack request signing: `v0=` + HMAC-SHA256(`v0:${ts}:${rawBody}`). */
export function verifySlackSignature(
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!timestamp || !signature || !signature.startsWith("v0=")) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts * 1000) > SLACK_MAX_SKEW_MS) return false;
  const expected = hmacHex(secret, Buffer.concat([Buffer.from(`v0:${timestamp}:`), rawBody]));
  return safeEqualHex(expected, signature.slice(3));
}

/** Linear: `Linear-Signature` = hex HMAC-SHA256 of the raw body; `webhookTimestamp` in the body. */
export function verifyLinearSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
  webhookTimestamp: unknown,
  now = Date.now(),
): boolean {
  if (!signature) return false;
  const ts = Number(webhookTimestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > LINEAR_MAX_SKEW_MS) return false;
  return safeEqualHex(hmacHex(secret, rawBody), signature);
}

/**
 * PagerDuty Webhooks v3: `X-PagerDuty-Signature` holds one or more
 * comma-separated `v1=<hex HMAC-SHA256 of the raw body>` entries (several
 * while a secret is being rotated); the delivery is genuine when any matches.
 */
export function verifyPagerDutySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const expected = hmacHex(secret, rawBody);
  return header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="))
    .some((s) => safeEqualHex(expected, s.slice(3)));
}

/**
 * A shared secret presented as-is (Pylon, Alertmanager and Datadog can only
 * add request headers, so their deliveries carry the trigger's secret
 * rather than a signature; GitLab sends its webhook's secret token the same
 * way). Compared by digest so the comparison is constant-time whatever the
 * lengths.
 */
export function verifySharedSecret(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** GitLab: the webhook's secret token, sent as-is in `X-Gitlab-Token`. */
export function verifyGitLabToken(header: string | undefined, secret: string): boolean {
  return verifySharedSecret(header, secret);
}

/**
 * Jira Cloud: `X-Hub-Signature` = `sha256=<hex HMAC-SHA256 of the raw body>`
 * with the webhook's secret (the GitHub-style header, without a timestamp).
 */
export function verifyJiraSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const m = /^sha256=([0-9a-f]+)$/i.exec(header.trim());
  if (!m) return false;
  return safeEqualHex(hmacHex(secret, rawBody), m[1].toLowerCase());
}

/**
 * Sentry (integration webhooks): `Sentry-Hook-Signature` = hex HMAC-SHA256
 * of the raw body with the integration's client secret.
 */
export function verifySentrySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  return safeEqualHex(hmacHex(secret, rawBody), header.trim().toLowerCase());
}

/**
 * The shared secret a self-secret delivery presents: `X-Optio-Secret`, a
 * `Bearer` token, or the password of HTTP basic auth (Alertmanager's
 * `basic_auth`, Grafana's contact point) — any user name.
 */
export function presentedSecret(headers: Record<string, unknown>): string | undefined {
  const direct = headers["x-optio-secret"];
  if (typeof direct === "string" && direct) return direct;
  const auth = headers.authorization;
  if (typeof auth !== "string") return undefined;
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (bearer) return bearer[1].trim();
  const basic = /^Basic\s+(.+)$/i.exec(auth.trim());
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1].trim(), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      const password = colon >= 0 ? decoded.slice(colon + 1) : decoded;
      return password || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * `preParsing` hook: keep the raw bytes before the JSON / form parser runs,
 * so signatures verify byte-exact. Read them back with `rawBodyOf`.
 */
export async function captureRawBody(
  req: FastifyRequest,
  _reply: FastifyReply,
  payload: Readable,
): Promise<Readable> {
  const chunks: Buffer[] = [];
  for await (const chunk of payload) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  const rawBody = Buffer.concat(chunks);
  (req as unknown as { rawBody: Buffer }).rawBody = rawBody;
  return Readable.from(rawBody);
}

export function rawBodyOf(req: FastifyRequest): Buffer {
  return (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
}
