import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponseSchema } from "../schemas/common.js";
import { refuseUnlessDeploymentAdmin } from "../services/deployment-admin-gates.js";
import {
  discardDeadLetters,
  listDeadLetters,
  outboxCounts,
  retryDeadLetters,
  retryPolicy,
} from "../services/notify/outbox.js";
import { logAction } from "../services/optio-action-service.js";
const AnyResponse = z.record(z.unknown());
const idsBody = z
  .object({ ids: z.array(z.string().uuid()).max(500).optional() })
  .optional()
  .default({});
const OUTBOX_REFUSAL = "Only a deployment admin can manage undelivered notifications";
export async function notifyDeliveryRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  // ── Undelivered (deployment admins) ─────────────────────────────────────

  app.get(
    "/api/notifications/outbox",
    {
      schema: {
        operationId: "getNotificationOutbox",
        summary: "What Optio couldn't deliver",
        description:
          "How many emails wait to be delivered, the ones Optio gave up on " +
          "(dead letters: recipient, subject, tries, the last error) and the retry policy. " +
          "Deployment admins only.",
        tags: ["Workspaces"],
        response: { 200: AnyResponse, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, OUTBOX_REFUSAL)) return reply;
      const [counts, dead] = await Promise.all([outboxCounts(), listDeadLetters()]);
      const p = retryPolicy();
      return reply.send({
        ...counts,
        items: dead,
        retry: {
          attempts: p.attempts,
          baseSeconds: p.baseMs / 1000,
          deadLetterDays: p.deadLetterDays,
        },
      });
    },
  );

  app.post(
    "/api/notifications/outbox/retry",
    {
      schema: {
        operationId: "retryNotificationOutbox",
        summary: "Try undelivered notifications again",
        description:
          "Gives the dead letters named in `ids` (or all of them) a fresh set of tries. " +
          "Deployment admins only.",
        tags: ["Workspaces"],
        body: idsBody,
        response: { 200: AnyResponse, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, OUTBOX_REFUSAL)) return reply;
      const count = await retryDeadLetters(req.body.ids);
      await logAction({
        action: "notify.outbox.retry",
        userId: req.user?.id,
        workspaceId: req.user?.workspaceId ?? null,
        result: { count },
        success: true,
      });
      return reply.send({ retried: count, ...(await outboxCounts()) });
    },
  );

  app.post(
    "/api/notifications/outbox/discard",
    {
      schema: {
        operationId: "discardNotificationOutbox",
        summary: "Discard undelivered notifications",
        description:
          "Forgets the dead letters named in `ids` (or all of them). Deployment admins only.",
        tags: ["Workspaces"],
        body: idsBody,
        response: { 200: AnyResponse, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, OUTBOX_REFUSAL)) return reply;
      const count = await discardDeadLetters(req.body.ids);
      await logAction({
        action: "notify.outbox.discard",
        userId: req.user?.id,
        workspaceId: req.user?.workspaceId ?? null,
        result: { count },
        success: true,
      });
      return reply.send({ discarded: count, ...(await outboxCounts()) });
    },
  );
}
