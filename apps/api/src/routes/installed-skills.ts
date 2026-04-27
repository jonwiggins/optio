import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as installedSkillService from "../services/installed-skill-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";

const InstalledSkillSchema = z.unknown().describe("Installed (marketplace-sourced) skill row");

const scopeQuerySchema = z
  .object({
    scope: z.string().optional().describe("Optional scope filter"),
  })
  .describe("Query parameters for listing installed skills");

const skillNameSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    "name must be lowercase alphanumeric with -, _, or . (max 64 chars)",
  );

const createInstalledSkillSchema = z
  .object({
    name: skillNameSchema.describe("Becomes .claude/skills/<name>/ in the worktree"),
    description: z.string().optional(),
    sourceUrl: z.string().min(1).describe("Git URL to clone (any public URL for now)"),
    ref: z.string().optional().describe("Branch, tag, or SHA. Defaults to 'main'."),
    subpath: z
      .string()
      .optional()
      .describe("Directory within the source to use as the skill. Defaults to repo root."),
    repoUrl: z.string().optional().describe("Optional repo scope; empty means global"),
    agentTypes: z
      .array(z.string())
      .optional()
      .describe("Agent types this skill applies to. Empty/omitted = all agents."),
    enabled: z.boolean().optional(),
  })
  .describe("Body for installing a marketplace skill");

const updateInstalledSkillSchema = z
  .object({
    name: skillNameSchema.optional(),
    description: z.string().nullable().optional(),
    ref: z.string().optional(),
    subpath: z.string().optional(),
    agentTypes: z.array(z.string()).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .describe("Partial update to an installed skill");

const ListResponseSchema = z.object({ skills: z.array(InstalledSkillSchema) });
const ItemResponseSchema = z.object({ skill: InstalledSkillSchema });

export async function installedSkillRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/installed-skills",
    {
      schema: {
        operationId: "listInstalledSkills",
        summary: "List installed skills",
        description: "List all configured marketplace-sourced skills.",
        tags: ["Repos & Integrations"],
        querystring: scopeQuerySchema,
        response: { 200: ListResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const skills = await installedSkillService.listInstalledSkills(req.query.scope, workspaceId);
      reply.send({ skills });
    },
  );

  app.get(
    "/api/installed-skills/:id",
    {
      schema: {
        operationId: "getInstalledSkill",
        summary: "Get an installed skill",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: ItemResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const skill = await installedSkillService.getInstalledSkill(req.params.id);
      if (!skill) return reply.status(404).send({ error: "Installed skill not found" });
      reply.send({ skill });
    },
  );

  app.post(
    "/api/installed-skills",
    {
      schema: {
        operationId: "createInstalledSkill",
        summary: "Install a marketplace skill",
        description:
          "Register a new installed skill. The sync worker will pick it up on its next pass; call POST /:id/sync to force an immediate sync.",
        tags: ["Repos & Integrations"],
        body: createInstalledSkillSchema,
        response: { 201: ItemResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      try {
        const skill = await installedSkillService.createInstalledSkill(req.body, workspaceId);
        // Kick off an eager sync so the user doesn't wait the full 5 min interval.
        const { skillSyncQueue } = await import("../workers/skill-sync-worker.js");
        await skillSyncQueue
          .add("sync-one", { id: skill.id }, { removeOnComplete: true })
          .catch(() => {});
        reply.status(201).send({ skill });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "invalid input";
        reply.status(400).send({ error: msg });
      }
    },
  );

  app.patch(
    "/api/installed-skills/:id",
    {
      schema: {
        operationId: "updateInstalledSkill",
        summary: "Update an installed skill",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: updateInstalledSkillSchema,
        response: { 200: ItemResponseSchema, 404: ErrorResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const existing = await installedSkillService.getInstalledSkill(req.params.id);
      if (!existing) return reply.status(404).send({ error: "Installed skill not found" });
      try {
        const skill = await installedSkillService.updateInstalledSkill(req.params.id, req.body);
        // If ref or subpath changed, the sync worker needs to re-resolve.
        if (req.body.ref !== undefined || req.body.subpath !== undefined) {
          const { skillSyncQueue } = await import("../workers/skill-sync-worker.js");
          await skillSyncQueue
            .add("sync-one", { id: skill.id }, { removeOnComplete: true })
            .catch(() => {});
        }
        reply.send({ skill });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "invalid input";
        reply.status(400).send({ error: msg });
      }
    },
  );

  app.delete(
    "/api/installed-skills/:id",
    {
      schema: {
        operationId: "deleteInstalledSkill",
        summary: "Delete an installed skill",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const existing = await installedSkillService.getInstalledSkill(req.params.id);
      if (!existing) return reply.status(404).send({ error: "Installed skill not found" });
      await installedSkillService.deleteInstalledSkill(req.params.id);
      reply.status(204).send(null);
    },
  );

  app.post(
    "/api/installed-skills/:id/sync",
    {
      schema: {
        operationId: "syncInstalledSkill",
        summary: "Force a sync for an installed skill",
        description:
          "Enqueues an immediate sync. The endpoint returns 202 once the job is queued; poll GET /:id to see lastSyncedAt / lastSyncError change.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 202: ItemResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const skill = await installedSkillService.getInstalledSkill(req.params.id);
      if (!skill) return reply.status(404).send({ error: "Installed skill not found" });
      const { skillSyncQueue } = await import("../workers/skill-sync-worker.js");
      await skillSyncQueue.add("sync-one", { id: skill.id }, { removeOnComplete: true });
      reply.status(202).send({ skill });
    },
  );
}
