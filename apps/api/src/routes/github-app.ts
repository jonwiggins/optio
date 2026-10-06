import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getGitHubToken } from "../services/github-token-service.js";
import { isGitHubAppConfigured } from "../services/github-app-service.js";
import {
  getCredentialSecret,
  resetCredentialSecret,
} from "../services/credential-secret-service.js";
import { verifyInternalRequest, verifyHmacSignature } from "../services/hmac-auth-service.js";
import { parseGitCredentialScope, gitCredentialKey } from "../services/git-credential-scope.js";
import { ErrorResponseSchema } from "../schemas/common.js";

export { getCredentialSecret, resetCredentialSecret };

export function buildStatusResponse(): {
  configured: boolean;
  appId?: string;
  installationId?: string;
} {
  if (!isGitHubAppConfigured()) {
    return { configured: false };
  }
  return {
    configured: true,
    appId: process.env.GITHUB_APP_ID,
    installationId: process.env.GITHUB_APP_INSTALLATION_ID,
  };
}

const gitCredentialsQuerySchema = z
  .object({
    scope: z.string().max(1024).optional(),
    taskId: z
      .string()
      .optional()
      .describe(
        "Optional task ID. With a taskId, returns the task creator's user token " +
          "(for task-scoped operations). Without, returns an installation token " +
          "(for pod-level operations like clone).",
      ),
  })
  .describe("Query parameters for internal git credentials endpoint");

const GitCredentialsResponseSchema = z
  .object({
    token: z.string(),
  })
  .describe("Git credential token for cloning or committing");

const GitHubAppStatusResponseSchema = z
  .object({
    configured: z.boolean(),
    appId: z.string().optional(),
    installationId: z.string().optional(),
  })
  .describe("GitHub App installation status");

export default async function githubAppRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/internal/git-credentials",
    {
      schema: {
        hide: true,
        operationId: "getGitCredentials",
        summary: "Get git credentials (internal)",
        description:
          "Internal endpoint called by credential helpers in agent pods. " +
          "Cluster-internal only — the Helm ingress blocks /api/internal/* " +
          "from public traffic. Authenticates via HMAC-SHA256 signature in " +
          "the X-Optio-Signature header. " +
          "Hidden from the public spec.",
        tags: ["Auth & Sessions"],
        querystring: gitCredentialsQuerySchema,
        response: {
          200: GitCredentialsResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const scope = req.query.scope ? parseGitCredentialScope(req.query.scope) : null;
      if (req.query.scope && !scope)
        return reply.status(401).send({ error: "Invalid credential scope" });
      // Unscoped keys once lived in every repo pod and could request any user's
      // token. Reject them by default, including after an upgrade.
      if (!scope && process.env.OPTIO_ALLOW_LEGACY_GIT_CREDENTIALS !== "1") {
        return reply
          .status(401)
          .send({ error: "Legacy credential helper disabled; recreate this pod" });
      }
      const authResult = scope
        ? verifyHmacSignature(
            String(req.headers["x-optio-signature"] ?? ""),
            req.url,
            gitCredentialKey(req.query.scope!),
          )
        : verifyInternalRequest(
            req.headers as Record<string, string | string[] | undefined>,
            req.url,
          );
      if (authResult) {
        return reply.status(authResult.status as 401).send({ error: authResult.error });
      }

      try {
        if (scope?.workspaceId && scope.ownerUserId) {
          const { getUserRole } = await import("../services/workspace-service.js");
          const role = await getUserRole(scope.workspaceId, scope.ownerUserId);
          if (role !== "admin" && role !== "member")
            return reply
              .status(401)
              .send({ error: "Credential owner no longer has workspace execution access" });
        }
        reply.header("Cache-Control", "no-store");
        const { taskId } = req.query;
        const token = scope
          ? await getGitHubToken(
              scope.ownerUserId
                ? { userId: scope.ownerUserId, workspaceId: scope.workspaceId }
                : { server: true, workspaceId: scope.workspaceId },
            )
          : taskId
            ? await getGitHubToken({ taskId })
            : await getGitHubToken({ server: true });
        return reply.send({ token });
      } catch (err) {
        app.log.error(err, "Failed to get git credentials");
        return reply.status(500).send({ error: "Failed to retrieve git credentials" });
      }
    },
  );

  app.get(
    "/api/github-app/status",
    {
      schema: {
        operationId: "getGitHubAppStatus",
        summary: "Check GitHub App configuration",
        description:
          "Return whether the GitHub App is configured at the deployment " +
          "level (via `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID` envs). " +
          "When configured, Optio can authenticate to GitHub without a PAT.",
        tags: ["Auth & Sessions"],
        response: { 200: GitHubAppStatusResponseSchema },
      },
    },
    async (_req, reply) => {
      return reply.send(buildStatusResponse());
    },
  );
}
