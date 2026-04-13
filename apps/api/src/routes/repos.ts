import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as repoService from "../services/repo-service.js";
import {
  validateCpuQuantity,
  validateMemoryQuantity,
  validateRequestLimitPair,
  parseCpuMillicores,
  parseMemoryMi,
} from "@optio/shared";
import { requireRole } from "../plugins/auth.js";
import { getGitHubToken } from "../services/github-token-service.js";
import { isSsrfSafeUrl } from "../utils/ssrf.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { RepoSchema } from "../schemas/integration.js";

const createRepoSchema = z
  .object({
    repoUrl: z.string().min(1).describe("Repository URL (http/https)"),
    fullName: z.string().min(1).describe("owner/repo slug"),
    defaultBranch: z.string().optional().describe("Default branch name (e.g. `main`)"),
    isPrivate: z.boolean().optional(),
  })
  .describe("Body for adding a repository to Optio");

const updateRepoSchema = z
  .object({
    imagePreset: z.string().optional(),
    extraPackages: z.string().optional(),
    setupCommands: z.string().optional(),
    customDockerfile: z.string().nullable().optional(),
    autoMerge: z.boolean().optional(),
    cautiousMode: z.boolean().optional(),
    defaultAgentType: z.enum(["claude-code", "codex", "copilot", "opencode", "gemini"]).optional(),
    promptTemplateOverride: z.string().nullable().optional(),
    defaultBranch: z.string().optional(),
    claudeModel: z.string().optional(),
    claudeContextWindow: z.string().optional(),
    claudeThinking: z.boolean().optional(),
    claudeEffort: z.string().optional(),
    copilotModel: z.string().optional(),
    copilotEffort: z.string().optional(),
    opencodeModel: z.string().optional(),
    opencodeAgent: z.string().optional(),
    opencodeProvider: z.string().optional(),
    geminiModel: z.string().optional(),
    geminiApprovalMode: z.string().optional(),
    maxTurnsCoding: z.number().int().min(1).max(10000).optional(),
    maxTurnsReview: z.number().int().min(1).max(10000).optional(),
    autoResume: z.boolean().optional(),
    planningModeEnabled: z.boolean().optional(),
    maxConcurrentTasks: z.number().int().min(1).max(50).optional(),
    maxPodInstances: z.number().int().min(1).max(20).optional(),
    maxAgentsPerPod: z.number().int().min(1).max(50).optional(),
    reviewEnabled: z.boolean().optional(),
    reviewTrigger: z.string().optional(),
    reviewPromptTemplate: z.string().nullable().optional(),
    testCommand: z.string().optional(),
    reviewModel: z.string().optional(),
    maxAutoResumes: z.number().int().min(1).max(100).nullable().optional(),
    slackWebhookUrl: z
      .string()
      .url()
      .refine(isSsrfSafeUrl, "Slack webhook URL must not target private/internal addresses")
      .nullable()
      .optional(),
    slackChannel: z.string().nullable().optional(),
    slackNotifyOn: z
      .array(z.enum(["completed", "failed", "needs_attention", "pr_opened"]))
      .optional(),
    slackEnabled: z.boolean().optional(),
    networkPolicy: z.enum(["unrestricted", "restricted"]).optional(),
    secretProxy: z.boolean().optional(),
    offPeakOnly: z.boolean().optional(),
    cpuRequest: z.string().nullable().optional(),
    cpuLimit: z.string().nullable().optional(),
    memoryRequest: z.string().nullable().optional(),
    memoryLimit: z.string().nullable().optional(),
    dockerInDocker: z.boolean().optional(),
  })
  .describe("Partial update to a repository configuration");

const RepoListResponseSchema = z.object({ repos: z.array(RepoSchema) });
const RepoResponseSchema = z.object({ repo: RepoSchema });
const DetectResponseSchema = z.object({ detected: z.unknown() });

export async function repoRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/repos",
    {
      schema: {
        operationId: "listRepos",
        summary: "List repositories",
        description: "Return all repositories configured in the current workspace.",
        tags: ["Repos & Integrations"],
        response: { 200: RepoListResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const repos = await repoService.listRepos(workspaceId);
      reply.send({ repos });
    },
  );

  app.get(
    "/api/repos/:id",
    {
      schema: {
        operationId: "getRepo",
        summary: "Get a repository",
        description: "Fetch a single repository by ID, scoped to the current workspace.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: RepoResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const repo = await repoService.getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }
      reply.send({ repo });
    },
  );

  app.post(
    "/api/repos",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "createRepo",
        summary: "Add a repository",
        description:
          "Register a new repository with Optio. After creation, an auto-detect " +
          "step populates sensible defaults for image preset and test command " +
          "based on the repo's language/build system. Requires `admin` role.",
        tags: ["Repos & Integrations"],
        body: createRepoSchema,
        response: {
          201: RepoResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const workspaceId = req.user?.workspaceId ?? null;

      const existing = await repoService.getRepoByUrl(body.repoUrl, workspaceId);
      if (existing) {
        return reply.status(409).send({ error: "This repository has already been added" });
      }

      const repo = await repoService.createRepo({
        ...body,
        workspaceId,
      });

      try {
        const { detectRepoConfig } = await import("../services/repo-detect-service.js");
        const githubToken = await getGitHubToken({ userId: req.user!.id }).catch(() => null);
        if (githubToken) {
          const detected = await detectRepoConfig(body.repoUrl, githubToken);
          if (detected.imagePreset !== "base" || detected.testCommand) {
            await repoService.updateRepo(repo.id, {
              imagePreset: detected.imagePreset,
              testCommand: detected.testCommand,
            });
          }
        }
      } catch {
        /* non-critical */
      }

      logAction({
        userId: req.user?.id,
        action: "repo.create",
        params: { repoUrl: body.repoUrl, fullName: body.fullName },
        result: { id: repo.id },
        success: true,
      }).catch(() => {});
      reply.status(201).send({ repo });
    },
  );

  app.patch(
    "/api/repos/:id",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "updateRepo",
        summary: "Update a repository",
        description:
          "Partial update to a repository's configuration. K8s resource " +
          "requests/limits are validated; mismatched requests > limits " +
          "return 400. Slack webhook URLs are SSRF-guarded. Requires " +
          "`admin` role.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: updateRepoSchema,
        response: {
          200: RepoResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await repoService.getRepo(id);
      if (!existing) return reply.status(404).send({ error: "Repo not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }
      const body = req.body;

      const resourceErrors: string[] = [];
      if (body.cpuRequest) {
        const r = validateCpuQuantity(body.cpuRequest);
        if (!r.valid) resourceErrors.push(r.error!);
      }
      if (body.cpuLimit) {
        const r = validateCpuQuantity(body.cpuLimit);
        if (!r.valid) resourceErrors.push(r.error!);
      }
      if (body.memoryRequest) {
        const r = validateMemoryQuantity(body.memoryRequest);
        if (!r.valid) resourceErrors.push(r.error!);
      }
      if (body.memoryLimit) {
        const r = validateMemoryQuantity(body.memoryLimit);
        if (!r.valid) resourceErrors.push(r.error!);
      }
      const cpuPair = validateRequestLimitPair(
        body.cpuRequest ?? existing.cpuRequest,
        body.cpuLimit ?? existing.cpuLimit,
        parseCpuMillicores,
        "CPU",
      );
      if (!cpuPair.valid) resourceErrors.push(cpuPair.error!);
      const memPair = validateRequestLimitPair(
        body.memoryRequest ?? existing.memoryRequest,
        body.memoryLimit ?? existing.memoryLimit,
        parseMemoryMi,
        "Memory",
      );
      if (!memPair.valid) resourceErrors.push(memPair.error!);
      if (resourceErrors.length > 0) {
        return reply.status(400).send({ error: resourceErrors.join(" ") });
      }

      const repo = await repoService.updateRepo(id, body);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      logAction({
        userId: req.user?.id,
        action: "repo.update",
        params: { repoId: id, ...body },
        result: { id },
        success: true,
      }).catch(() => {});
      reply.send({ repo });
    },
  );

  app.delete(
    "/api/repos/:id",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "deleteRepo",
        summary: "Delete a repository",
        description:
          "Remove a repository from Optio. Does not delete associated " +
          "tasks or logs. Requires `admin` role.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await repoService.getRepo(id);
      if (!existing) return reply.status(404).send({ error: "Repo not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }
      await repoService.deleteRepo(id);
      logAction({
        userId: req.user?.id,
        action: "repo.delete",
        params: { repoId: id, repoUrl: existing.repoUrl },
        result: { id },
        success: true,
      }).catch(() => {});
      reply.status(204).send(null);
    },
  );

  app.post(
    "/api/repos/:id/detect",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "detectRepoConfig",
        summary: "Auto-detect repo configuration",
        description:
          "Re-run the language / build-system detection for a repo and " +
          "persist the detected image preset + test command. Requires " +
          "`admin` role.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: {
          200: DetectResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const repo = await repoService.getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }

      try {
        const { detectRepoConfig } = await import("../services/repo-detect-service.js");
        const githubToken = await getGitHubToken({ userId: req.user!.id });
        const detected = await detectRepoConfig(repo.repoUrl, githubToken);
        await repoService.updateRepo(id, {
          imagePreset: detected.imagePreset,
          testCommand: detected.testCommand ?? undefined,
        });
        reply.send({ detected });
      } catch (err) {
        reply.status(500).send({ error: String(err) });
      }
    },
  );
}
