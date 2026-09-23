import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { TaskState } from "@optio/shared";
import { isSsrfSafeUrl } from "../utils/ssrf.js";
import { handleSlackAction, sendSlackNotification } from "../services/slack-service.js";
import { logger } from "../logger.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { requireRole } from "../plugins/auth.js";
import { captureRawBody, rawBodyOf, verifySlackSignature } from "../utils/webhook-signature.js";

const slackTestBodySchema = z
  .object({
    webhookUrl: z
      .string()
      .url()
      .refine(isSsrfSafeUrl, {
        message: "URL must not target private or internal addresses",
      })
      .describe("Slack incoming webhook URL (SSRF-guarded)"),
    channel: z.string().optional().describe("Optional channel override"),
  })
  .describe("Body for triggering a Slack test notification");

const SlackTestResponseSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  error: z.string().optional(),
});

const SlackStatusResponseSchema = z
  .object({
    globalWebhookConfigured: z.boolean(),
  })
  .describe("Global Slack webhook configuration status");

const SlackActionResponseSchema = z
  .object({
    response_type: z.string(),
    replace_original: z.boolean().optional(),
    text: z.string(),
  })
  .describe("Slack-compatible interaction response");

export async function slackRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  // Public (no Optio session — Slack is the caller), so the Slack signing
  // secret is its only authentication: the buttons retry and cancel tasks.
  app.post(
    "/api/webhooks/slack/actions",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        hide: true,
        operationId: "slackWebhookActions",
        summary: "Slack interactive components receiver",
        description:
          "Inbound endpoint for Slack button clicks. Slack POSTs a form-encoded " +
          "body with a single `payload` field containing JSON. Verified with " +
          "SLACK_SIGNING_SECRET (X-Slack-Signature v0 over the raw body). Hidden " +
          "from the public spec since Slack is the only caller.",
        tags: ["Repos & Integrations"],
        security: [],
        response: {
          200: SlackActionResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
      },
      preParsing: captureRawBody,
    },
    async (req, reply) => {
      const secret = process.env.SLACK_SIGNING_SECRET;
      if (!secret) {
        logger.error("SLACK_SIGNING_SECRET is not set — rejecting Slack action");
        return reply.status(401).send({ error: "Slack signing secret not configured" });
      }
      const signed = verifySlackSignature(
        rawBodyOf(req),
        req.headers["x-slack-request-timestamp"] as string | undefined,
        req.headers["x-slack-signature"] as string | undefined,
        secret,
      );
      if (!signed) return reply.status(401).send({ error: "Invalid Slack signature" });

      try {
        // Slack can send three shapes here: raw JSON string, a form-encoded
        // object with a JSON `payload` field, or plain JSON. The body type
        // is intentionally unknown — this endpoint accepts whatever Slack
        // sends and discriminates at runtime. Not a place for a Zod schema.
        const body: unknown = req.body;
        let payload: { actions?: Array<{ action_id?: string; value?: string }> };

        if (typeof body === "string") {
          payload = JSON.parse(body);
        } else if (
          typeof body === "object" &&
          body !== null &&
          "payload" in body &&
          typeof (body as Record<string, unknown>).payload === "string"
        ) {
          payload = JSON.parse((body as Record<string, unknown>).payload as string);
        } else {
          payload = body as typeof payload;
        }

        if (!payload?.actions || !Array.isArray(payload.actions)) {
          return reply.status(400).send({ error: "No actions in payload" });
        }

        const action = payload.actions[0];
        if (!action?.action_id || !action?.value) {
          return reply.status(400).send({ error: "Invalid action format" });
        }

        const result = await handleSlackAction(action.action_id, action.value);

        reply.send({
          response_type: "ephemeral",
          replace_original: false,
          text: result.text,
        });
      } catch (err) {
        logger.error({ err }, "Failed to handle Slack action");
        reply.status(200).send({
          response_type: "ephemeral",
          text: ":x: An error occurred processing your action.",
        });
      }
    },
  );

  app.post(
    "/api/slack/test",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "testSlackWebhook",
        summary: "Send a test Slack notification",
        description:
          "Deliver a sample Slack notification to the given webhook URL so " +
          "operators can verify their configuration. URL is SSRF-guarded.",
        tags: ["Repos & Integrations"],
        body: slackTestBodySchema,
        response: {
          200: SlackTestResponseSchema,
          400: SlackTestResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { webhookUrl, channel } = req.body;

      const sampleTask = {
        id: "00000000-0000-0000-0000-000000000000",
        title: "Test notification from Optio",
        repoUrl: "https://github.com/example/test-repo",
        state: TaskState.COMPLETED,
        prUrl: "https://github.com/example/test-repo/pull/1",
        costUsd: "0.42",
      };

      try {
        await sendSlackNotification(webhookUrl, sampleTask, "completed", channel);
        reply.send({ ok: true, message: "Test notification sent" });
      } catch (err) {
        reply.status(400).send({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.get(
    "/api/slack/status",
    {
      schema: {
        operationId: "getSlackStatus",
        summary: "Get Slack integration status",
        description: "Check whether a global Slack webhook URL has been configured.",
        tags: ["Repos & Integrations"],
        response: { 200: SlackStatusResponseSchema },
      },
    },
    async (_req, reply) => {
      const { getGlobalSlackWebhookUrl } = await import("../services/slack-service.js");
      const globalConfigured = !!(await getGlobalSlackWebhookUrl());
      reply.send({ globalWebhookConfigured: globalConfigured });
    },
  );
}
