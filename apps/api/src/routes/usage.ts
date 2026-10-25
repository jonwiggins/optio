import { UsageBudgetSchema, UsageResponseSchema } from "../schemas/usage.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { usageBudgets } from "../db/schema.js";
import { getUsage, listUsageBudgets } from "../services/usage-service.js";
import { actorOf } from "../services/ownership.js";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema } from "../schemas/common.js";

const BudgetBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    subjectKind: z.enum(["organization", "person", "work"]),
    subjectId: z.string().uuid().nullable().optional(),
    tokenLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    costLimit: z
      .string()
      .regex(/^\d{1,10}(\.\d{1,6})?$/)
      .refine((v) => Number(v) > 0)
      .nullable()
      .optional(),
    action: z.enum(["notify", "pause_new"]),
    enabled: z.boolean().optional(),
  })
  .refine((b) => b.tokenLimit != null || b.costLimit != null, {
    message: "Set a token or cost limit",
  })
  .refine((b) => (b.subjectKind === "organization" ? !b.subjectId : !!b.subjectId), {
    message: "Choose the budget subject",
  });

export async function usageRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/api/analytics/usage",
    {
      preHandler: [requireRole("member")],
      schema: {
        tags: ["Analytics"],
        operationId: "getUsage",
        summary: "Usage, people and organization work leaderboard",
        querystring: z.object({
          days: z.coerce.number().int().min(1).max(365).optional(),
          kind: z.enum(["all", "person", "work"]).optional(),
          sort: z.enum(["tokens", "cost", "runs"]).optional(),
          page: z.coerce.number().int().min(0).max(10000).optional(),
          q: z.string().max(120).optional(),
          subjectId: z.string().uuid().optional(),
          model: z.string().max(200).optional(),
          repoUrl: z.string().max(2048).optional(),
        }),
        response: { 200: UsageResponseSchema },
      },
    },
    async (req) => getUsage(req.query, actorOf(req)),
  );
  app.post(
    "/api/usage/budgets",
    {
      preHandler: [requireRole("admin")],
      schema: {
        tags: ["Analytics"],
        operationId: "saveUsageBudget",
        summary: "Save a calendar-month usage budget",
        body: BudgetBody,
        response: {
          200: z.object({ budgets: z.array(UsageBudgetSchema) }),
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req),
        b = req.body;
      if (!actor.workspaceId)
        return reply.status(400).send({ error: "Select an organization to configure budgets" });
      if (b.subjectKind !== "organization") {
        const [valid] = await db.execute(
          sql`SELECT 1 FROM usage_ledger WHERE workspace_id=${actor.workspaceId}::uuid AND subject_kind=${b.subjectKind} AND subject_id=${b.subjectId}::uuid LIMIT 1`,
        );
        if (!valid)
          return reply
            .status(400)
            .send({ error: "Choose a person or work from this organization’s usage leaderboard" });
      }
      await db.execute(sql`INSERT INTO usage_budgets(workspace_id,subject_kind,subject_id,name,token_limit,cost_limit,action,enabled)
      VALUES(${actor.workspaceId}::uuid,${b.subjectKind},${b.subjectId ?? null}::uuid,${b.name},${b.tokenLimit ?? null},${b.costLimit ?? null}::numeric,${b.action},${b.enabled ?? true})
      ON CONFLICT (workspace_id,subject_kind,(COALESCE(subject_id,'00000000-0000-0000-0000-000000000000'::uuid))) DO UPDATE SET name=EXCLUDED.name,token_limit=EXCLUDED.token_limit,cost_limit=EXCLUDED.cost_limit,action=EXCLUDED.action,enabled=EXCLUDED.enabled,updated_at=now()`);
      return { budgets: await listUsageBudgets(actor.workspaceId) };
    },
  );
  app.delete(
    "/api/usage/budgets/:id",
    {
      preHandler: [requireRole("admin")],
      schema: {
        tags: ["Analytics"],
        operationId: "deleteUsageBudget",
        summary: "Remove a usage budget",
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.void(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const rows = await db
        .delete(usageBudgets)
        .where(
          and(
            eq(usageBudgets.id, req.params.id),
            sql`${usageBudgets.workspaceId}=${actor.workspaceId}::uuid`,
          ),
        )
        .returning({ id: usageBudgets.id });
      if (!rows.length) return reply.status(404).send({ error: "Budget not found" });
      return reply.status(204).send();
    },
  );
}
