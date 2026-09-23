/**
 * Signature checks and raw-body capture for the inbound webhook receivers
 * (Slack Events + interactive actions, Linear). These routes are public —
 * the providers can't hold an Optio session — so the provider's HMAC over
 * the exact request bytes is their only authentication. See the
 * PUBLIC_WEBHOOK_RECEIVERS list in plugins/auth.ts.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

/** Slack: 5 minutes; Linear documents a 60 s window. */
const SLACK_MAX_SKEW_MS = 5 * 60 * 1000;
const LINEAR_MAX_SKEW_MS = 60 * 1000;

function hmacHex(secret: string, message: string | Buffer): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
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
