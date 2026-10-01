/**
 * Signed ingress for Slack and Linear event triggers (Slack Events API and
 * Linear webhooks). GitHub deliveries arrive at the existing
 * `/api/webhooks/github` receiver in routes/tickets.ts, which fans out to
 * GitHub event triggers the same way.
 *
 * Both endpoints are public (no session), verified purely by the provider's
 * HMAC, and hidden from the OpenAPI spec. They ack fast and dispatch after
 * the reply — Slack retries anything slower than 3 s.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { logger } from "../logger.js";
import { getRedisClient } from "../services/event-bus.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import {
  fireEventTriggers,
  normalizeLinearEvent,
  normalizeSlackEvent,
} from "../services/event-trigger-service.js";
import {
  captureRawBody,
  rawBodyOf,
  verifyLinearSignature,
  verifySlackSignature,
} from "../utils/webhook-signature.js";

export { verifyLinearSignature, verifySlackSignature };

const OkResponse = z.object({ ok: z.boolean() });
const ChallengeResponse = z.object({ challenge: z.string() });

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

/** How long a claimed delivery id stays claimed in Redis. */
const DELIVERY_DEDUPE_TTL_SECS = 24 * 60 * 60;
/** Don't hold a webhook ack hostage to a slow / unreachable Redis. */
const DELIVERY_DEDUPE_REDIS_TIMEOUT_MS = 1000;

/**
 * Durable variant of {@link rememberDelivery}: also claims the id in Redis
 * (SET NX, 24 h TTL) so a replay is dropped across API restarts and replicas.
 * Returns true when this caller is the first to see the delivery. Fails open
 * (true) when Redis errors or is slow — the signature check still gates it.
 */
export async function claimDelivery(
  provider: "slack" | "linear" | "github",
  id: string,
): Promise<boolean> {
  if (!rememberDelivery(provider, id)) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      getRedisClient().set(
        `optio:webhook-delivery:${provider}:${id}`,
        "1",
        "EX",
        DELIVERY_DEDUPE_TTL_SECS,
        "NX",
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), DELIVERY_DEDUPE_REDIS_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (result === "timeout") {
      logger.warn({ provider }, "Webhook delivery dedupe timed out in Redis; accepting");
      return true;
    }
    return result === "OK";
  } catch (err) {
    logger.warn({ err, provider }, "Webhook delivery dedupe failed in Redis; accepting");
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/** Exported for tests. */
export function resetSlackEventDedupe(): void {
  recentDeliveryIds.clear();
}

export async function eventIngressRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const rateLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

  app.post("/api/webhooks/slack/events", {
    config: rateLimit,
    schema: {
      hide: true,
      operationId: "slackEventsIngress",
      summary: "Slack Events API receiver (Slack event triggers)",
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
      fireEventTriggers("slack", event).catch((err: unknown) => {
        logger.warn({ err, channelId: event.channelId }, "Slack event trigger dispatch failed");
      });
    },
  });

  app.post("/api/webhooks/linear", {
    config: rateLimit,
    schema: {
      hide: true,
      operationId: "linearWebhookIngress",
      summary: "Linear webhook receiver (Linear event triggers)",
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
      fireEventTriggers("linear", event).catch((err: unknown) => {
        logger.warn({ err, identifier: event.identifier }, "Linear event trigger dispatch failed");
      });
    },
  });
}
