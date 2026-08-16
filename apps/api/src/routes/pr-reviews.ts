/**
 * PR Review HTTP surface.
 *
 * The canonical endpoints live under /api/pr-reviews and operate on
 * `pr_reviews` rows. Legacy /api/tasks/:id/review-draft* endpoints are
 * kept as thin aliases that look up the pr_review by id (since pr_review
 * ids are globally unique across all Task-like resources).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireRole } from "../plugins/auth.js";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { taskLogs } from "../db/schema.js";
import * as prReviewService from "../services/pr-review-service.js";
import { logger } from "../logger.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { PullRequestSummarySchema, PrStatusSchema, MergeResultSchema } from "../schemas/session.js";

const listPrsQuerySchema = z
  .object({
    repoId: z.string().optional().describe("Optionally filter by repo ID"),
  })
  .describe("Query parameters for listing open PRs");

const createReviewSchema = z
  .object({
    prUrl: z.string().min(1).describe("URL of the PR to review"),
  })
  .describe("Body for launching a PR review");

const updateReviewSchema = z
  .object({
    summary: z.string().nullable().optional().describe("Top-level review summary"),
    verdict: z
      .enum(["approve", "request_changes", "comment"])
      .nullable()
      .optional()
      .describe("Review verdict"),
    fileComments: z
      .array(
        z
          .object({
            path: z.string(),
            line: z.number().optional(),
            side: z.string().optional(),
            body: z.string(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .describe("Partial update to a review draft");

const mergePrSchema = z
  .object({
    prUrl: z.string().min(1),
    mergeMethod: z.enum(["merge", "squash", "rebase"]).describe("Merge strategy"),
  })
  .describe("Body for merging a PR");

const reviewChatBodySchema = z
  .object({
    message: z.string().min(1).describe("User's chat message to the review agent"),
  })
  .describe("Body for posting a review chat turn");

const PrReviewSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().nullable(),
    prUrl: z.string(),
    prNumber: z.number().int(),
    repoOwner: z.string(),
    repoName: z.string(),
    repoUrl: z.string(),
    headSha: z.string(),
    state: z.string(),
    verdict: z.string().nullable(),
    summary: z.string().nullable(),
    fileComments: z.array(z.record(z.unknown())).nullable(),
    origin: z.string(),
    userEngaged: z.boolean(),
    autoSubmitted: z.boolean(),
    submittedAt: z.union([z.date(), z.string()]).nullable(),
    errorMessage: z.string().nullable(),
    createdBy: z.string().nullable(),
    controlIntent: z.string().nullable(),
    createdAt: z.union([z.date(), z.string()]),
    updatedAt: z.union([z.date(), z.string()]),
  })
  .passthrough()
  .describe("Canonical PR review record");

const PrReviewRunSchema = z
  .object({
    id: z.string(),
    prReviewId: z.string(),
    kind: z.string(),
    state: z.string(),
    prompt: z.string().nullable(),
    sessionId: z.string().nullable(),
    resultSummary: z.string().nullable(),
    errorMessage: z.string().nullable(),
    costUsd: z.string().nullable(),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    modelUsed: z.string().nullable(),
    startedAt: z.union([z.date(), z.string()]).nullable(),
    completedAt: z.union([z.date(), z.string()]).nullable(),
    createdAt: z.union([z.date(), z.string()]),
    updatedAt: z.union([z.date(), z.string()]),
  })
  .passthrough()
  .describe("A single agent execution against a PR review");

const ReviewChatMessageSchema = z
  .object({
    id: z.string(),
    prReviewId: z.string(),
    runId: z.string().nullable().optional(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    createdAt: z.union([z.string(), z.date()]),
  })
  .describe("A single message in a review chat thread");

const ReviewChatListResponseSchema = z
  .object({ messages: z.array(ReviewChatMessageSchema) })
  .describe("Review chat messages");

const prStatusQuerySchema = z
  .object({ prUrl: z.string().min(1).describe("PR URL to fetch status for") })
  .describe("Query parameters for PR status");

const PullRequestListResponseSchema = z
  .object({ pullRequests: z.array(PullRequestSummarySchema) })
  .describe("All open PRs across configured repos");

const PrReviewResponseSchema = z.object({ review: PrReviewSchema }).describe("PR review envelope");

const PrReviewListResponseSchema = z
  .object({ reviews: z.array(PrReviewSchema) })
  .describe("List of PR reviews");

const PrReviewRunsResponseSchema = z
  .object({ runs: z.array(PrReviewRunSchema) })
  .describe("Runs under a PR review");

const GenericResultSchema = z
  .record(z.unknown())
  .describe("Operation result — shape depends on the endpoint");

export async function prReviewRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  // ── List open PRs (for the /reviews list page) ────────────────────────
  app.get(
    "/api/pull-requests",
    {
      schema: {
        operationId: "listOpenPullRequests",
        summary: "List open PRs from configured repos",
        description:
          "Return open pull requests across configured repositories in the " +
          "current workspace, optionally filtered by `repoId`. Used by the " +
          "PR review UI.",
        tags: ["Reviews & PRs"],
        querystring: listPrsQuerySchema,
        response: { 200: PullRequestListResponseSchema },
      },
    },
    async (req, reply) => {
      const pullRequests = await prReviewService.listOpenPrs(
        req.user?.workspaceId ?? undefined,
        req.query.repoId,
      );
      // Cast: the service returns a strongly-typed PullRequestSummary[] but
      // the Zod schema uses passthrough, which confuses inference.

      reply.send({ pullRequests: pullRequests as any });
    },
  );

  // ── Launch a review (create pr_reviews + queue initial run) ───────────
  app.post(
    "/api/pr-reviews",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createPrReview",
        summary: "Launch a PR review",
        description:
          "Create a `pr_reviews` record for the given PR and queue the " +
          "initial review run. Requires `member` role.",
        tags: ["Reviews & PRs"],
        body: createReviewSchema,
        response: { 201: GenericResultSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const result = await prReviewService.launchPrReview({
          prUrl: req.body.prUrl,
          workspaceId: req.user?.workspaceId ?? undefined,
          createdBy: req.user?.id,
          origin: "manual",
        });
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "pr_review.launch",
          params: { prUrl: req.body.prUrl },
          result: result as Record<string, unknown>,
          success: true,
        }).catch(() => {});
        reply.status(201).send(result);
      } catch (err: unknown) {
        logger.warn({ err, prUrl: req.body.prUrl }, "Failed to launch PR review");
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ── Get a single review ──────────────────────────────────────────────
  app.get(
    "/api/pr-reviews/:id",
    {
      schema: {
        operationId: "getPrReview",
        summary: "Get a PR review by id",
        tags: ["Reviews & PRs"],
        params: IdParamsSchema,
        response: { 200: PrReviewResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const review = await prReviewService.getPrReview(req.params.id);
      if (!review) return reply.status(404).send({ error: "PR review not found" });
      reply.send({ review });
    },
  );

  // ── List runs under a review ─────────────────────────────────────────
  app.get(
    "/api/pr-reviews/:id/runs",
    {
      schema: {
        operationId: "listPrReviewRuns",
        summary: "List agent runs for a PR review",
        tags: ["Reviews & PRs"],
        params: IdParamsSchema,
        response: { 200: PrReviewRunsResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const review = await prReviewService.getPrReview(req.params.id);
      if (!review) return reply.status(404).send({ error: "PR review not found" });
      const runs = await prReviewService.listPrReviewRuns(review.id);
      reply.send({ runs });
    },
  );

  // ── Update draft fields (summary/verdict/fileComments) ───────────────
  app.patch(
    "/api/pr-reviews/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "updatePrReview",
        summary: "Update a PR review draft",
        description:
          "Edit the summary, verdict, or inline comments on a review before " +
          "submission. Flags `userEngaged` so automatic re-reviews stop. " +
          "Requires `member` role.",
        tags: ["Reviews & PRs"],
        params: IdParamsSchema,
        body: updateReviewSchema,
        response: {
          200: PrReviewResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const review = await prReviewService.updatePrReviewDraft(req.params.id, req.body);
        reply.send({ review });
      } catch (err: unknown) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ── Submit review to the git platform ────────────────────────────────
  app.post(
    "/api/pr-reviews/:id/submit",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "submitPrReview",
        summary: "Submit a PR review to the git platform",
        tags: ["Reviews & PRs"],
        params: IdParamsSchema,
        response: {
          200: GenericResultSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await prReviewService.submitReview(req.params.id, req.user?.id);
        reply.send(result);
      } catch (err: unknown) {
        logger.warn({ err, prReviewId: req.params.id }, "Failed to submit PR review");
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ── Re-review (spawn fresh run) ──────────────────────────────────────
  app.post(
    "/api/pr-reviews/:id/re-review",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "reReviewPr",
        summary: "Launch a fresh review run on the same PR",
        tags: ["Reviews & PRs"],
        params: IdParamsSchema,
        response: { 201: GenericResultSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const result = await prReviewService.reReview(req.params.id, req.user?.id);
        reply.status(201).send(result);
      } catch (err: unknown) {
        logger.warn({ err, prReviewId: req.params.id }, "Failed to re-review PR");
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ── Cancel ───────────────────────────────────────────────────────────
  app.post(
    "/api/pr-reviews/:id/cancel",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "cancelPrReview",
        summary: "Cancel a PR review",
        tags: ["Reviews & PRs"],
        params: IdParamsSchema,
        response: { 200: GenericResultSchema },
      },
    },
    async (req, reply) => {
      await prReviewService.setControlIntent(req.params.id, "cancel");
      reply.send({ ok: true });
    },
  );

  // ── Chat ─────────────────────────────────────────────────────────────
  app.get(
    "/api/pr-reviews/:id/chat",
    {
      schema: {
        operationId: "listPrReviewChat",
        summary: "List chat messages for a PR review",
        tags: ["Reviews & PRs"],
        params: IdParamsSchema,
        response: { 200: ReviewChatListResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const review = await prReviewService.getPrReview(req.params.id);
      if (!review) return reply.status(404).send({ error: "PR review not found" });
      const messages = await prReviewService.listReviewChat(review.id);
      reply.send({ messages });
    },
  );

  app.post(
    "/api/pr-reviews/:id/chat",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "postPrReviewChat",
        summary: "Post a chat message to the review agent",
        tags: ["Reviews & PRs"],
        params: IdParamsSchema,
        body: reviewChatBodySchema,
        response: {
          201: GenericResultSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await prReviewService.postReviewChat({
          prReviewId: req.params.id,
          message: req.body.message,
          userId: req.user?.id,
        });
        reply.status(201).send(result);
      } catch (err: unknown) {
        logger.warn({ err, prReviewId: req.params.id }, "Failed to post review chat");
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ── Merge PR (passthrough to git platform) ───────────────────────────
  app.post(
    "/api/pull-requests/merge",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "mergePullRequest",
        summary: "Merge a pull request",
        tags: ["Reviews & PRs"],
        body: mergePrSchema,
        response: { 200: MergeResultSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const result = await prReviewService.mergePr({
          prUrl: req.body.prUrl,
          mergeMethod: req.body.mergeMethod,
          userId: req.user?.id,
        });
        reply.send(result);
      } catch (err: unknown) {
        logger.warn({ err, prUrl: req.body.prUrl }, "Failed to merge PR");
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get(
    "/api/pull-requests/status",
    {
      schema: {
        operationId: "getPullRequestStatus",
        summary: "Get CI + review status for a PR",
        tags: ["Reviews & PRs"],
        querystring: prStatusQuerySchema,
        response: { 200: PrStatusSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const status = await prReviewService.getPrStatus(req.query.prUrl);
        reply.send(status);
      } catch (err: unknown) {
        logger.warn({ err, prUrl: req.query.prUrl }, "Failed to get PR status");
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ── Run logs ────────────────────────────────────────────────────────
  app.get(
    "/api/pr-reviews/:id/logs",
    {
      schema: {
        operationId: "listPrReviewLogs",
        summary: "List agent logs for the latest run of a PR review",
        description:
          "Returns log rows from task_logs keyed by pr_review_run_id. By " +
          "default returns logs for the most recent run; pass ?runId= to " +
          "target a specific historical run.",
        tags: ["Reviews & PRs"],
        params: IdParamsSchema,
        querystring: z.object({ runId: z.string().optional() }),
        response: { 200: GenericResultSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const review = await prReviewService.getPrReview(req.params.id);
      if (!review) return reply.status(404).send({ error: "PR review not found" });
      let runId = req.query.runId;
      if (!runId) {
        const latest = await prReviewService.getLatestRun(review.id);
        if (!latest) return reply.send({ logs: [] });
        runId = latest.id;
      }
      const rows = await db
        .select()
        .from(taskLogs)
        .where(eq(taskLogs.prReviewRunId, runId))
        .orderBy(taskLogs.timestamp);
      reply.send({ logs: rows, runId });
    },
  );

  // ── Legacy aliases (back-compat for /api/tasks/:id/review-draft*) ────
  // These now resolve by pr_review id (since we no longer keep a
  // pr_review task in the tasks table). A caller passing the old review
  // task id will get a 404 — the new /api/pr-reviews/:id is canonical.
  app.get(
    "/api/tasks/:id/review-draft",
    {
      schema: {
        operationId: "getReviewDraft",
        summary: "[Legacy] Get the review draft for a PR review id",
        tags: ["Reviews & PRs"],
        params: IdParamsSchema,
        response: { 200: GenericResultSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const review = await prReviewService.getPrReview(req.params.id);
      if (!review) return reply.status(404).send({ error: "No review draft found" });
      reply.send({ draft: review });
    },
  );

  void PrReviewListResponseSchema;
}
