import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as installedSkillService from "../services/installed-skill-service.js";
import {
  actorOf,
  canChange,
  canSee,
  changeRefusal,
  ownerForNew,
  withOwnerNames,
} from "../services/ownership.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { requireRole } from "../plugins/auth.js";
import { withManagedBy } from "../services/config/managed.js";
import {
  allowWorkspaceRow,
  applyDeploymentDefault,
  deploymentDefaultField,
} from "./deployment-rows.js";

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

// Both reach `git` as arguments: never one it could read as an option.
const sourceUrlSchema = z
  .string()
  .min(1)
  .refine((v) => !v.trimStart().startsWith("-"), 'sourceUrl must not start with "-"');
const refSchema = z
  .string()
  .refine((v) => !v.trimStart().startsWith("-"), 'ref must not start with "-"');

const createInstalledSkillSchema = z
  .object({
    name: skillNameSchema.describe("Becomes .claude/skills/<name>/ in the worktree"),
    description: z.string().optional(),
    sourceUrl: sourceUrlSchema.describe("Git URL to clone (any public URL for now)"),
    ref: refSchema.optional().describe("Branch, tag, or SHA. Defaults to 'main'."),
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
    owner: z
      .enum(["workspace", "me"])
      .optional()
      .describe(
        "Who it belongs to: the organization (`workspace`, the default) or the caller (`me`)",
      ),
  })
  .describe("Body for installing a marketplace skill");

const updateInstalledSkillSchema = z
  .object({
    name: skillNameSchema.optional(),
    description: z.string().nullable().optional(),
    ref: refSchema.optional(),
    subpath: z.string().optional(),
    agentTypes: z.array(z.string()).nullable().optional(),
    enabled: z.boolean().optional(),
    deploymentDefault: deploymentDefaultField,
  })
  .describe("Partial update to an installed skill");

const ListResponseSchema = z.object({ skills: z.array(InstalledSkillSchema) });
const ItemResponseSchema = z.object({ skill: InstalledSkillSchema });

/**
 * The skill, when the caller's workspace reads it and the caller may see it
 * (else 404); to change one of the deployment's, deployment authority (403).
 */
async function requireVisibleSkill(
  req: FastifyRequest,
  reply: FastifyReply,
  id: string,
  access: "see" | "change" = "see",
) {
  const skill = await installedSkillService.getInstalledSkill(id);
  if (!skill || !canSee(skill.ownerUserId, actorOf(req))) {
    reply.status(404).send({ error: "Installed skill not found" });
    return null;
  }
  if (!(await allowWorkspaceRow(req, reply, skill, access, "Installed skill not found"))) {
    return null;
  }
  return skill;
}

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
      // The organization's skills and the caller's own; admins see every one (ownership.ts).
      const skills = await withOwnerNames(
        await installedSkillService.listInstalledSkills(req.query.scope, workspaceId, actorOf(req)),
      );
      reply.send({ skills: await withManagedBy(skills, "installed_skills") });
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
      const skill = await requireVisibleSkill(req, reply, req.params.id);
      if (!skill) return;
      reply.send({ skill });
    },
  );

  app.post(
    "/api/installed-skills",
    {
      preHandler: [requireRole("member")],
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
      const { owner, ...input } = req.body;
      try {
        const skill = await installedSkillService.createInstalledSkill(
          { ...input, ownerUserId: ownerForNew(owner, actorOf(req)) },
          workspaceId,
        );
        // Kick off an eager sync so the user doesn't wait the full 5 min interval.
        const { enqueueSkillSync } = await import("../workers/skill-sync-worker.js");
        await enqueueSkillSync(skill.id).catch(() => {});
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
      preHandler: [requireRole("member")],
      schema: {
        operationId: "updateInstalledSkill",
        summary: "Update an installed skill",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: updateInstalledSkillSchema,
        response: {
          200: ItemResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const existing = await requireVisibleSkill(req, reply, req.params.id, "change");
      if (!existing) return;
      if (!canChange(existing.ownerUserId, actorOf(req), true, "edit")) {
        return reply
          .status(403)
          .send({ error: changeRefusal(existing.ownerUserId, "skill", "member") });
      }
      const { deploymentDefault, ...changes } = req.body;
      if (!(await applyDeploymentDefault(reply, "installed_skills", existing, deploymentDefault))) {
        return;
      }
      try {
        const skill = await installedSkillService.updateInstalledSkill(req.params.id, changes);
        // If ref or subpath changed, the sync worker needs to re-resolve.
        if (req.body.ref !== undefined || req.body.subpath !== undefined) {
          const { enqueueSkillSync } = await import("../workers/skill-sync-worker.js");
          await enqueueSkillSync(skill.id).catch(() => {});
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
      preHandler: [requireRole("member")],
      schema: {
        operationId: "deleteInstalledSkill",
        summary: "Delete an installed skill",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const existing = await requireVisibleSkill(req, reply, req.params.id, "change");
      if (!existing) return;
      if (!canChange(existing.ownerUserId, actorOf(req), true, "delete")) {
        return reply
          .status(403)
          .send({ error: changeRefusal(existing.ownerUserId, "skill", "member") });
      }
      await installedSkillService.deleteInstalledSkill(req.params.id);
      reply.status(204).send(null);
    },
  );

  app.post(
    "/api/installed-skills/:id/sync",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "syncInstalledSkill",
        summary: "Force a sync for an installed skill",
        description:
          "Enqueues an immediate sync. The endpoint returns 202 once the job is queued; poll GET /:id to see lastSyncedAt / lastSyncError change.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 202: ItemResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const skill = await requireVisibleSkill(req, reply, req.params.id, "change");
      if (!skill) return;
      if (!canChange(skill.ownerUserId, actorOf(req), true, "edit")) {
        return reply
          .status(403)
          .send({ error: changeRefusal(skill.ownerUserId, "skill", "member") });
      }
      const { enqueueSkillSync } = await import("../workers/skill-sync-worker.js");
      await enqueueSkillSync(skill.id);
      reply.status(202).send({ skill });
    },
  );
}
