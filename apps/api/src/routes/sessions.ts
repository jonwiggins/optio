import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as sessionService from "../services/interactive-session-service.js";
import { db } from "../db/client.js";
import { repos } from "../db/schema.js";

const listSessionsQuerySchema = z.object({
  repoUrl: z.string().optional(),
  state: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createSessionSchema = z.object({
  repoUrl: z.string().url(),
});

export async function sessionRoutes(app: FastifyInstance) {
  // List sessions — scoped to the current user
  app.get("/api/sessions", async (req, reply) => {
    const parsed = listSessionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message });
    }
    const { repoUrl, state, limit, offset } = parsed.data;
    const sessions = await sessionService.listSessions({
      repoUrl,
      state,
      limit,
      offset,
      userId: req.user?.id,
    });
    const activeCount = await sessionService.getActiveSessionCount(repoUrl);
    reply.send({ sessions, activeCount });
  });

  // Get session — verify ownership
  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await sessionService.getSession(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });

    // Verify the session belongs to the requesting user
    if (req.user?.id && session.userId && session.userId !== req.user.id) {
      return reply.status(404).send({ error: "Session not found" });
    }

    // Attach repo model config
    let modelConfig: { claudeModel: string; availableModels: string[] } | null = null;
    try {
      const [repoConfig] = await db.select().from(repos).where(eq(repos.repoUrl, session.repoUrl));
      modelConfig = {
        claudeModel: repoConfig?.claudeModel ?? "sonnet",
        availableModels: ["haiku", "sonnet", "opus"],
      };
    } catch {
      // Non-critical
    }

    reply.send({ session, modelConfig });
  });

  // Create session
  app.post("/api/sessions", async (req, reply) => {
    const input = createSessionSchema.parse(req.body);
    const userId = req.user?.id;
    const session = await sessionService.createSession({
      repoUrl: input.repoUrl,
      userId,
      workspaceId: req.user?.workspaceId ?? null,
    });
    reply.status(201).send({ session });
  });

  // End session — verify ownership
  app.post("/api/sessions/:id/end", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await sessionService.getSession(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });

    // Verify the session belongs to the requesting user
    if (req.user?.id && session.userId && session.userId !== req.user.id) {
      return reply.status(404).send({ error: "Session not found" });
    }

    try {
      const updated = await sessionService.endSession(id);
      reply.send({ session: updated });
    } catch (err) {
      reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // List PRs for a session — verify ownership
  app.get("/api/sessions/:id/prs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await sessionService.getSession(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });

    if (req.user?.id && session.userId && session.userId !== req.user.id) {
      return reply.status(404).send({ error: "Session not found" });
    }

    const prs = await sessionService.getSessionPrs(id);
    reply.send({ prs });
  });

  // Add a PR to a session — verify ownership
  app.post("/api/sessions/:id/prs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await sessionService.getSession(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });

    if (req.user?.id && session.userId && session.userId !== req.user.id) {
      return reply.status(404).send({ error: "Session not found" });
    }

    const body = req.body as { prUrl: string; prNumber: number };
    if (!body.prUrl || !body.prNumber) {
      return reply.status(400).send({ error: "prUrl and prNumber required" });
    }
    const pr = await sessionService.addSessionPr(id, body.prUrl, body.prNumber);
    reply.status(201).send({ pr });
  });

  // Get active session count
  app.get("/api/sessions/active-count", async (req, reply) => {
    const { repoUrl } = req.query as { repoUrl?: string };
    const count = await sessionService.getActiveSessionCount(repoUrl);
    reply.send({ count });
  });
}
