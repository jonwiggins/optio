import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isSsrfSafeUrl } from "../utils/ssrf.js";
import * as webhookService from "../services/webhook-service.js";

const idParamsSchema = z.object({ id: z.string() });
const limitQuerySchema = z.object({ limit: z.string().optional() });

const webhookEventEnum = z.enum([
  "task.completed",
  "task.failed",
  "task.needs_attention",
  "task.pr_opened",
  "review.completed",
  "workflow_run.queued",
  "workflow_run.started",
  "workflow_run.completed",
  "workflow_run.failed",
]);

const createWebhookSchema = z.object({
  url: z.string().url().refine(isSsrfSafeUrl, {
    message: "URL must not target private or internal addresses",
  }),
  events: z.array(webhookEventEnum).min(1),
  secret: z.string().min(1).optional(),
  description: z.string().optional(),
});

const updateWebhookSchema = z.object({
  url: z
    .string()
    .url()
    .refine(isSsrfSafeUrl, { message: "URL must not target private or internal addresses" })
    .optional(),
  events: z.array(webhookEventEnum).min(1).optional(),
  secret: z.string().min(1).nullable().optional(),
  description: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

const testWebhookBodySchema = z
  .object({ event: webhookEventEnum.optional() })
  .optional()
  .default({});

export async function webhookRoutes(app: FastifyInstance) {
  // List all webhooks — scoped to workspace
  app.get("/api/webhooks", async (req, reply) => {
    const workspaceId = req.user?.workspaceId ?? null;
    const hooks = await webhookService.listWebhooks(workspaceId);
    // Mask secrets in the response
    const masked = hooks.map((h) => ({
      ...h,
      secret: h.secret ? "••••••" : null,
    }));
    reply.send({ webhooks: masked });
  });

  // Get a single webhook — verify workspace ownership
  app.get("/api/webhooks/:id", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const webhook = await webhookService.getWebhook(id);
    if (!webhook) return reply.status(404).send({ error: "Webhook not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && webhook.workspaceId && webhook.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Webhook not found" });
    }
    reply.send({
      webhook: { ...webhook, secret: webhook.secret ? "••••••" : null },
    });
  });

  // Create a webhook — assign to workspace
  app.post("/api/webhooks", async (req, reply) => {
    const body = createWebhookSchema.parse(req.body);
    const workspaceId = req.user?.workspaceId ?? null;
    const webhook = await webhookService.createWebhook(body, req.user?.id, workspaceId);
    reply.status(201).send({ webhook: { ...webhook, secret: webhook.secret ? "••••••" : null } });
  });

  // Update a webhook (toggle active, edit URL/events/secret/description)
  app.patch("/api/webhooks/:id", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const existing = await webhookService.getWebhook(id);
    if (!existing) return reply.status(404).send({ error: "Webhook not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Webhook not found" });
    }
    const body = updateWebhookSchema.parse(req.body);
    const updated = await webhookService.updateWebhook(id, body);
    if (!updated) return reply.status(404).send({ error: "Webhook not found" });
    reply.send({
      webhook: { ...updated, secret: updated.secret ? "••••••" : null },
    });
  });

  // Delete a webhook — verify workspace ownership
  app.delete("/api/webhooks/:id", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const webhook = await webhookService.getWebhook(id);
    if (!webhook) return reply.status(404).send({ error: "Webhook not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && webhook.workspaceId && webhook.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Webhook not found" });
    }
    const deleted = await webhookService.deleteWebhook(id);
    if (!deleted) return reply.status(404).send({ error: "Webhook not found" });
    reply.status(204).send();
  });

  // Fire a test event to this webhook. Uses the first subscribed event by
  // default, or an explicit event passed in the body. The payload is a
  // synthetic sample so receivers can verify integration without running a task.
  app.post("/api/webhooks/:id/test", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const webhook = await webhookService.getWebhook(id);
    if (!webhook) return reply.status(404).send({ error: "Webhook not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && webhook.workspaceId && webhook.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Webhook not found" });
    }
    const { event: overrideEvent } = testWebhookBodySchema.parse(req.body ?? {});
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
  });

  // List deliveries for a webhook — verify workspace ownership
  app.get("/api/webhooks/:id/deliveries", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const webhook = await webhookService.getWebhook(id);
    if (!webhook) return reply.status(404).send({ error: "Webhook not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && webhook.workspaceId && webhook.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Webhook not found" });
    }
    const { limit } = limitQuerySchema.parse(req.query);
    const deliveries = await webhookService.getWebhookDeliveries(id, {
      limit: limit ? parseInt(limit, 10) : 50,
    });
    reply.send({ deliveries });
  });
}
