import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { retrieveSecret, storeSecret } from "../services/secret-service.js";
import { isGitHubAppConfigured } from "../services/github-app-service.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { ErrorResponseSchema } from "../schemas/common.js";

const rotateTokenSchema = z
  .object({
    token: z.string().min(1).describe("New GitHub personal access token"),
  })
  .describe("Body for rotating the stored GITHUB_TOKEN secret");

const GitHubTokenStatusResponseSchema = z
  .object({
    status: z.string().describe("`valid` | `missing` | `expired` | `error`"),
    source: z.string().optional().describe("`github_app` | `pat`"),
    message: z.string().optional(),
    error: z.string().optional(),
    user: z.object({ login: z.string(), name: z.string() }).optional(),
  })
  .describe("Stored GitHub token status + authenticated user info");

const GitHubTokenRotateResponseSchema = z
  .object({
    success: z.boolean(),
    user: z.object({ login: z.string(), name: z.string() }).optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  })
  .describe("Result of rotating the stored GitHub token");

/** Rate limit: 10 requests per minute per IP. */
const RATE_LIMIT = {
  max: 10,
  timeWindow: "1 minute",
};

const requireAdminWhenAuthenticated = async (req: FastifyRequest, reply: FastifyReply) => {
  if (isAuthDisabled()) return;
  if (!req.user) return;
  if (req.user.workspaceRole !== "admin") {
    return reply.status(403).send({ error: "Admin role required" });
  }
};

export async function githubTokenRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/github-token/status",
    {
      config: { rateLimit: RATE_LIMIT },
      schema: {
        operationId: "getGitHubTokenStatus",
        summary: "Check stored GitHub token status",
        description:
          "Validate the stored GITHUB_TOKEN secret against the GitHub API. " +
          "Returns `missing` / `valid` / `expired` / `error`. If no PAT is " +
          "stored but a GitHub App is configured, reports the App as the source.",
        tags: ["Auth & Sessions"],
        response: { 200: GitHubTokenStatusResponseSchema },
      },
    },
    async (_req, reply) => {
      let token: string | null = null;
      try {
        token = await retrieveSecret("GITHUB_TOKEN");
      } catch {
        /* no token stored */
      }

      if (!token) {
        if (isGitHubAppConfigured()) {
          return reply.send({
            status: "valid",
            source: "github_app",
            message: "GitHub App integration is configured. No PAT required.",
          });
        }
        return reply.send({
          status: "missing",
          message:
            "No GitHub token configured. PR watching, issue sync, and repo detection will not work.",
        });
      }

      try {
        const res = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token}`, "User-Agent": "Optio" },
        });

        if (res.ok) {
          const user = (await res.json()) as { login: string; name: string };
          return reply.send({
            status: "valid",
            source: "pat",
            user: { login: user.login, name: user.name },
          });
        }

        return reply.send({
          status: "expired",
          source: "pat",
          error: `GitHub returned ${res.status} — token may be expired or revoked`,
          message:
            "Replace your GitHub token to restore PR watching, issue sync, and repo detection.",
        });
      } catch (err) {
        app.log.error(err, "GitHub token validation failed");
        return reply.send({
          status: "error",
          source: "pat",
          error: "Could not reach GitHub API to validate token",
        });
      }
    },
  );

  app.post(
    "/api/github-token/rotate",
    {
      config: { rateLimit: RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
      schema: {
        operationId: "rotateGitHubToken",
        summary: "Rotate the stored GitHub token",
        description:
          "Validate a new GitHub personal access token against the GitHub API " +
          "and replace the stored GITHUB_TOKEN secret. If validation fails, " +
          "the existing token is NOT replaced. Rate limited to 10/minute per IP. " +
          "Requires admin role post-setup.",
        tags: ["Auth & Sessions"],
        body: rotateTokenSchema,
        response: {
          200: GitHubTokenRotateResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { token } = req.body;

      try {
        const res = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token.trim()}`, "User-Agent": "Optio" },
        });

        if (!res.ok) {
          return reply.send({
            success: false,
            error: `GitHub returned ${res.status} — token is invalid or expired`,
          });
        }

        const user = (await res.json()) as { login: string; name: string };

        await storeSecret("GITHUB_TOKEN", token.trim(), "global", req.user?.workspaceId);

        return reply.send({
          success: true,
          user: { login: user.login, name: user.name },
          message: "GitHub token replaced successfully. PR watching and issue sync will resume.",
        });
      } catch (err) {
        app.log.error(err, "GitHub token rotation failed");
        return reply.send({
          success: false,
          error: "Could not validate token — GitHub API may be unreachable",
        });
      }
    },
  );
}
