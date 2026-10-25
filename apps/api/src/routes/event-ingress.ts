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
import { acceptTriggerEvent } from "../services/trigger-delivery.js";
import { logger } from "../logger.js";
import { claimInboundDelivery, type DeliverySource } from "../services/inbound-delivery-service.js";
import { gitlabWebhookSecret } from "../services/webhook-secret-service.js";
import { applyGitLabHookUpdates } from "../services/gitlab-hook-updates.js";
import { acceptGitLabMention } from "../services/gitlab-bot/ingress.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { receiverFor } from "../services/feature-guard.js";
import {
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
export type DeliveryProvider = DeliverySource;

const OkResponse = z.object({ ok: z.boolean(), duplicate: z.boolean().optional() });
const ChallengeResponse = z.object({ challenge: z.string() });

/**
 * Provider retries and replays inside the signature window must not fire an
 * automation twice, on any API instance: every receiver claims the
 * delivery's id in the database first (services/inbound-delivery-service.ts).
 */
export const claimDelivery = claimInboundDelivery;

export async function eventIngressRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const rateLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };
  // A receiver whose trigger the deployment leaves out (OPTIO_TRIGGERS) is
  // never registered, so a delivery to it answers 404 (config/features.ts).

  receiverFor(app, "slack").post("/api/webhooks/slack/events", {
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

      const event = normalizeSlackEvent(body);
      if (!event) return reply.status(200).send({ ok: true });

      const accepted = await acceptTriggerEvent("slack", event.eventId, event);
      return reply.status(200).send({ ok: true, ...accepted });
    },
  });

  receiverFor(app, "linear").post("/api/webhooks/linear", {
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

      const accepted = await acceptTriggerEvent("linear", deliveryKey, event);
      return reply.status(200).send({ ok: true, ...accepted });
    },
  });

  receiverFor(app, "pagerduty").post("/api/webhooks/pagerduty", {
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

      const event = normalizePagerDutyEvent(body);
      if (!event) return reply.status(200).send({ ok: true });

      const accepted = await acceptTriggerEvent("pagerduty", deliveryId, event);
      return reply.status(200).send({ ok: true, ...accepted });
    },
  });

  receiverFor(app, "gitlab").post("/api/webhooks/gitlab", {
    config: rateLimit,
    schema: {
      hide: true,
      operationId: "gitlabWebhookIngress",
      summary: "GitLab webhook receiver (GitLab event triggers)",
      description:
        "Point a GitLab project or group webhook here (push, merge request, issue, " +
        "comment, pipeline and release events) — or add the repo and Optio registers " +
        "the hook itself. Verified by the webhook's secret token in X-Gitlab-Token " +
        "against GITLAB_WEBHOOK_SECRET (the deployment's, else the one Optio generated " +
        "for the hooks it creates); X-Gitlab-Event-UUID is remembered so a retried " +
        "delivery fires once.",
      tags: ["Local"],
      security: [],
      response: { 200: OkResponse, 401: ErrorResponseSchema },
    },
    preParsing: captureRawBody,
    handler: async (req, reply) => {
      // The environment's secret, else the one Optio generated for the hooks
      // it creates (services/webhook-secret-service.ts)
      const secret = await gitlabWebhookSecret();
      if (!secret) {
        logger.error("GITLAB_WEBHOOK_SECRET is not set — rejecting GitLab webhook");
        return reply.status(401).send({ error: "GitLab webhook secret not configured" });
      }
      if (!verifyGitLabToken(req.headers["x-gitlab-token"] as string | undefined, secret)) {
        return reply.status(401).send({ error: "Invalid X-Gitlab-Token" });
      }

      const deliveryId = req.headers["x-gitlab-event-uuid"];
      // A comment mentioning Optio's GitLab bot, when it is on
      // (services/gitlab-bot/, docs/gitlab-bot.md; off by default).
      await acceptGitLabMention(req.body, typeof deliveryId === "string" ? deliveryId : undefined);

      // Optio's own work: a labeled issue syncs tickets, a merged MR completes
      // its task, other MR / pipeline / comment events wake the task.
      await applyGitLabHookUpdates(req.body).catch((err) =>
        logger.warn({ err }, "Applying a GitLab hook to Optio's work failed"),
      );

      const event = normalizeGitLabEvent(req.body);
      if (!event) return reply.status(200).send({ ok: true });

      const accepted = await acceptTriggerEvent(
        "gitlab",
        typeof deliveryId === "string" ? deliveryId : undefined,
        event,
      );
      return reply.status(200).send({ ok: true, ...accepted });
    },
  });

  receiverFor(app, "jira").post("/api/webhooks/jira", {
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

      const accepted = await acceptTriggerEvent("jira", deliveryKey, event);
      return reply.status(200).send({ ok: true, ...accepted });
    },
  });

  receiverFor(app, "sentry").post("/api/webhooks/sentry", {
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

      const accepted = await acceptTriggerEvent("sentry", `${event.eventId}:${stamp}`, event);
      return reply.status(200).send({ ok: true, ...accepted });
    },
  });
}
