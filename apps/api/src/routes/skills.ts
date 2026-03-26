import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as skillService from "../services/skill-service.js";

const createSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  prompt: z.string().min(1),
  repoUrl: z.string().optional(),
  enabled: z.boolean().optional(),
});

const updateSkillSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  prompt: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export async function skillRoutes(app: FastifyInstance) {
  // List skills (global or filtered by scope)
  app.get("/api/skills", async (req, reply) => {
    const query = req.query as { scope?: string };
    const workspaceId = req.user?.workspaceId ?? null;
    const skills = await skillService.listSkills(query.scope, workspaceId);
    reply.send({ skills });
  });

  // Get a single skill
  app.get("/api/skills/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const skill = await skillService.getSkill(id);
    if (!skill) return reply.status(404).send({ error: "Skill not found" });
    reply.send({ skill });
  });

  // Create a skill
  app.post("/api/skills", async (req, reply) => {
    const input = createSkillSchema.parse(req.body);
    const workspaceId = req.user?.workspaceId ?? null;
    const skill = await skillService.createSkill(input, workspaceId);
    reply.status(201).send({ skill });
  });

  // Update a skill
  app.patch("/api/skills/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await skillService.getSkill(id);
    if (!existing) return reply.status(404).send({ error: "Skill not found" });
    const input = updateSkillSchema.parse(req.body);
    const skill = await skillService.updateSkill(id, input);
    reply.send({ skill });
  });

  // Delete a skill
  app.delete("/api/skills/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await skillService.getSkill(id);
    if (!existing) return reply.status(404).send({ error: "Skill not found" });
    await skillService.deleteSkill(id);
    reply.status(204).send();
  });
}
