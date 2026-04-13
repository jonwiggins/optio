import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { isSsrfSafeUrl } from "../utils/ssrf.js";
import * as webhookService from "../services/webhook-service.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { WebhookSchema, WebhookDeliverySchema } from "../schemas/integration.js";

const limitQuerySchema = z.object({
  limit: z.string().optional().describe("Max deliveries to return (stringified int)"),
});

const webhookEventEnum = z
  .enum([
    "task.completed",
    "task.failed",
    "task.needs_attention",
    "task.pr_opened",
    "review.completed",
    "workflow_run.queued",
    "workflow_run.started",
    "workflow_run.completed",
    "workflow_run.failed",
  ])
  .describe("Event type the webhook subscribes to");

const createWebhookSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine(isSsrfSafeUrl, {
        message: "URL must not target private or internal addresses",
      })
      .describe("Webhook delivery URL (SSRF-guarded)"),
    events: z.array(webhookEventEnum).min(1).describe("Event types to subscribe to"),
    secret: z
      .string()
      .min(1)
      .optional()
      .describe("Optional shared secret used to HMAC-sign deliveries"),
    description: z.string().optional(),
  })
  .describe("Body for registering a new outbound webhook");

const updateWebhookSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine(isSsrfSafeUrl, {
        message: "URL must not target private or internal addresses",
      })
      .optional(),
    events: z.array(webhookEventEnum).min(1).optional(),
    secret: z.string().min(1).nullable().optional(),
    description: z.string().nullable().optional(),
    active: z.boolean().optional(),
  })
  .describe("Partial update to a webhook");

const testWebhookBodySchema = z
  .object({ event: webhookEventEnum.optional() })
  .optional()
  .default({})
  .describe("Body for firing a test delivery");

const WebhookListResponseSchema = z.object({ webhooks: z.array(WebhookSchema) });
const WebhookResponseSchema = z.object({ webhook: WebhookSchema });
const DeliveryListResponseSchema = z.object({ deliveries: z.array(WebhookDeliverySchema) });
const DeliveryResponseSchema = z.object({ delivery: WebhookDeliverySchema });

export async function webhookRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/webhooks",
    {
      schema: {
        operationId: "listWebhooks",
        summary: "List outbound webhooks",
        description:
          "Return all webhooks configured in the current workspace. Secret " +
          "values are masked in the response.",
        tags: ["Repos & Integrations"],
        response: { 200: WebhookListResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const hooks = await webhookService.listWebhooks(workspaceId);
      const masked = hooks.map((h) => ({
        ...h,
        secret: h.secret ? "••••••" : null,
      }));
      reply.send({ webhooks: masked });
    },
  );

  app.get(
    "/api/webhooks/:id",
    {
      schema: {
        operationId: "getWebhook",
        summary: "Get a webhook",
        description: "Fetch a single webhook by ID. Secret is masked in the response.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: WebhookResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const webhook = await webhookService.getWebhook(id);
      if (!webhook) return reply.status(404).send({ error: "Webhook not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && webhook.workspaceId && webhook.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Webhook not found" });
      }
      reply.send({
        webhook: { ...webhook, secret: webhook.secret ? "••••••" : null },
      });
    },
  );

  app.post(
    "/api/webhooks",
    {
      schema: {
        operationId: "createWebhook",
        summary: "Create an outbound webhook",
        description:
          "Register a new outbound webhook. The `url` is SSRF-guarded — " +
          "URLs pointing at private/internal addresses are rejected.",
        tags: ["Repos & Integrations"],
        body: createWebhookSchema,
        response: { 201: WebhookResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const webhook = await webhookService.createWebhook(req.body, req.user?.id, workspaceId);
      logAction({
        userId: req.user?.id,
        action: "webhook.create",
        params: { url: req.body.url, events: req.body.events },
        result: { id: webhook.id },
        success: true,
      }).catch(() => {});
      reply.status(201).send({
        webhook: { ...webhook, secret: webhook.secret ? "••••••" : null },
      });
    },
  );

  app.patch(
    "/api/webhooks/:id",
    {
      schema: {
        operationId: "updateWebhook",
        summary: "Update a webhook",
        description:
          "Partial update to a webhook. URL changes are SSRF-guarded; setting " +
          "`active: false` pauses deliveries without deleting the record.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: updateWebhookSchema,
        response: { 200: WebhookResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await webhookService.getWebhook(id);
      if (!existing) return reply.status(404).send({ error: "Webhook not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Webhook not found" });
      }
      const updated = await webhookService.updateWebhook(id, req.body);
      if (!updated) return reply.status(404).send({ error: "Webhook not found" });
      logAction({
        userId: req.user?.id,
        action: "webhook.update",
        params: { webhookId: id, ...req.body },
        result: { id },
        success: true,
      }).catch(() => {});
      reply.send({
        webhook: { ...updated, secret: updated.secret ? "••••••" : null },
      });
    },
  );

  app.delete(
    "/api/webhooks/:id",
    {
      schema: {
        operationId: "deleteWebhook",
        summary: "Delete a webhook",
        description: "Delete a webhook. Returns 204 on success.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const webhook = await webhookService.getWebhook(id);
      if (!webhook) return reply.status(404).send({ error: "Webhook not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && webhook.workspaceId && webhook.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Webhook not found" });
      }
      const deleted = await webhookService.deleteWebhook(id);
      if (!deleted) return reply.status(404).send({ error: "Webhook not found" });
      logAction({
        userId: req.user?.id,
        action: "webhook.delete",
        params: { webhookId: id },
        result: { id },
        success: true,
      }).catch(() => {});
      reply.status(204).send(null);
    },
  );

  app.post(
    "/api/webhooks/:id/test",
    {
      schema: {
        operationId: "testWebhook",
        summary: "Fire a test delivery",
        description:
          "Deliver a synthetic sample payload for the specified event (or " +
          "the first subscribed event if omitted). Useful for verifying " +
          "endpoint wiring without running a real task.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: testWebhookBodySchema,
        response: {
          200: DeliveryResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const webhook = await webhookService.getWebhook(id);
      if (!webhook) return reply.status(404).send({ error: "Webhook not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && webhook.workspaceId && webhook.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Webhook not found" });
      }
      const { event: overrideEvent } = req.body;
      const event = overrideEvent ?? (webhook.events[0] as webhookService.WebhookEvent);
      if (!event) {
        return reply.status(400).send({ error: "Webhook has no events subscribed" });
      }

      const samplePayload: Record<string, unknown> = event.startsWith("workflow_run.")
        ? {
            runId: "test-run-00000000",
            workflowId: "test-workflow-00000000",
            workflowName: "Test Workflow",
            state: event.replace("workflow_run.", ""),
            fromState: "running",
            params: { hello: "world" },
            costUsd: "0.12",
            durationMs: 4200,
            modelUsed: "claude-sonnet-4",
            test: true,
          }
        : {
            taskId: "test-task-00000000",
            taskTitle: "Test Task",
            repoUrl: "https://github.com/example/repo",
            repoBranch: "main",
            fromState: "running",
            toState: event.replace("task.", "").replace("review.", ""),
            test: true,
          };

      const delivery = await webhookService.deliverWebhook(webhook, event, samplePayload, 1);
      reply.send({ delivery });
    },
  );

  app.get(
    "/api/webhooks/:id/deliveries",
    {
      schema: {
        operationId: "listWebhookDeliveries",
        summary: "List webhook delivery history",
        description:
          "Return recent delivery attempts for a webhook, newest first. " +
          "Useful for debugging 5xx/timeout failures.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        querystring: limitQuerySchema,
        response: {
          200: DeliveryListResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const webhook = await webhookService.getWebhook(id);
      if (!webhook) return reply.status(404).send({ error: "Webhook not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && webhook.workspaceId && webhook.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Webhook not found" });
      }
      const { limit } = req.query;
      const deliveries = await webhookService.getWebhookDeliveries(id, {
        limit: limit ? parseInt(limit, 10) : 50,
      });
      reply.send({ deliveries });
    },
  );
}
