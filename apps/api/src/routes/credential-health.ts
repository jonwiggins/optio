import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { isDeploymentAdmin } from "../services/sign-in-config-service.js";
import { checkMine, checkIntervalMs } from "../services/credential-health/run.js";
import { listChecks, toView, type HealthViewer } from "../services/credential-health/store.js";

/**
 * Credential health (docs/credential-health.md;
 * services/credential-health/): what the last check found about the tokens
 * the viewer looks after (Settings → My tokens), and "Check now" for their
 * own. Rows say what was found, never a token.
 */

const CheckSchema = z.object({
  key: z.string(),
  kind: z.enum(["gateway", "gitlab"]),
  label: z.string(),
  scope: z.enum(["person", "organization"]),
  status: z.enum(["ok", "warning", "error", "unknown"]),
  reason: z.string().nullable(),
  expiresAt: z.string().nullable(),
  checkedAt: z.string(),
  details: z.record(z.string(), z.unknown()),
});

async function viewerOf(req: FastifyRequest): Promise<HealthViewer> {
  const user = req.user;
  return {
    userId: user?.id ?? null,
    workspaceId: user?.workspaceId ?? null,
    isWorkspaceAdmin: isAuthDisabled() || user?.workspaceRole === "admin",
    deploymentAdmin: isAuthDisabled() || (!!user && (await isDeploymentAdmin(user))),
  };
}

export async function credentialHealthRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const tags = ["Setup & Settings"];

  app.get(
    "/api/credential-health",
    {
      schema: {
        operationId: "listCredentialHealth",
        summary: "The health of the tokens the viewer looks after",
        description:
          "Their own gateway and GitLab tokens; for a workspace admin also the workspace's " +
          "(its gateways' tokens, a GitLab token stored for it); for a deployment admin also the " +
          "deployment-wide ones. Worst first. Each row: status, reason, expiry, what the check " +
          "read (host, scopes, budget), when. Never a token.",
        tags,
        response: {
          200: z.object({ checks: z.array(CheckSchema), intervalMinutes: z.number() }),
        },
      },
    },
    async (req, reply) => {
      const rows = await listChecks(await viewerOf(req));
      return reply.send({
        checks: rows.map(toView),
        intervalMinutes: Math.round(checkIntervalMs() / 60_000),
      });
    },
  );

  app.post(
    "/api/credential-health/me/check",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "checkMyCredentials",
        summary: "Check my tokens now",
        description:
          "Checks the viewer's own gateway and GitLab tokens at once (a token checked in the " +
          "last minute keeps its result) and answers what was found.",
        tags,
        response: { 200: z.object({ checks: z.array(CheckSchema) }), 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Sign in first" });
      const rows = await checkMine(req.user.id);
      return reply.send({ checks: rows.map(toView) });
    },
  );
}
