import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { interactiveSessions } from "../db/schema.js";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { isAuthDisabled } from "../services/oauth/index.js";

const SessionSummary = z.object({
  id: z.string().uuid(),
  title: z.string(),
  createdAt: z.string().datetime(),
});

const summary = (s: typeof interactiveSessions.$inferSelect) => ({
  id: s.id,
  title: s.title || "Optio Agent",
  createdAt: s.createdAt.toISOString(),
});

export async function optioSessionRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const owner = (req: { user?: { id: string; workspaceId?: string | null } | null }) => ({
    userId: isAuthDisabled() && req.user?.id === "local" ? null : (req.user?.id ?? null),
    workspaceId: req.user?.workspaceId ?? null,
  });
  app.get(
    "/api/optio/sessions",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "listOptioSessions",
        summary: "List your active Optio Agent sessions",
        tags: ["Interactive Sessions"],
        response: { 200: z.object({ sessions: z.array(SessionSummary) }) },
      },
    },
    async (req) => {
      const { userId, workspaceId } = owner(req);
      const sessions = await db
        .select()
        .from(interactiveSessions)
        .where(
          and(
            eq(interactiveSessions.assistant, true),
            eq(interactiveSessions.state, "active"),
            userId ? eq(interactiveSessions.userId, userId) : isNull(interactiveSessions.userId),
            workspaceId
              ? eq(interactiveSessions.workspaceId, workspaceId)
              : isNull(interactiveSessions.workspaceId),
          ),
        )
        .orderBy(asc(interactiveSessions.createdAt));
      return { sessions: sessions.map(summary) };
    },
  );
  app.post(
    "/api/optio/sessions",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createOptioSession",
        summary: "Create an independent Optio Agent session",
        tags: ["Interactive Sessions"],
        response: { 201: z.object({ session: SessionSummary }) },
        body: z.object({
          title: z.string().trim().min(1).max(100).optional(),
          default: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { createOptioSession, ensureOptioSession } =
        await import("../services/session-harness-service.js");
      const { userId, workspaceId } = owner(req);
      const session = req.body.default
        ? await ensureOptioSession(userId, workspaceId)
        : await createOptioSession(userId, workspaceId, req.body.title);
      return reply.code(201).send({ session: summary(session) });
    },
  );
  app.patch(
    "/api/optio/sessions/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "renameOptioSession",
        summary: "Rename your Optio Agent session",
        tags: ["Interactive Sessions"],
        response: { 200: z.object({ session: SessionSummary }), 404: ErrorResponseSchema },
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ title: z.string().trim().min(1).max(100) }),
      },
    },
    async (req, reply) => {
      const { getOptioSession } = await import("../services/session-harness-service.js");
      const { renameSession } = await import("../services/interactive-session-service.js");
      const { userId, workspaceId } = owner(req);
      if (!(await getOptioSession(req.params.id, userId, workspaceId)))
        return reply.code(404).send({ error: "Session not found" });
      return { session: summary(await renameSession(req.params.id, req.body.title)) };
    },
  );
  app.delete(
    "/api/optio/sessions/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "endOptioSession",
        summary: "End your Optio Agent session and retain its history",
        tags: ["Interactive Sessions"],
        response: { 204: z.null(), 404: ErrorResponseSchema },
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req, reply) => {
      const { getOptioSession } = await import("../services/session-harness-service.js");
      const { endSession } = await import("../services/interactive-session-service.js");
      const { userId, workspaceId } = owner(req);
      if (!(await getOptioSession(req.params.id, userId, workspaceId)))
        return reply.code(404).send({ error: "Session not found" });
      await endSession(req.params.id);
      return reply.code(204).send(null);
    },
  );
}
