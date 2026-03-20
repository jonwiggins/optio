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
  autoResumeOnReview: z.boolean().optional(),
  maxConcurrentTasks: z.number().int().min(1).max(50).optional(),
  reviewEnabled: z.boolean().optional(),
  reviewTrigger: z.string().optional(),
  reviewPromptTemplate: z.string().nullable().optional(),
  testCommand: z.string().optional(),
  reviewModel: z.string().optional(),
});

export async function repoRoutes(app: FastifyInstance) {
  app.get("/api/repos", async (_req, reply) => {
    const repos = await repoService.listRepos();
    reply.send({ repos });
  });

  app.get("/api/repos/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = await repoService.getRepo(id);
    if (!repo) return reply.status(404).send({ error: "Repo not found" });
    reply.send({ repo });
  });

  app.post("/api/repos", async (req, reply) => {
    const body = createRepoSchema.parse(req.body);
    const repo = await repoService.createRepo(body);
    reply.status(201).send({ repo });
  });

  app.patch("/api/repos/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateRepoSchema.parse(req.body);
    const repo = await repoService.updateRepo(id, body);
    if (!repo) return reply.status(404).send({ error: "Repo not found" });
    reply.send({ repo });
  });

  app.delete("/api/repos/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await repoService.deleteRepo(id);
    reply.status(204).send();
  });
}
