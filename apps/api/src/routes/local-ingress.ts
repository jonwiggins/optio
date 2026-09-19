/**
 * Signed ingress for Local automation event triggers: Slack Events API and
 * Linear webhooks. (GitHub deliveries arrive at the existing
 * `/api/webhooks/github` receiver in routes/tickets.ts, which also fans out
 * to local event triggers.)
 *
 * Both endpoints are public (no session), verified purely by the provider's
 * HMAC, and hidden from the OpenAPI spec. They ack fast and dispatch after
 * the reply — Slack retries anything slower than 3 s.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { logger } from "../logger.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import {
  fireLocalEventTriggers,
  normalizeLinearEvent,
  normalizeSlackEvent,
} from "../services/local-event-service.js";

const OkResponse = z.object({ ok: z.boolean() });
const ChallengeResponse = z.object({ challenge: z.string() });

/** Slack: 5 minutes; Linear documents a 60 s window. */
const SLACK_MAX_SKEW_MS = 5 * 60 * 1000;
const LINEAR_MAX_SKEW_MS = 60 * 1000;

/**
 * Remember recent delivery ids so provider retries and replays inside the
 * signature window don't fire an automation twice. In-process, like the
 * local relay itself (single API replica): a restart forgets, which at
 * worst re-fires a delivery retried across the restart.
 */
const RECENT_EVENT_IDS_MAX = 4000;
const recentDeliveryIds = new Set<string>();
export function rememberDelivery(provider: "slack" | "linear" | "github", id: string): boolean {
  const key = `${provider}:${id}`;
  if (recentDeliveryIds.has(key)) return false;
  recentDeliveryIds.add(key);
  if (recentDeliveryIds.size > RECENT_EVENT_IDS_MAX) {
    const first = recentDeliveryIds.values().next().value;
    if (first) recentDeliveryIds.delete(first);
  }
  return true;
}

/** Exported for tests. */
export function resetSlackEventDedupe(): void {
  recentDeliveryIds.clear();
}

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

/** Capture the raw bytes before JSON parsing so signatures verify byte-exact. */
async function captureRawBody(
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

function rawBodyOf(req: FastifyRequest): Buffer {
  return (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
}

export async function localIngressRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const rateLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

  app.post("/api/webhooks/slack/events", {
    config: rateLimit,
    schema: {
      hide: true,
      operationId: "slackEventsIngress",
      summary: "Slack Events API receiver for Local automations",
      description:
        "Point a Slack app's Event Subscriptions here (subscribe to " +
        "`message.channels` and/or `app_mention`). Verified with " +
        "SLACK_SIGNING_SECRET; answers url_verification challenges.",
      tags: ["Local"],
      security: [],
      response: {
        200: z.union([OkResponse, ChallengeResponse]),
        401: ErrorResponseSchema,
      },
    },
    preParsing: captureRawBody,
    handler: async (req, reply) => {
      const secret = process.env.SLACK_SIGNING_SECRET;
      if (!secret) {
        logger.error("SLACK_SIGNING_SECRET is not set — rejecting Slack event");
        return reply.status(401).send({ error: "Slack signing secret not configured" });
      }
      const ok = verifySlackSignature(
        rawBodyOf(req),
        req.headers["x-slack-request-timestamp"] as string | undefined,
        req.headers["x-slack-signature"] as string | undefined,
        secret,
      );
      if (!ok) return reply.status(401).send({ error: "Invalid Slack signature" });

      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.type === "url_verification" && typeof body.challenge === "string") {
        return reply.status(200).send({ challenge: body.challenge });
      }

      // Slack re-delivers on slow acks; we already handled the first copy.
      if (req.headers["x-slack-retry-num"]) return reply.status(200).send({ ok: true });

      const event = normalizeSlackEvent(body);
      if (!event) return reply.status(200).send({ ok: true });
      if (event.eventId && !rememberDelivery("slack", event.eventId)) {
        return reply.status(200).send({ ok: true });
      }

      await reply.status(200).send({ ok: true });
      fireLocalEventTriggers("slack", event).catch((err) => {
        logger.warn({ err, channelId: event.channelId }, "Slack event trigger dispatch failed");
      });
    },
  });

  app.post("/api/webhooks/linear", {
    config: rateLimit,
    schema: {
      hide: true,
      operationId: "linearWebhookIngress",
      summary: "Linear webhook receiver for Local automations",
      description:
        "Point a Linear webhook (Issues + Comments) here. Verified with " +
        "LINEAR_WEBHOOK_SECRET and the payload's webhookTimestamp.",
      tags: ["Local"],
      security: [],
      response: { 200: OkResponse, 401: ErrorResponseSchema },
    },
    preParsing: captureRawBody,
    handler: async (req, reply) => {
      const secret = process.env.LINEAR_WEBHOOK_SECRET;
      if (!secret) {
        logger.error("LINEAR_WEBHOOK_SECRET is not set — rejecting Linear webhook");
        return reply.status(401).send({ error: "Linear webhook secret not configured" });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ok = verifyLinearSignature(
        rawBodyOf(req),
        req.headers["linear-signature"] as string | undefined,
        secret,
        body.webhookTimestamp,
      );
      if (!ok) return reply.status(401).send({ error: "Invalid Linear signature" });

      const event = normalizeLinearEvent(body);
      if (!event) return reply.status(200).send({ ok: true });
      // Linear sends no delivery id; the entity + action + its own timestamp
      // identifies a delivery well enough to drop retries of it.
      const data = (body.data ?? {}) as Record<string, unknown>;
      const deliveryKey = `${body.type}:${body.action}:${data.id ?? ""}:${body.webhookTimestamp ?? ""}`;
      if (!rememberDelivery("linear", deliveryKey)) {
        return reply.status(200).send({ ok: true });
      }

      await reply.status(200).send({ ok: true });
      fireLocalEventTriggers("linear", event).catch((err) => {
        logger.warn({ err, identifier: event.identifier }, "Linear event trigger dispatch failed");
      });
    },
  });
}
