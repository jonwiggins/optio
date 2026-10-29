import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { MAX_WORK_LINK_STATUS_URLS } from "@optio/shared";
import { getWorkLinkStatuses } from "../services/work-link-status-service.js";

const WorkLinkStatusSchema = z
  .object({
    url: z.string(),
    state: z
      .enum(["draft", "open", "merged", "closed", "in_progress", "done", "canceled"])
      .nullable()
      .describe("null when the host could not be asked (no token, no access, no provider)"),
    checks: z.enum(["none", "pending", "passing", "failing"]).optional(),
    review: z.enum(["none", "approved", "changes_requested"]).optional(),
  })
  .describe("Where a PR / ticket stands at its host");

const QuerySchema = z.object({
  url: z
    .union([z.string().url(), z.array(z.string().url()).max(MAX_WORK_LINK_STATUS_URLS)])
    .describe("PR / ticket URL(s); repeat the parameter for several"),
});

/** Rate limit: a rail of sessions refreshes once a minute per viewer. */
const RATE_LIMIT = { max: 120, timeWindow: "1 minute" };

export async function workLinkRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/work-links/status",
    {
      config: { rateLimit: RATE_LIMIT },
      schema: {
        operationId: "getWorkLinkStatuses",
        summary: "Where the PRs / tickets a session's badges name stand",
        description:
          "Looks each URL up at its host (GitHub / GitLab with the caller's token, " +
          "Linear / Jira through the workspace's ticket provider), cached for about " +
          "a minute. URLs that name no PR / ticket are left out of the answer.",
        tags: ["Optio Local"],
        querystring: QuerySchema,
        response: { 200: z.object({ statuses: z.array(WorkLinkStatusSchema) }) },
      },
    },
    async (req, reply) => {
      const urls = Array.isArray(req.query.url) ? req.query.url : [req.query.url];
      const statuses = await getWorkLinkStatuses(urls, {
        userId: req.user?.id ?? null,
        workspaceId: req.user?.workspaceId ?? null,
      });
      reply.send({ statuses });
    },
  );
}
