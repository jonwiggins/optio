import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as repoService from "../services/repo-service.js";

const createRepoSchema = z.object({
  repoUrl: z.string().min(1),
  fullName: z.string().min(1),
  defaultBranch: z.string().optional(),
  isPrivate: z.boolean().optional(),
});

const updateRepoSchema = z.object({
  imagePreset: z.string().optional(),
  extraPackages: z.string().optional(),
  setupCommands: z.string().optional(),
  customDockerfile: z.string().nullable().optional(),
  autoMerge: z.boolean().optional(),
  promptTemplateOverride: z.string().nullable().optional(),
  defaultBranch: z.string().optional(),
  claudeModel: z.string().optional(),
  claudeContextWindow: z.string().optional(),
  claudeThinking: z.boolean().optional(),
  claudeEffort: z.string().optional(),
  maxTurnsCoding: z.number().int().min(1).max(1000).optional(),
  maxTurnsReview: z.number().int().min(1).max(100).optional(),
  autoResume: z.boolean().optional(),
  maxConcurrentTasks: z.number().int().min(1).max(50).optional(),
  maxPodInstances: z.number().int().min(1).max(20).optional(),
  maxAgentsPerPod: z.number().int().min(1).max(50).optional(),
  reviewEnabled: z.boolean().optional(),
  reviewTrigger: z.string().optional(),
  reviewPromptTemplate: z.string().nullable().optional(),
  testCommand: z.string().optional(),
  reviewModel: z.string().optional(),
  maxAutoResumes: z.number().int().min(1).max(100).nullable().optional(),
  slackWebhookUrl: z.string().nullable().optional(),
  slackChannel: z.string().nullable().optional(),
  slackNotifyOn: z
    .array(z.enum(["completed", "failed", "needs_attention", "pr_opened"]))
    .optional(),
  slackEnabled: z.boolean().optional(),
});

export async function repoRoutes(app: FastifyInstance) {
  app.get("/api/repos", async (req, reply) => {
    const workspaceId = req.user?.workspaceId ?? null;
    const repos = await repoService.listRepos(workspaceId);
    reply.send({ repos });
  });

  app.get("/api/repos/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = await repoService.getRepo(id);
    if (!repo) return reply.status(404).send({ error: "Repo not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && repo.workspaceId && repo.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Repo not found" });
    }
    reply.send({ repo });
  });

  app.post("/api/repos", async (req, reply) => {
    const body = createRepoSchema.parse(req.body);
    const repo = await repoService.createRepo({
      ...body,
      workspaceId: req.user?.workspaceId ?? null,
    });

    // Auto-detect image preset and test command
    try {
      const { retrieveSecret } = await import("../services/secret-service.js");
      const { detectRepoConfig } = await import("../services/repo-detect-service.js");
      const githubToken = await retrieveSecret("GITHUB_TOKEN").catch(() => null);
      if (githubToken) {
        const detected = await detectRepoConfig(body.repoUrl, githubToken);
        if (detected.imagePreset !== "base" || detected.testCommand) {
          await repoService.updateRepo(repo.id, {
            imagePreset: detected.imagePreset,
            testCommand: detected.testCommand,
          });
        }
      }
    } catch {}

    reply.status(201).send({ repo });
  });

  app.patch("/api/repos/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await repoService.getRepo(id);
    if (!existing) return reply.status(404).send({ error: "Repo not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Repo not found" });
    }
    const body = updateRepoSchema.parse(req.body);
    const repo = await repoService.updateRepo(id, body);
    if (!repo) return reply.status(404).send({ error: "Repo not found" });
    reply.send({ repo });
  });

  app.delete("/api/repos/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await repoService.getRepo(id);
    if (!existing) return reply.status(404).send({ error: "Repo not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Repo not found" });
    }
    await repoService.deleteRepo(id);
    reply.status(204).send();
  });

  // Auto-detect repo configuration
  app.post("/api/repos/:id/detect", async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = await repoService.getRepo(id);
    if (!repo) return reply.status(404).send({ error: "Repo not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && repo.workspaceId && repo.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Repo not found" });
    }

    try {
      const { retrieveSecret } = await import("../services/secret-service.js");
      const { detectRepoConfig } = await import("../services/repo-detect-service.js");
      const githubToken = await retrieveSecret("GITHUB_TOKEN");
      const detected = await detectRepoConfig(repo.repoUrl, githubToken);
      await repoService.updateRepo(id, {
        imagePreset: detected.imagePreset,
        testCommand: detected.testCommand ?? undefined,
      });
      reply.send({ detected });
    } catch (err) {
      reply.status(500).send({ error: String(err) });
    }
  });
}
