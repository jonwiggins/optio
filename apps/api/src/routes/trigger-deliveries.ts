import { deliveryTargetScope } from "../services/trigger-delivery.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { triggerOccurrences } from "../db/schema.js";
import { actorOf, canChange, canSee, visibleOwner } from "../services/ownership.js";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { usageScope } from "../services/usage-service.js";

const DeliverySchema = z.object({
  id: z.string(),
  triggerId: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  name: z.string(),
  source: z.string(),
  state: z.string(),
  attempts: z.number(),
  receivedAt: z.string(),
  finishedAt: z.string().nullable(),
  nextAttemptAt: z.string(),
  error: z.string().nullable(),
  result: z.record(z.unknown()).nullable(),
  canRetry: z.boolean(),
});

export async function triggerDeliveryRoutes(raw: FastifyInstance) {
  const app = raw.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/api/trigger-deliveries",
    {
      schema: {
        tags: ["Work"],
        operationId: "listTriggerDeliveries",
        summary: "Trigger delivery history",
        response: { 200: z.object({ rows: z.array(DeliverySchema), next: z.string().nullable() }) },
        querystring: z.object({
          workId: z.string().uuid().optional(),
          state: z.enum(["pending", "started", "failed", "skipped"]).optional(),
          before: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z_[a-f0-9-]{36}$/)
            .optional(),
        }),
      },
    },
    async (req) => {
      const actor = actorOf(req),
        q = req.query;
      const rows = await db
        .select({
          id: triggerOccurrences.id,
          triggerId: triggerOccurrences.triggerId,
          targetType: triggerOccurrences.targetType,
          targetId: triggerOccurrences.targetId,
          name: triggerOccurrences.targetName,
          source: triggerOccurrences.source,
          state: triggerOccurrences.state,
          attempts: triggerOccurrences.attempts,
          receivedAt: triggerOccurrences.receivedAt,
          finishedAt: triggerOccurrences.finishedAt,
          nextAttemptAt: triggerOccurrences.nextAttemptAt,
          result: triggerOccurrences.result,
          error: triggerOccurrences.error,
          ownerUserId: triggerOccurrences.ownerUserId,
          ownerTeamId: triggerOccurrences.ownerTeamId,
        })
        .from(triggerOccurrences)
        .where(
          and(
            usageScope(actor.workspaceId),
            visibleOwner(triggerOccurrences.ownerUserId, actor, triggerOccurrences.ownerTeamId),
            q.workId ? eq(triggerOccurrences.targetId, q.workId) : undefined,
            q.state ? eq(triggerOccurrences.state, q.state) : undefined,
            q.before
              ? sql`(${triggerOccurrences.receivedAt},${triggerOccurrences.id})<(${q.before.split("_")[0]}::timestamptz,${q.before.split("_")[1]}::uuid)`
              : undefined,
          ),
        )
        .orderBy(sql`${triggerOccurrences.receivedAt} DESC`, sql`${triggerOccurrences.id} DESC`)
        .limit(51);
      const page = rows.slice(0, 50);
      return {
        rows: page.map(({ ownerTeamId, ...r }) => ({
          ...r,
          receivedAt: r.receivedAt.toISOString(),
          finishedAt: r.finishedAt?.toISOString() ?? null,
          nextAttemptAt: r.nextAttemptAt.toISOString(),
          canRetry:
            r.state === "failed" &&
            req.user?.workspaceRole !== "viewer" &&
            canChange(r.ownerUserId, actor, true, "edit", { ownerTeamId, orgNeeds: "member" }),
        })),
        next:
          rows.length > 50
            ? `${page[page.length - 1].receivedAt.toISOString()}_${page[page.length - 1].id}`
            : null,
      };
    },
  );
  app.post(
    "/api/trigger-deliveries/:id/retry",
    {
      preHandler: [requireRole("member")],
      schema: {
        tags: ["Work"],
        operationId: "retryTriggerDelivery",
        summary: "Retry a failed dispatch using its original run identity",
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ id: z.string() }),
          404: ErrorResponseSchema,
          403: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const [row] = await db
        .select()
        .from(triggerOccurrences)
        .where(and(eq(triggerOccurrences.id, req.params.id), usageScope(actor.workspaceId)));
      if (!row || !canSee(row.ownerUserId, actor, row.ownerTeamId))
        return reply.status(404).send({ error: "Delivery not found" });
      // A team's work is its members' to run (services/work-ownership.ts).
      const team = (ownerTeamId: string | null | undefined) => ({
        ownerTeamId,
        orgNeeds: "member" as const,
      });
      if (!canChange(row.ownerUserId, actor, true, "edit", team(row.ownerTeamId)))
        return reply.status(403).send({ error: "Only the owner can retry this delivery" });
      const current = await deliveryTargetScope(row.targetId);
      if (!current || current.workspace_id !== actor.workspaceId)
        return reply.status(404).send({ error: "Work is no longer available" });
      if (!canChange(current.owner_user_id, actor, true, "edit", team(current.owner_team_id)))
        return reply.status(403).send({ error: "Only the current owner can retry this delivery" });
      const [changed] = await db
        .update(triggerOccurrences)
        .set({ state: "pending", attempts: 0, error: null, nextAttemptAt: new Date() })
        .where(and(eq(triggerOccurrences.id, row.id), eq(triggerOccurrences.state, "failed")))
        .returning({ id: triggerOccurrences.id });
      if (!changed)
        return reply.status(409).send({ error: "Only failed deliveries can be retried" });
      return { id: changed.id };
    },
  );
}
