/**
 * Signed ingress for Slack, Linear, PagerDuty, GitLab, Jira and Sentry event
 * triggers (Slack Events API, Linear webhooks, PagerDuty Webhooks v3, GitLab
 * project / group webhooks, Jira Cloud webhooks, Sentry integration
 * webhooks). GitHub deliveries arrive at the existing `/api/webhooks/github`
 * receiver in routes/tickets.ts, which fans out to GitHub event triggers the
 * same way; Pylon, Alertmanager and Datadog deliveries, which aren't signed,
 * go to `/api/hooks/<type>/:triggerId` in routes/hooks.ts.
 *
 * These endpoints are public (no session), verified purely by the provider's
 * HMAC (or, for GitLab, its shared token), and hidden from the OpenAPI spec.
 * They ack fast and dispatch after the reply — Slack retries anything slower
 * than 3 s.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { logger } from "../logger.js";
import { getRedisClient } from "../services/event-bus.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import {
  fireEventTriggers,
  normalizeGitLabEvent,
  normalizeJiraEvent,
  normalizeLinearEvent,
  normalizePagerDutyEvent,
  normalizeSentryEvent,
  normalizeSlackEvent,
} from "../services/event-trigger-service.js";
import {
  captureRawBody,
  rawBodyOf,
  verifyGitLabToken,
  verifyJiraSignature,
  verifyLinearSignature,
  verifyPagerDutySignature,
  verifySentrySignature,
  verifySlackSignature,
} from "../utils/webhook-signature.js";

export {
  verifyGitLabToken,
  verifyJiraSignature,
  verifyLinearSignature,
  verifyPagerDutySignature,
  verifySentrySignature,
  verifySlackSignature,
};

/** Providers whose delivery ids the receivers remember. */
export type DeliveryProvider =
  | "slack"
  | "linear"
  | "github"
  | "pagerduty"
  | "gitlab"
  | "jira"
  | "sentry";

const OkResponse = z.object({ ok: z.boolean(), duplicate: z.boolean().optional() });
const ChallengeResponse = z.object({ challenge: z.string() });

/**
 * Remember recent delivery ids so provider retries and replays inside the
 * signature window don't fire an automation twice. In-process, like the
 * local relay itself (single API replica): a restart forgets, which at
 * worst re-fires a delivery retried across the restart.
 */
const RECENT_EVENT_IDS_MAX = 4000;
const recentDeliveryIds = new Set<string>();
export function rememberDelivery(provider: DeliveryProvider, id: string): boolean {
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
export async function claimDelivery(provider: DeliveryProvider, id: string): Promise<boolean> {
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

  app.post("/api/webhooks/pagerduty", {
    config: rateLimit,
    schema: {
      hide: true,
      operationId: "pagerDutyWebhookIngress",
      summary: "PagerDuty Webhooks v3 receiver (PagerDuty event triggers)",
      description:
        "Point a PagerDuty generic webhook (v3) subscription here, with incident " +
        "event types. Verified with PAGERDUTY_WEBHOOK_SECRET against " +
        "X-PagerDuty-Signature; X-Webhook-Id is remembered so a retried " +
        "delivery fires once.",
      tags: ["Local"],
      security: [],
      response: { 200: OkResponse, 401: ErrorResponseSchema },
    },
    preParsing: captureRawBody,
    handler: async (req, reply) => {
      const secret = process.env.PAGERDUTY_WEBHOOK_SECRET;
      if (!secret) {
        logger.error("PAGERDUTY_WEBHOOK_SECRET is not set — rejecting PagerDuty webhook");
        return reply.status(401).send({ error: "PagerDuty webhook secret not configured" });
      }
      const ok = verifyPagerDutySignature(
        rawBodyOf(req),
        req.headers["x-pagerduty-signature"] as string | undefined,
        secret,
      );
      if (!ok) return reply.status(401).send({ error: "Invalid PagerDuty signature" });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const eventObj = (body.event ?? {}) as Record<string, unknown>;
      const deliveryId =
        (req.headers["x-webhook-id"] as string | undefined) ||
        (typeof eventObj.id === "string" ? eventObj.id : "");
      if (deliveryId && !(await claimDelivery("pagerduty", deliveryId))) {
        return reply.status(200).send({ ok: true, duplicate: true });
      }

      const event = normalizePagerDutyEvent(body);
      if (!event) return reply.status(200).send({ ok: true });

      await reply.status(200).send({ ok: true });
      fireEventTriggers("pagerduty", event).catch((err: unknown) => {
        logger.warn({ err, incidentId: event.id }, "PagerDuty event trigger dispatch failed");
      });
    },
  });

  app.post("/api/webhooks/gitlab", {
    config: rateLimit,
    schema: {
      hide: true,
      operationId: "gitlabWebhookIngress",
      summary: "GitLab webhook receiver (GitLab event triggers)",
      description:
        "Point a GitLab project or group webhook here (push, merge request, issue, " +
        "comment, pipeline and release events). Verified by the webhook's secret " +
        "token in X-Gitlab-Token against GITLAB_WEBHOOK_SECRET; X-Gitlab-Event-UUID " +
        "is remembered so a retried delivery fires once.",
      tags: ["Local"],
      security: [],
      response: { 200: OkResponse, 401: ErrorResponseSchema },
    },
    preParsing: captureRawBody,
    handler: async (req, reply) => {
      const secret = process.env.GITLAB_WEBHOOK_SECRET;
      if (!secret) {
        logger.error("GITLAB_WEBHOOK_SECRET is not set — rejecting GitLab webhook");
        return reply.status(401).send({ error: "GitLab webhook secret not configured" });
      }
      if (!verifyGitLabToken(req.headers["x-gitlab-token"] as string | undefined, secret)) {
        return reply.status(401).send({ error: "Invalid X-Gitlab-Token" });
      }

      const deliveryId = req.headers["x-gitlab-event-uuid"];
      if (typeof deliveryId === "string" && !(await claimDelivery("gitlab", deliveryId))) {
        return reply.status(200).send({ ok: true, duplicate: true });
      }

      const event = normalizeGitLabEvent(req.body);
      if (!event) return reply.status(200).send({ ok: true });

      await reply.status(200).send({ ok: true });
      fireEventTriggers("gitlab", event).catch((err: unknown) => {
        logger.warn({ err, project: event.project }, "GitLab event trigger dispatch failed");
      });
    },
  });

  app.post("/api/webhooks/jira", {
    config: rateLimit,
    schema: {
      hide: true,
      operationId: "jiraWebhookIngress",
      summary: "Jira webhook receiver (Jira event triggers)",
      description:
        "Point a Jira Cloud webhook here (issue created / updated, comment created) " +
        "with a secret. Verified with JIRA_WEBHOOK_SECRET against X-Hub-Signature " +
        "(sha256=). A comment arriving both as comment_created and as an issue " +
        "update fires once.",
      tags: ["Local"],
      security: [],
      response: { 200: OkResponse, 401: ErrorResponseSchema },
    },
    preParsing: captureRawBody,
    handler: async (req, reply) => {
      const secret = process.env.JIRA_WEBHOOK_SECRET;
      if (!secret) {
        logger.error("JIRA_WEBHOOK_SECRET is not set — rejecting Jira webhook");
        return reply.status(401).send({ error: "Jira webhook secret not configured" });
      }
      const ok = verifyJiraSignature(
        rawBodyOf(req),
        req.headers["x-hub-signature"] as string | undefined,
        secret,
      );
      if (!ok) return reply.status(401).send({ error: "Invalid Jira signature" });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const event = normalizeJiraEvent(body);
      if (!event) return reply.status(200).send({ ok: true });

      // Jira sends no delivery id. A comment is one delivery per webhook
      // subscription (comment_created, and issue_updated / issue_commented);
      // otherwise the event, the issue and Jira's own timestamp name it.
      const comment = (body.comment ?? {}) as Record<string, unknown>;
      const issue = (body.issue ?? {}) as Record<string, unknown>;
      const deliveryKey = event.kinds.includes("commented")
        ? `comment:${issue.id ?? event.key}:${comment.id ?? ""}`
        : `${event.event}:${issue.id ?? event.key}:${body.timestamp ?? ""}`;
      if (!(await claimDelivery("jira", deliveryKey))) {
        return reply.status(200).send({ ok: true, duplicate: true });
      }

      await reply.status(200).send({ ok: true });
      fireEventTriggers("jira", event).catch((err: unknown) => {
        logger.warn({ err, key: event.key }, "Jira event trigger dispatch failed");
      });
    },
  });

  app.post("/api/webhooks/sentry", {
    config: rateLimit,
    schema: {
      hide: true,
      operationId: "sentryWebhookIngress",
      summary: "Sentry webhook receiver (Sentry event triggers)",
      description:
        "Point a Sentry internal integration's webhook here, with the issue, " +
        "alert rule and metric alert webhooks enabled. Verified with " +
        "SENTRY_WEBHOOK_SECRET (the integration's client secret) against " +
        "Sentry-Hook-Signature; Sentry-Hook-Resource names the resource.",
      tags: ["Local"],
      security: [],
      response: { 200: OkResponse, 401: ErrorResponseSchema },
    },
    preParsing: captureRawBody,
    handler: async (req, reply) => {
      const secret = process.env.SENTRY_WEBHOOK_SECRET;
      if (!secret) {
        logger.error("SENTRY_WEBHOOK_SECRET is not set — rejecting Sentry webhook");
        return reply.status(401).send({ error: "Sentry webhook secret not configured" });
      }
      const ok = verifySentrySignature(
        rawBodyOf(req),
        req.headers["sentry-hook-signature"] as string | undefined,
        secret,
      );
      if (!ok) return reply.status(401).send({ error: "Invalid Sentry signature" });

      const resource = String(req.headers["sentry-hook-resource"] ?? "");
      const event = normalizeSentryEvent(resource, req.body);
      if (!event) return reply.status(200).send({ ok: true });

      // Sentry sends no delivery id; the resource, action, object and the
      // delivery's own timestamp name it.
      const stamp = String(req.headers["sentry-hook-timestamp"] ?? "");
      if (!(await claimDelivery("sentry", `${event.eventId}:${stamp}`))) {
        return reply.status(200).send({ ok: true, duplicate: true });
      }

      await reply.status(200).send({ ok: true });
      fireEventTriggers("sentry", event).catch((err: unknown) => {
        logger.warn({ err, issueId: event.issueId }, "Sentry event trigger dispatch failed");
      });
    },
  });
}
