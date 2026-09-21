import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { timingSafeEqual, createHmac } from "node:crypto";
import { z } from "zod";
import { getWebhookTriggerByPath } from "../services/trigger-service.js";
import { fireTrigger } from "../services/trigger-dispatch.js";
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
    terminalId: z
      .string()
      .optional()
      .describe("Local terminal id when the target is a local_blueprint"),
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

      const trigger = await getWebhookTriggerByPath(webhookPath);
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

      // One dispatcher for every target: a Job run, a Task, a Local terminal,
      // a persistent-agent message. A spawn that fails (no host, dir
      // unresolved) is the caller's 404-ish outcome, not a 500 — the trigger
      // itself was valid.
      let fired;
      try {
        fired = await fireTrigger(trigger, {
          source: "webhook",
          params,
          message:
            typeof body === "string"
              ? body
              : `Webhook payload:\n${JSON.stringify(params ?? body, null, 2)}`,
        });
      } catch (err) {
        logger.warn(
          { err, triggerId: trigger.id, targetType: trigger.targetType },
          "Webhook trigger failed to start its target",
        );
        return reply
          .status(404)
          .send({ error: err instanceof Error ? err.message : "Trigger target failed to start" });
      }
      if (!fired) {
        return reply.status(404).send({ error: "Trigger target not found or disabled" });
      }
      switch (fired.kind) {
        case "workflow_run":
          return reply.status(202).send({ runId: fired.id });
        case "task":
          return reply.status(202).send({ taskId: fired.id });
        case "local_terminal":
          return reply.status(202).send({ terminalId: fired.id });
        case "persistent_agent":
          // The agent id rides in runId for back-compat with the original
          // webhook response shape.
          return reply.status(202).send({ runId: fired.id });
        default:
          return reply.status(202).send({});
      }
    },
  );
}
