import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as sessionService from "../services/interactive-session-service.js";
import { db } from "../db/client.js";
import { repos } from "../db/schema.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import {
  InteractiveSessionSchema,
  SessionModelConfigSchema,
  SessionPrSchema,
} from "../schemas/session.js";

const listSessionsQuerySchema = z
  .object({
    repoUrl: z.string().optional().describe("Filter by exact repo URL"),
    state: z.string().optional().describe("Filter by session state"),
    limit: z.coerce.number().int().min(1).max(1000).default(50).describe("Page size (1–1000)"),
    offset: z.coerce.number().int().min(0).default(0).describe("Offset from start"),
  })
  .describe("List sessions query parameters");

const createSessionSchema = z
  .object({
    repoUrl: z.string().url().describe("Repository URL for the session to check out"),
  })
  .describe("Body for creating a new interactive session");

const addSessionPrSchema = z
  .object({
    prUrl: z.string().min(1).describe("Pull request URL"),
    prNumber: z.number().int().positive().describe("Pull request number"),
  })
  .describe("Body for attaching a PR to a session");

const activeCountQuerySchema = z
  .object({
    repoUrl: z.string().optional().describe("Scope the count to a single repo"),
  })
  .describe("Query parameters for active session count");

const SessionListResponseSchema = z
  .object({
    sessions: z.array(InteractiveSessionSchema),
    activeCount: z.number().int(),
  })
  .describe("Paginated session list with active count");

const SessionDetailResponseSchema = z
  .object({
    session: InteractiveSessionSchema,
    modelConfig: SessionModelConfigSchema.nullable(),
  })
  .describe("Session + repo model configuration");

const SessionResponseSchema = z
  .object({
    session: InteractiveSessionSchema,
  })
  .describe("Single session envelope");

const SessionPrListResponseSchema = z
  .object({
    prs: z.array(SessionPrSchema),
  })
  .describe("List of PRs opened during a session");

const SessionPrResponseSchema = z
  .object({
    pr: SessionPrSchema,
  })
  .describe("Single session PR envelope");

const ActiveCountResponseSchema = z
  .object({
    count: z.number().int(),
  })
  .describe("Active session count");

export async function sessionRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/sessions",
    {
      schema: {
        operationId: "listSessions",
        summary: "List interactive sessions",
        description:
          "Return all interactive sessions for the current user, with " +
          "filters on `repoUrl` and `state` plus offset-based pagination. " +
          "The response also includes the active session count across the " +
          "same scope for header badges.",
        tags: ["Sessions"],
        querystring: listSessionsQuerySchema,
        response: {
          200: SessionListResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { repoUrl, state, limit, offset } = req.query;
      const sessions = await sessionService.listSessions({
        repoUrl,
        state,
        limit,
        offset,
        userId: req.user?.id,
      });
      const activeCount = await sessionService.getActiveSessionCount(repoUrl);
      reply.send({ sessions, activeCount });
    },
  );

  app.get(
    "/api/sessions/active-count",
    {
      schema: {
        operationId: "getActiveSessionCount",
        summary: "Get the active session count",
        description:
          "Returns the current number of active interactive sessions, " +
          "optionally scoped to a single repo URL. Used for header " +
          "indicator badges in the web UI.",
        tags: ["Sessions"],
        querystring: activeCountQuerySchema,
        response: {
          200: ActiveCountResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { repoUrl } = req.query;
      const count = await sessionService.getActiveSessionCount(repoUrl);
      reply.send({ count });
    },
  );

  app.get(
    "/api/sessions/:id",
    {
      schema: {
        operationId: "getSession",
        summary: "Get an interactive session",
        description:
          "Fetch a single session by ID plus the repo-configured Claude " +
          "model (used by the web UI model picker). Returns 404 if the " +
          "session does not exist or does not belong to the current user.",
        tags: ["Sessions"],
        params: IdParamsSchema,
        response: {
          200: SessionDetailResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const session = await sessionService.getSession(id);
      if (!session) return reply.status(404).send({ error: "Session not found" });

      if (req.user?.id && session.userId && session.userId !== req.user.id) {
        return reply.status(404).send({ error: "Session not found" });
      }

      let modelConfig: { claudeModel: string; availableModels: string[] } | null = null;
      try {
        const [repoConfig] = await db
          .select()
          .from(repos)
          .where(eq(repos.repoUrl, session.repoUrl));
        modelConfig = {
          claudeModel: repoConfig?.claudeModel ?? "sonnet",
          availableModels: ["haiku", "sonnet", "opus"],
        };
      } catch {
        // Non-critical
      }

      reply.send({ session, modelConfig });
    },
  );

  app.post(
    "/api/sessions",
    {
      schema: {
        operationId: "createSession",
        summary: "Create an interactive session",
        description:
          "Provision a new interactive session for the given repository. " +
          "The session is created in `active` state; the worker then spins " +
          "up the pod asynchronously.",
        tags: ["Sessions"],
        body: createSessionSchema,
        response: {
          201: SessionResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const input = req.body;
      const userId = req.user?.id;
      const session = await sessionService.createSession({
        repoUrl: input.repoUrl,
        userId,
        workspaceId: req.user?.workspaceId ?? null,
      });
      logAction({
        userId: req.user?.id,
        action: "session.create",
        params: { repoUrl: input.repoUrl },
        result: { id: session.id },
        success: true,
      }).catch(() => {});
      reply.status(201).send({ session });
    },
  );

  app.post(
    "/api/sessions/:id/end",
    {
      schema: {
        operationId: "endSession",
        summary: "End an interactive session",
        description:
          "Terminate a session. The session is marked `ended` and the " +
          "backing pod is torn down. Returns the updated session record.",
        tags: ["Sessions"],
        params: IdParamsSchema,
        response: {
          200: SessionResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const session = await sessionService.getSession(id);
      if (!session) return reply.status(404).send({ error: "Session not found" });

      if (req.user?.id && session.userId && session.userId !== req.user.id) {
        return reply.status(404).send({ error: "Session not found" });
      }

      try {
        const updated = await sessionService.endSession(id);
        logAction({
          userId: req.user?.id,
          action: "session.end",
          params: { sessionId: id },
          result: { id },
          success: true,
        }).catch(() => {});
        reply.send({ session: updated });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get(
    "/api/sessions/:id/prs",
    {
      schema: {
        operationId: "listSessionPrs",
        summary: "List PRs opened during a session",
        description: "Return all PRs recorded against a session, chronological.",
        tags: ["Sessions"],
        params: IdParamsSchema,
        response: {
          200: SessionPrListResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const session = await sessionService.getSession(id);
      if (!session) return reply.status(404).send({ error: "Session not found" });

      if (req.user?.id && session.userId && session.userId !== req.user.id) {
        return reply.status(404).send({ error: "Session not found" });
      }

      const prs = await sessionService.getSessionPrs(id);
      reply.send({ prs });
    },
  );

  app.post(
    "/api/sessions/:id/prs",
    {
      schema: {
        operationId: "addSessionPr",
        summary: "Attach a PR to a session",
        description:
          "Record a pull request against a session so the session knows " +
          "which PRs it has produced. Called by the web UI after the " +
          "agent opens a PR during a session.",
        tags: ["Sessions"],
        params: IdParamsSchema,
        body: addSessionPrSchema,
        response: {
          201: SessionPrResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const session = await sessionService.getSession(id);
      if (!session) return reply.status(404).send({ error: "Session not found" });

      if (req.user?.id && session.userId && session.userId !== req.user.id) {
        return reply.status(404).send({ error: "Session not found" });
      }

      const body = req.body;
      const pr = await sessionService.addSessionPr(id, body.prUrl, body.prNumber);
      reply.status(201).send({ pr });
    },
  );
}
