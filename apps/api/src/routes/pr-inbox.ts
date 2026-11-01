import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { PR_AGENT_ACTIONS } from "@optio/shared";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import * as prInbox from "../services/pr-inbox-service.js";
import { workActor } from "../services/work-ownership.js";
import { logAction } from "../services/optio-action-service.js";
import { settingsUserId } from "./work-defaults.js";

/**
 * The pull-request panel: open PRs across the workspace's repositories, each
 * with the next action for the person asking (see services/pr-inbox-service.ts).
 */

const InboxQuerySchema = z
  .object({
    refresh: z
      .enum(["true", "false"])
      .optional()
      .describe("Re-read the platforms now (anything older than 10s)"),
    repoId: z.string().uuid().optional().describe("Only this repository"),
  })
  .describe("Pull-request panel query");

// The rows are built by the shared types (`PrInboxResponse`); the schema
// documents the envelope and lets the rows through as they are.
const InboxResponseSchema = z
  .object({
    viewer: z
      .object({
        handles: z.array(z.string()).describe("The viewer's handles on the git platforms"),
        source: z.enum(["linked", "sign-in", "none"]).describe("Where the handles came from"),
        suggestedHandle: z
          .string()
          .nullable()
          .describe("A guess (the deployment token's account) when no handle is set"),
      })
      .describe("Who the actions are for"),
    items: z
      .array(z.record(z.unknown()))
      .describe("PRs: `facts`, derived `status`, `repo`, `agent`, `optioReview`"),
    errors: z
      .array(z.object({ repo: z.string(), message: z.string() }))
      .describe("Repositories that couldn't be read"),
    fetchedAt: z.string(),
  })
  .describe("The pull-request panel");

const HandlesBodySchema = z
  .object({
    github: z.string().max(100).nullable().optional().describe("GitHub login (null clears)"),
    gitlab: z.string().max(100).nullable().optional().describe("GitLab username (null clears)"),
  })
  .describe("The viewer's git handles");

const HandlesResponseSchema = z
  .object({
    handles: z.array(z.string()),
    source: z.enum(["linked", "sign-in", "none"]),
  })
  .describe("The viewer's handles after the change");

const AgentBodySchema = z
  .object({
    prUrl: z.string().min(1).max(2000).describe("The PR / MR URL"),
    action: z.enum(PR_AGENT_ACTIONS as [string, ...string[]]).describe("What to ask the agent"),
    agentType: z.string().max(40).optional().describe("Agent for a new task (default: the repo's)"),
  })
  .describe("Send a PR to an agent");

const AgentResponseSchema = z
  .object({
    taskId: z.string(),
    mode: z.enum(["resumed", "restarted", "created"]).describe("What happened to the task"),
  })
  .describe("The task that took it");

export async function prInboxRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/pr-inbox",
    {
      schema: {
        operationId: "getPrInbox",
        summary: "Open PRs with the next action for you",
        description:
          "Every open PR / MR in the workspace's repositories, with its checks, " +
          "reviews, threads and merge state, and one derived next action for the " +
          "caller (`status`: Fix CI, Review, Merge, …, and whose move it is), plus " +
          "the Optio task working on it and Optio's own review.",
        tags: ["Reviews & PRs"],
        querystring: InboxQuerySchema,
        response: { 200: InboxResponseSchema },
      },
    },
    async (req, reply) => {
      const result = await prInbox.getPrInbox({
        workspaceId: req.user?.workspaceId ?? null,
        userId: await settingsUserId(req),
        refresh: req.query.refresh === "true",
        repoId: req.query.repoId,
      });
      reply.send(result as unknown as z.infer<typeof InboxResponseSchema>);
    },
  );

  app.put(
    "/api/pr-inbox/handles",
    {
      schema: {
        operationId: "setPrInboxHandles",
        summary: "Link your git handles",
        description:
          "Who you are on GitHub / GitLab, for the pull-request panel. Overrides the " +
          "handle your sign-in gave (for Google / OIDC / LDAP accounts, the only one).",
        tags: ["Reviews & PRs"],
        body: HandlesBodySchema,
        response: {
          200: HandlesResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = await settingsUserId(req);
      if (!userId) return reply.status(404).send({ error: "Not signed in" });
      try {
        reply.send(await prInbox.setViewerHandles(userId, req.body));
      } catch (err) {
        if (err instanceof prInbox.PrInboxError) {
          return reply.status(err.status as 400 | 404).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.post(
    "/api/pr-inbox/agent",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "sendPrToAgent",
        summary: "Send a PR to an agent",
        description:
          "Ask an agent to fix CI, address review, resolve conflicts, update the branch " +
          "or answer comments on an open PR. The Optio task that owns the PR resumes " +
          "(or restarts on its branch); otherwise a new Repo Task works on the PR's own " +
          "branch and tracks the PR. Requires `member` role.",
        tags: ["Reviews & PRs"],
        body: AgentBodySchema,
        response: {
          201: AgentResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await prInbox.sendPrToAgent({
          prUrl: req.body.prUrl,
          action: req.body.action as (typeof PR_AGENT_ACTIONS)[number],
          actor: workActor(req),
          agentType: req.body.agentType,
        });
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "pr_inbox.send_to_agent",
          params: { prUrl: req.body.prUrl, action: req.body.action },
          result,
          success: true,
        }).catch(() => {});
        reply.status(201).send(result);
      } catch (err) {
        if (err instanceof prInbox.PrInboxError) {
          return reply.status(err.status as 400 | 403 | 404 | 409).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
