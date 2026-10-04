import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as skillService from "../services/skill-service.js";
import {
  actorOf,
  canChange,
  canSee,
  changeRefusal,
  ownerForNew,
  withOwnerNames,
} from "../services/ownership.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { SkillSchema } from "../schemas/integration.js";
import { requireRole } from "../plugins/auth.js";

const scopeQuerySchema = z
  .object({
    scope: z.string().optional().describe("Optional scope filter"),
  })
  .describe("Query parameters for listing skills");

const skillLayoutSchema = z.enum(["commands", "skill-dir"]);

const skillFileSchema = z.object({
  relativePath: z
    .string()
    .min(1)
    .describe("Path under .claude/skills/<name>/. No leading slash or .. segments."),
  content: z.string(),
});

const createSkillSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    prompt: z.string().min(1).describe("Skill prompt content (SKILL.md body for skill-dir)"),
    repoUrl: z.string().optional().describe("Optional repo scope; empty means global"),
    layout: skillLayoutSchema
      .optional()
      .describe(
        "Layout: 'commands' (default) writes .claude/commands/<name>.md; 'skill-dir' writes .claude/skills/<name>/SKILL.md plus files.",
      ),
    files: z
      .array(skillFileSchema)
      .optional()
      .describe("Extra files for skill-dir layout. Ignored for 'commands'."),
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
  .describe("Body for creating a skill");

const updateSkillSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    prompt: z.string().min(1).optional(),
    layout: skillLayoutSchema.optional(),
    files: z.array(skillFileSchema).nullable().optional(),
    agentTypes: z.array(z.string()).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .describe("Partial update to a skill");

const SkillListResponseSchema = z.object({ skills: z.array(SkillSchema) });
const SkillResponseSchema = z.object({ skill: SkillSchema });

/** The skill, when it is in the caller's workspace and the caller may see it (else 404). */
async function requireVisibleSkill(req: FastifyRequest, reply: FastifyReply, id: string) {
  const skill = await skillService.getSkill(id);
  const wsId = req.user?.workspaceId;
  if (
    !skill ||
    (wsId && skill.workspaceId && skill.workspaceId !== wsId) ||
    !canSee(skill.ownerUserId, actorOf(req))
  ) {
    reply.status(404).send({ error: "Skill not found" });
    return null;
  }
  return skill;
}

export async function skillRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/skills",
    {
      schema: {
        operationId: "listSkills",
        summary: "List skills",
        description: "List all configured skills (optionally filtered by scope).",
        tags: ["Repos & Integrations"],
        querystring: scopeQuerySchema,
        response: { 200: SkillListResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      // The organization's skills and the caller's own; admins see every one (ownership.ts).
      const skills = await withOwnerNames(
        await skillService.listSkills(req.query.scope, workspaceId, actorOf(req)),
      );
      reply.send({ skills });
    },
  );

  app.get(
    "/api/skills/:id",
    {
      schema: {
        operationId: "getSkill",
        summary: "Get a skill",
        description: "Fetch a single skill by ID.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: SkillResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const skill = await requireVisibleSkill(req, reply, req.params.id);
      if (!skill) return;
      reply.send({ skill });
    },
  );

  app.post(
    "/api/skills",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createSkill",
        summary: "Create a skill",
        description: "Register a new skill.",
        tags: ["Repos & Integrations"],
        body: createSkillSchema,
        response: { 201: SkillResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const { owner, ...input } = req.body;
      const skill = await skillService.createSkill(
        { ...input, ownerUserId: ownerForNew(owner, actorOf(req)) },
        workspaceId,
      );
      reply.status(201).send({ skill });
    },
  );

  app.patch(
    "/api/skills/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "updateSkill",
        summary: "Update a skill",
        description: "Partial update to a skill.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: updateSkillSchema,
        response: { 200: SkillResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await requireVisibleSkill(req, reply, id);
      if (!existing) return;
      if (!canChange(existing.ownerUserId, actorOf(req), true, "edit")) {
        return reply
          .status(403)
          .send({ error: changeRefusal(existing.ownerUserId, "skill", "member") });
      }
      const skill = await skillService.updateSkill(id, req.body);
      reply.send({ skill });
    },
  );

  app.delete(
    "/api/skills/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "deleteSkill",
        summary: "Delete a skill",
        description: "Delete a skill. Returns 204 on success.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await requireVisibleSkill(req, reply, id);
      if (!existing) return;
      if (!canChange(existing.ownerUserId, actorOf(req), true, "delete")) {
        return reply
          .status(403)
          .send({ error: changeRefusal(existing.ownerUserId, "skill", "member") });
      }
      await skillService.deleteSkill(id);
      reply.status(204).send(null);
    },
  );
}
