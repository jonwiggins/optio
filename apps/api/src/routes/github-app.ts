import type { FastifyInstance } from "fastify";
import { getGitHubToken } from "../services/github-token-service.js";
import { isGitHubAppConfigured } from "../services/github-app-service.js";

export async function buildCredentialResponse(taskId: string): Promise<{ token: string }> {
  const token = await getGitHubToken({ taskId });
  return { token };
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
  app.get<{ Querystring: { taskId?: string } }>(
    "/api/internal/git-credentials",
    async (req, reply) => {
      const { taskId } = req.query;
      if (!taskId) {
        return reply.status(400).send({ error: "taskId query parameter is required" });
      }

      try {
        const result = await buildCredentialResponse(taskId);
        return reply.send(result);
      } catch (err) {
        app.log.error(err, "Failed to get git credentials for task %s", taskId);
        return reply.status(500).send({ error: "Failed to retrieve git credentials" });
      }
    },
  );

  app.get("/api/github-app/status", async (_req, reply) => {
    return reply.send(buildStatusResponse());
  });
}
