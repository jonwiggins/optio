import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireRole } from "../plugins/auth.js";
import * as prReviewService from "../services/pr-review-service.js";
import { logger } from "../logger.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import {
  ReviewDraftSchema,
  PullRequestSummarySchema,
  PrStatusSchema,
  MergeResultSchema,
} from "../schemas/session.js";

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

const updateDraftSchema = z
  .object({
    summary: z.string().optional().describe("Top-level review summary"),
    verdict: z.string().optional().describe("`approve` | `request_changes` | `comment`"),
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
      .optional(),
  })
  .describe("Partial update to a review draft");

const mergePrSchema = z
  .object({
    prUrl: z.string().min(1),
    mergeMethod: z.enum(["merge", "squash", "rebase"]).describe("GitHub/GitLab merge strategy"),
  })
  .describe("Body for merging a PR");

const prStatusQuerySchema = z
  .object({
    prUrl: z.string().min(1).describe("PR URL to fetch status for"),
  })
  .describe("Query parameters for PR status");

const PullRequestListResponseSchema = z
  .object({
    pullRequests: z.array(PullRequestSummarySchema),
  })
  .describe("All open PRs across configured repos");

const ReviewDraftResponseSchema = z
  .object({
    draft: ReviewDraftSchema,
  })
  .describe("Review draft envelope");

const GenericResultSchema = z
  .record(z.unknown())
  .describe("Operation result — shape depends on the specific endpoint");

export async function prReviewRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/pull-requests",
    {
      schema: {
        operationId: "listOpenPullRequests",
        summary: "List open PRs from configured repos",
        description:
          "Return all open pull requests across configured repositories " +
          "in the current workspace, optionally filtered by `repoId`. " +
          "Used by the PR review UI.",
        tags: ["Reviews & PRs"],
        querystring: listPrsQuerySchema,
        response: {
          200: PullRequestListResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const query = req.query;
      const pullRequests = await prReviewService.listOpenPrs(
        req.user?.workspaceId ?? undefined,
        query.repoId,
      );
      reply.send({ pullRequests });
    },
  );

  app.post(
    "/api/pull-requests/review",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "launchPullRequestReview",
        summary: "Launch a PR review",
        description:
          "Create a `pr_review` task for the given PR. The review agent " +
          "runs as a normal task and stores its output as a review draft. " +
          "Requires `member` role.",
        tags: ["Reviews & PRs"],
        body: createReviewSchema,
        response: {
          201: GenericResultSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await prReviewService.launchPrReview({
          prUrl: req.body.prUrl,
          workspaceId: req.user?.workspaceId ?? undefined,
          createdBy: req.user?.id,
        });
        logAction({
          userId: req.user?.id,
          action: "review.launch",
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

  app.get(
    "/api/tasks/:id/review-draft",
    {
      schema: {
        operationId: "getReviewDraft",
        summary: "Get the review draft for a task",
        description: "Return the review draft produced by a PR review task, if any.",
        tags: ["Reviews & PRs"],
        params: IdParamsSchema,
        response: {
          200: ReviewDraftResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const draft = await prReviewService.getReviewDraft(id);
      if (!draft) return reply.status(404).send({ error: "No review draft found" });
      reply.send({ draft });
    },
  );

  app.patch(
    "/api/tasks/:id/review-draft",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "updateReviewDraft",
        summary: "Update a review draft",
        description:
          "Edit the summary, verdict, or file-level comments on a review " +
          "draft before it is submitted. Requires `member` role.",
        tags: ["Reviews & PRs"],
        params: IdParamsSchema,
        body: updateDraftSchema,
        response: {
          200: ReviewDraftResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const draft = await prReviewService.getReviewDraft(id);
      if (!draft) return reply.status(404).send({ error: "No review draft found" });

      try {
        const updated = await prReviewService.updateReviewDraft(draft.id, req.body);
        reply.send({ draft: updated });
      } catch (err: unknown) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post(
    "/api/tasks/:id/review-draft/submit",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "submitReviewDraft",
        summary: "Submit a review draft to the git platform",
        description:
          "Post the review draft to GitHub or GitLab as an actual review. " +
          "Marks the draft as `submitted`. Requires `member` role.",
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
      const { id } = req.params;
      const draft = await prReviewService.getReviewDraft(id);
      if (!draft) return reply.status(404).send({ error: "No review draft found" });

      try {
        const result = await prReviewService.submitReview(draft.id, req.user?.id);
        reply.send(result);
      } catch (err: unknown) {
        logger.warn({ err, taskId: id }, "Failed to submit review");
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post(
    "/api/tasks/:id/review-draft/re-review",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "reReviewPullRequest",
        summary: "Create a new review task for the same PR",
        description:
          "Launch a fresh review agent for the same PR after code changes. " +
          "Returns the new review task ID. Requires `member` role.",
        tags: ["Reviews & PRs"],
        params: IdParamsSchema,
        response: {
          201: GenericResultSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;

      try {
        const result = await prReviewService.reReview(
          id,
          req.user?.id,
          req.user?.workspaceId ?? undefined,
        );
        reply.status(201).send(result);
      } catch (err: unknown) {
        logger.warn({ err, taskId: id }, "Failed to re-review PR");
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post(
    "/api/pull-requests/merge",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "mergePullRequest",
        summary: "Merge a pull request",
        description:
          "Merge a PR via the git platform using the specified merge " +
          "strategy. Requires `member` role.",
        tags: ["Reviews & PRs"],
        body: mergePrSchema,
        response: {
          200: MergeResultSchema,
          400: ErrorResponseSchema,
        },
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
        description: "Fetch the aggregate CI status and review status for a PR.",
        tags: ["Reviews & PRs"],
        querystring: prStatusQuerySchema,
        response: {
          200: PrStatusSchema,
          400: ErrorResponseSchema,
        },
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
}
