import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponseSchema } from "../schemas/common.js";
import { actorOf } from "../services/ownership.js";
import { requesterIsDeploymentAdmin } from "../services/deployment-admin-gates.js";
import {
  checkCredentialNow,
  checkMyCredentials,
  credentialHealthTick,
  lastCheckedAt,
  listChecks,
  toViews,
  type HealthViewer,
} from "../services/credential-health.js";
import { logger } from "../logger.js";

/**
 * Credential health (docs/credential-health.md): Settings → System health
 * and the caller's own rows on Settings → My tokens.
 *
 * - `GET /api/credential-health[?mine=true]` — the rows the caller may see
 *   (services/credential-health/store.ts): a deployment admin every
 *   credential; a team admin their teams'; a workspace admin their
 *   workspace's organization Jira and remote-workspace connections; everyone their own.
 * - `POST /api/credential-health/check` — Check now, on one credential the
 *   caller may see (also one no pass has recorded yet).
 * - `POST /api/credential-health/check-mine` — Check now, on all of the
 *   caller's own (Settings → My tokens).
 * - `POST /api/credential-health/check-all` — a pass now (deployment admins).
 *
 * No route returns a token: a row says what a check found, never the value.
 */

const RowSchema = z.object({
  key: z.string().describe("What the credential is, e.g. gitlab:org, gateway:<id>:user:<id>"),
  kind: z.enum(["github", "gitlab", "gateway", "jira", "remote_workspace"]),
  label: z.string(),
  scope: z.enum(["organization", "team", "person"]),
  owner: z.object({
    name: z.string(),
    userId: z.string().nullable(),
    teamId: z.string().nullable(),
  }),
  status: z.enum(["ok", "warning", "error", "unknown"]),
  reason: z.string().nullable(),
  expiresAt: z.string().nullable(),
  checkedAt: z.string(),
  details: z.record(z.unknown()),
});

const ListResponseSchema = z
  .object({
    rows: z.array(RowSchema),
    canCheckAll: z.boolean().describe("The caller is a deployment admin"),
    lastCheckedAt: z.string().nullable(),
  })
  .describe("Credential health rows the caller may see, worst first");

const ListQuerySchema = z.object({
  mine: z
    .enum(["true", "false"])
    .optional()
    .describe("Only the caller's own credentials (Settings → My tokens)"),
});

const CheckBodySchema = z
  .object({ key: z.string().min(1).max(200) })
  .describe("The credential to check now");

async function viewerOf(req: FastifyRequest): Promise<HealthViewer> {
  const actor = actorOf(req);
  return {
    userId: actor.userId,
    workspaceId: actor.workspaceId,
    isWorkspaceAdmin: actor.isAdmin,
    adminTeamIds: actor.adminTeamIds ?? [],
    deploymentAdmin: await requesterIsDeploymentAdmin(req),
  };
}

export async function credentialHealthRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/credential-health",
    {
      schema: {
        operationId: "listCredentialHealth",
        summary: "Credential health",
        description:
          "What the last check found about each credential the caller may see: " +
          "status (ok / warning / error / unknown), reason, expiry and when it was checked.",
        tags: ["Setup & Settings"],
        querystring: ListQuerySchema,
        response: { 200: ListResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const viewer = await viewerOf(req);
      const rows = await listChecks(viewer, { mine: req.query.mine === "true" });
      const last = await lastCheckedAt();
      reply.send({
        rows: await toViews(rows),
        canCheckAll: viewer.deploymentAdmin,
        lastCheckedAt: last ? last.toISOString() : null,
      });
    },
  );

  app.post(
    "/api/credential-health/check",
    {
      schema: {
        operationId: "checkCredentialNow",
        summary: "Check one credential now",
        description:
          "Runs the credential's check again (and sends a warning that became due). " +
          "404 when the caller may not see it, or it is gone.",
        tags: ["Setup & Settings"],
        body: CheckBodySchema,
        response: {
          200: z.object({ row: RowSchema }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const viewer = await viewerOf(req);
      // Gone, or not the caller's to see: the same answer (no probing for keys).
      const row = await checkCredentialNow(req.body.key, viewer);
      if (!row) return reply.status(404).send({ error: "No such credential" });
      const [view] = await toViews([row]);
      reply.send({ row: view });
    },
  );

  app.post(
    "/api/credential-health/check-mine",
    {
      schema: {
        operationId: "checkMyCredentials",
        summary: "Check my own credentials now",
        description:
          "Settings → My tokens: runs the checks of every credential that is the caller's own " +
          "(their GitLab and gateway tokens, their remote-workspace and Jira connections) and returns the rows.",
        tags: ["Setup & Settings"],
        response: { 200: z.object({ rows: z.array(RowSchema) }), 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const rows = await checkMyCredentials(req.user.id);
      reply.send({ rows: await toViews(rows) });
    },
  );

  app.post(
    "/api/credential-health/check-all",
    {
      schema: {
        operationId: "checkAllCredentials",
        summary: "Check every credential now",
        description:
          "Deployment admins: starts a pass over every credential now (one at a time " +
          "across the deployment's API instances). The rows update as it goes.",
        tags: ["Setup & Settings"],
        response: {
          202: z.object({ started: z.boolean() }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      if (!(await requesterIsDeploymentAdmin(req))) {
        return reply
          .status(403)
          .send({ error: "Only a deployment admin checks every credential at once" });
      }
      void credentialHealthTick().catch((err) =>
        logger.warn({ err }, "credential health: a pass asked for by hand failed"),
      );
      reply.status(202).send({ started: true });
    },
  );
}
