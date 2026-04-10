import type { FastifyInstance } from "fastify";
import { timingSafeEqual, createHmac } from "node:crypto";
import { z } from "zod";
import * as workflowService from "../services/workflow-service.js";
import { logger } from "../logger.js";

const webhookPathSchema = z.object({ webhookPath: z.string().min(1) });
const webhookBodySchema = z.record(z.unknown()).default({});

/**
 * Resolve a simple JSON-path expression (e.g. "$.foo.bar") against an object.
 * Supports dotted property access only — no arrays, filters, or wildcards.
 */
function resolveJsonPath(obj: unknown, path: string): unknown {
  // Strip leading "$." prefix if present
  const normalized = path.startsWith("$.") ? path.slice(2) : path;
  const segments = normalized.split(".");

  let current: unknown = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * Apply param mapping: for each key in the mapping, resolve the JSON-path
 * expression against the incoming body and build a params object.
 */
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

/**
 * Verify HMAC-SHA256 signature using timing-safe comparison.
 */
function verifyHmac(payload: string, secret: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function hookRoutes(app: FastifyInstance) {
  // Webhook trigger ingress — exempt from session auth, custom rate limit
  app.post(
    "/api/hooks/:webhookPath",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
    },
    async (req, reply) => {
      const { webhookPath } = webhookPathSchema.parse(req.params);

      // 1. Look up the webhook trigger
      const trigger = await workflowService.getWebhookTriggerByPath(webhookPath);
      if (!trigger || !trigger.enabled) {
        return reply.status(404).send({ error: "Webhook trigger not found" });
      }

      const config = trigger.config as Record<string, unknown> | null;
      const secret = config?.secret as string | undefined;

      // 2. HMAC verification (if secret is configured)
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

      // 3. Look up the workflow
      const workflow = await workflowService.getWorkflow(trigger.workflowId);
      if (!workflow) {
        return reply.status(404).send({ error: "Workflow not found" });
      }
      if (!workflow.enabled) {
        return reply.status(404).send({ error: "Workflow is disabled" });
      }

      // 4. Apply param mapping
      const body = webhookBodySchema.parse(req.body);
      const paramMapping = trigger.paramMapping as Record<string, unknown> | null;

      const params = paramMapping ? applyParamMapping(body, paramMapping) : body;

      // 5. Create workflow run
      const run = await workflowService.createWorkflowRun(trigger.workflowId, {
        triggerId: trigger.id,
        params,
      });

      logger.info(
        { runId: run.id, workflowId: trigger.workflowId, triggerId: trigger.id },
        "Webhook trigger created workflow run",
      );

      return reply.status(202).send({ runId: run.id });
    },
  );
}
