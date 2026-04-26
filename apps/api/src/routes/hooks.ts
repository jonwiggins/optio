import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { timingSafeEqual, createHmac } from "node:crypto";
import { z } from "zod";
import * as workflowService from "../services/workflow-service.js";
import * as taskConfigService from "../services/task-config-service.js";
import { logger } from "../logger.js";
import { ErrorResponseSchema } from "../schemas/common.js";

const webhookPathSchema = z
  .object({
    webhookPath: z.string().min(1).describe("Opaque path configured on the webhook trigger"),
  })
  .describe("Path parameters: webhook path");

const webhookBodySchema = z
  .record(z.unknown())
  .default({})
  .describe("Arbitrary JSON payload from the upstream webhook provider");

const WebhookAcceptedResponseSchema = z
  .object({
    runId: z.string().optional().describe("Workflow run id when the target is a job"),
    taskId: z.string().optional().describe("Task id when the target is a task_config"),
  })
  .describe("Webhook accepted and run/task queued");

/**
 * Resolve a simple JSON-path expression (e.g. "$.foo.bar") against an object.
 * Supports dotted property access only — no arrays, filters, or wildcards.
 */
function resolveJsonPath(obj: unknown, path: string): unknown {
  const normalized = path.startsWith("$.") ? path.slice(2) : path;
  const segments = normalized.split(".");

  let current: unknown = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

function applyParamMapping(
  body: Record<string, unknown>,
  mapping: Record<string, unknown>,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, pathExpr] of Object.entries(mapping)) {
    if (typeof pathExpr === "string") {
      params[key] = resolveJsonPath(body, pathExpr);
    }
  }
  return params;
}

function verifyHmac(payload: string, secret: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function hookRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/hooks/:webhookPath",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
      schema: {
        operationId: "triggerWebhookWorkflow",
        summary: "Webhook trigger ingress",
        description:
          "Public webhook ingress for workflow triggers. Each configured " +
          "webhook trigger has a unique `webhookPath` the upstream caller " +
          "posts to. If the trigger has a secret configured, the request " +
          "must include an `X-Optio-Signature` header with an HMAC-SHA256 " +
          "digest of the raw request body. The body is passed through the " +
          "trigger's `paramMapping` to build workflow params, then a " +
          "workflow run is created. Rate limited to 60/minute per webhook.",
        tags: ["System"],
        security: [],
        params: webhookPathSchema,
        body: webhookBodySchema,
        response: {
          202: WebhookAcceptedResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { webhookPath } = req.params;

      const trigger = await workflowService.getWebhookTriggerByPath(webhookPath);
      if (!trigger || !trigger.enabled) {
        return reply.status(404).send({ error: "Webhook trigger not found" });
      }

      const config = trigger.config as Record<string, unknown> | null;
      const secret = config?.secret as string | undefined;

      if (secret) {
        const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
        const signature = req.headers["x-optio-signature"] as string | undefined;

        if (!signature) {
          return reply
            .status(401)
            .send({ error: "Missing X-Optio-Signature header — signature required" });
        }

        if (!verifyHmac(rawBody, secret, signature)) {
          return reply.status(401).send({ error: "Invalid signature" });
        }
      }

      const body = req.body;
      const paramMapping = trigger.paramMapping as Record<string, unknown> | null;
      const params = paramMapping ? applyParamMapping(body, paramMapping) : body;

      if (trigger.targetType === "job") {
        if (!trigger.workflowId) {
          return reply.status(404).send({ error: "Webhook trigger has no workflow" });
        }
        const workflow = await workflowService.getWorkflow(trigger.workflowId);
        if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
        if (!workflow.enabled) return reply.status(404).send({ error: "Workflow is disabled" });
        const run = await workflowService.createWorkflowRun(trigger.workflowId, {
          triggerId: trigger.id,
          params,
        });
        logger.info(
          { runId: run.id, workflowId: trigger.workflowId, triggerId: trigger.id },
          "Webhook trigger created workflow run",
        );
        return reply.status(202).send({ runId: run.id });
      }

      if (trigger.targetType === "task_config") {
        const taskConfig = await taskConfigService.getTaskConfig(trigger.targetId);
        if (!taskConfig || !taskConfig.enabled) {
          return reply.status(404).send({ error: "Target task config not found or disabled" });
        }
        const task = await taskConfigService.instantiateTask(taskConfig.id, {
          triggerId: trigger.id,
          params,
        });
        logger.info(
          { taskId: task.id, taskConfigId: taskConfig.id, triggerId: trigger.id },
          "Webhook trigger created task from task_config",
        );
        return reply.status(202).send({ taskId: task.id });
      }

      if (trigger.targetType === "persistent_agent") {
        const { getPersistentAgent, wakeAgent, buildSenderId } =
          await import("../services/persistent-agent-service.js");
        const agent = await getPersistentAgent(trigger.targetId);
        if (!agent || !agent.enabled) {
          return reply.status(404).send({ error: "Target persistent agent not found or disabled" });
        }
        const messageBody =
          typeof body === "string"
            ? body
            : `Webhook payload:\n${JSON.stringify(params ?? body, null, 2)}`;
        await wakeAgent({
          agentId: agent.id,
          source: "webhook",
          body: messageBody,
          senderType: "external",
          senderId: buildSenderId({ type: "external", label: `webhook:${webhookPath}` }),
          senderName: `webhook:${webhookPath}`,
          structuredPayload: (params as Record<string, unknown> | null) ?? undefined,
        });
        logger.info(
          { agentId: agent.id, slug: agent.slug, triggerId: trigger.id },
          "Webhook trigger woke persistent agent",
        );
        // Reuse the runId field for back-compat with the existing webhook
        // response shape — the agent id serves the same caller purpose.
        return reply.status(202).send({ runId: agent.id });
      }

      return reply.status(404).send({ error: "Unknown trigger target type" });
    },
  );
}
