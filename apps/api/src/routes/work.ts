/**
 * `/api/work` — every kind of agent work as one resource, the way the UI
 * shows it. See services/work-service.ts and docs/tasks.md.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { inView, type WorkView } from "@optio/shared";
import * as workService from "../services/work-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import {
  WorkDetailResponseSchema,
  WorkListQuerySchema,
  WorkListResponseSchema,
} from "../schemas/work.js";

export async function workRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/work",
    {
      schema: {
        operationId: "listWork",
        summary: "List work",
        description:
          "Every piece of work the caller can see — Tasks, scheduled Tasks, Jobs, Local " +
          "automations and sessions, pod sessions, and persistent agents — projected onto " +
          "When / Where / Who / Then and one status scale, needs-you first. Workspace rows are " +
          "scoped to the current workspace; machines and pod sessions to the caller.",
        tags: ["Tasks"],
        querystring: WorkListQuerySchema,
        response: { 200: WorkListResponseSchema },
      },
    },
    async (req, reply) => {
      const rows = await workService.listWork(scopeOf(req));
      const view = (req.query.view ?? "all") as WorkView;
      reply.send({ rows: rows.filter((r) => inView(r, view)) });
    },
  );

  app.get(
    "/api/work/:id",
    {
      schema: {
        operationId: "getWork",
        summary: "Get a piece of work by id",
        description:
          "Resolves the id across every kind of work and returns its native row plus the " +
          "row the Work list shows for it.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: { 200: WorkDetailResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const resolved = await workService.resolveWork(req.params.id, scopeOf(req));
      if (!resolved) return reply.status(404).send({ error: "Work not found" });
      reply.send({ source: resolved.source, row: resolved.row, work: resolved.data });
    },
  );
}

function scopeOf(req: { user?: { id: string; workspaceId?: string | null } }) {
  return { workspaceId: req.user?.workspaceId ?? null, userId: req.user?.id ?? null };
}
