import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getGitHubToken } from "../services/github-token-service.js";
import { isGitHubAppConfigured } from "../services/github-app-service.js";

// Shared secret for pod-to-API credential requests.
// Generated at API startup, injected into pods via OPTIO_CREDENTIAL_SECRET env var.
const CREDENTIAL_SECRET = process.env.OPTIO_CREDENTIAL_SECRET ?? randomBytes(32).toString("hex");

export function getCredentialSecret(): string {
  return CREDENTIAL_SECRET;
}

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

export default async function githubAppRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Internal endpoint — called by credential helpers in agent pods.
   * With taskId: returns the task creator's user token (for task-scoped operations).
   * Without taskId: returns an installation token (for pod-level operations like clone).
   */
  app.get<{ Querystring: { taskId?: string } }>(
    "/api/internal/git-credentials",
    async (req, reply) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${CREDENTIAL_SECRET}`) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      try {
        const { taskId } = req.query;
        const token = taskId
          ? await getGitHubToken({ taskId })
          : await getGitHubToken({ server: true });
        return reply.send({ token });
      } catch (err) {
        app.log.error(err, "Failed to get git credentials");
        return reply.status(500).send({ error: "Failed to retrieve git credentials" });
      }
    },
  );

  app.get("/api/github-app/status", async (_req, reply) => {
    return reply.send(buildStatusResponse());
  });
}
