import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { timingSafeEqual, createHmac } from "node:crypto";
import { z } from "zod";
import type { SelfSecretTriggerType } from "@optio/shared";
import { getTrigger, getWebhookTriggerByPath } from "../services/trigger-service.js";
import { fireTrigger, type TriggerFireResult } from "../services/trigger-dispatch.js";
import {
  firingFor,
  normalizeAlertmanagerEvent,
  normalizeDatadogEvent,
  normalizePylonEvent,
  type EventOf,
} from "../services/event-trigger-service.js";
import { presentedSecret, verifySharedSecret } from "../utils/webhook-signature.js";
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

const SelfSecretAcceptedResponseSchema = WebhookAcceptedResponseSchema.extend({
  matched: z
    .boolean()
    .optional()
    .describe("false when the delivery's event kind isn't one the trigger listens for"),
}).describe("Delivery accepted; what it started, if it matched");

const selfSecretParamsSchema = z
  .object({ triggerId: z.string().uuid().describe("The trigger's id") })
  .describe("Path parameters: trigger id");

/**
 * The self-secret receivers: a provider that can't sign its deliveries posts
 * to its trigger's own URL with the trigger's secret, and the delivery is
 * matched and fired for that one trigger.
 */
const SELF_SECRET_RECEIVERS: Record<
  SelfSecretTriggerType,
  {
    name: string;
    operationId: string;
    description: string;
    normalize: (body: unknown) => EventOf<SelfSecretTriggerType> | null;
  }
> = {
  pylon: {
    name: "Pylon",
    operationId: "triggerPylonWebhook",
    description:
      "Where a Pylon trigger (Pylon → Settings → Triggers, a webhook action) " +
      "posts. Pylon doesn't sign deliveries, so each Optio Pylon trigger has " +
      "its own shared secret — returned once when the trigger is created — " +
      "which the delivery must carry in an `X-Optio-Secret` header (or as " +
      "`Authorization: Bearer <secret>`), added as a custom request header in " +
      "Pylon. The payload is whatever the Pylon trigger sends; its event kind " +
      "(`event` / `event_type` / `type` / `trigger` / `data.event`) is matched " +
      "against the trigger's `events` filter, and its issue fields become " +
      "prompt params. Rate limited to 60/minute.",
    normalize: normalizePylonEvent,
  },
  alertmanager: {
    name: "Alertmanager",
    operationId: "triggerAlertmanagerWebhook",
    description:
      "Where a Prometheus Alertmanager `webhook_config` or a Grafana Alerting " +
      "webhook contact point posts for one Optio trigger. Neither signs, so the " +
      "delivery carries the trigger's shared secret — returned once when the " +
      "trigger is created — as `Authorization: Bearer <secret>`, as the password " +
      "of HTTP basic auth (any user), or in an `X-Optio-Secret` header. One " +
      "delivery is one alert group; its status (firing / resolved), alert " +
      "names, severities and receiver are matched against the trigger's filters " +
      "and every alert's labels and annotations become prompt params. Rate " +
      "limited to 60/minute.",
    normalize: normalizeAlertmanagerEvent,
  },
  datadog: {
    name: "Datadog",
    operationId: "triggerDatadogWebhook",
    description:
      "Where a Datadog webhook (Integrations → Webhooks, then `@webhook-<name>` " +
      "in a monitor's message) posts for one Optio trigger. Datadog doesn't " +
      "sign, so the webhook's custom headers carry the trigger's shared secret " +
      "— returned once when the trigger is created — as `X-Optio-Secret` (or " +
      "`Authorization: Bearer <secret>`). The payload is the webhook's template: " +
      "use `DATADOG_PAYLOAD_TEMPLATE` so the transition, priority, tags and the " +
      "monitor's query reach the trigger's filters and prompt params. Rate " +
      "limited to 60/minute.",
    normalize: normalizeDatadogEvent,
  },
};

/** The 202 for what a firing started, in the generic hook's shape. */
function accepted(fired: TriggerFireResult): Record<string, string> {
  switch (fired.kind) {
    case "workflow_run":
      return { runId: fired.id };
    case "task":
      return { taskId: fired.id };
    case "local_terminal":
      return { terminalId: fired.id };
    case "persistent_agent":
      // The agent id rides in runId for back-compat with the original
      // webhook response shape.
      return { runId: fired.id };
    default:
      return {};
  }
}

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
      return reply.status(202).send(accepted(fired));
    },
  );

  for (const [type, receiver] of Object.entries(SELF_SECRET_RECEIVERS) as [
    SelfSecretTriggerType,
    (typeof SELF_SECRET_RECEIVERS)[SelfSecretTriggerType],
  ][]) {
    app.post(
      `/api/hooks/${type}/:triggerId`,
      {
        config: {
          rateLimit: {
            max: 60,
            timeWindow: "1 minute",
          },
        },
        schema: {
          operationId: receiver.operationId,
          summary: `${receiver.name} trigger ingress`,
          description: receiver.description,
          tags: ["System"],
          security: [],
          params: selfSecretParamsSchema,
          body: webhookBodySchema,
          response: {
            202: SelfSecretAcceptedResponseSchema,
            401: ErrorResponseSchema,
            404: ErrorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        const trigger = await getTrigger(req.params.triggerId);
        if (!trigger || trigger.type !== type || !trigger.enabled) {
          return reply.status(404).send({ error: `${receiver.name} trigger not found` });
        }
        const config = (trigger.config ?? {}) as Record<string, unknown>;
        const secret = typeof config.secret === "string" ? config.secret : "";
        if (!secret) {
          logger.error(
            { triggerId: trigger.id, type },
            `${receiver.name} trigger has no secret — rejecting`,
          );
          return reply.status(401).send({ error: `${receiver.name} trigger has no secret` });
        }
        if (!verifySharedSecret(presentedSecret(req.headers), secret)) {
          return reply.status(401).send({ error: "Invalid or missing X-Optio-Secret" });
        }

        const event = receiver.normalize(req.body);
        if (!event) return reply.status(202).send({ matched: false });
        const firing = firingFor(type, event, config);
        if (!firing) return reply.status(202).send({ matched: false });
        const { matched: _matched, ...rest } = firing;

        let fired;
        try {
          fired = await fireTrigger(trigger, rest);
        } catch (err) {
          logger.warn(
            { err, triggerId: trigger.id, targetType: trigger.targetType, type },
            `${receiver.name} trigger failed to start its target`,
          );
          return reply.status(404).send({
            error: err instanceof Error ? err.message : "Trigger target failed to start",
          });
        }
        if (!fired) {
          return reply.status(404).send({ error: "Trigger target not found or disabled" });
        }
        return reply.status(202).send(accepted(fired));
      },
    );
  }
}
