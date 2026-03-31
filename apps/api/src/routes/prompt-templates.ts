import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import {
  getPromptTemplate,
  saveDefaultPromptTemplate,
  saveRepoPromptTemplate,
  listPromptTemplates,
} from "../services/prompt-template-service.js";
import { db } from "../db/client.js";
import { promptTemplates } from "../db/schema.js";
import { DEFAULT_PROMPT_TEMPLATE } from "@optio/shared";

const saveTemplateSchema = z.object({
  template: z.string().min(1),
  autoMerge: z.boolean().optional(),
  repoUrl: z.string().optional(),
  isReview: z.boolean().optional(),
});

export async function promptTemplateRoutes(app: FastifyInstance) {
  // Get the effective template for a repo (or global default)
  app.get("/api/prompt-templates/effective", async (req, reply) => {
    const query = req.query as { repoUrl?: string };
    const result = await getPromptTemplate(query.repoUrl);
    reply.send(result);
  });

  // Get the hardcoded default (for reset)
  app.get("/api/prompt-templates/builtin-default", async (_req, reply) => {
    reply.send({ template: DEFAULT_PROMPT_TEMPLATE });
  });

  // Get the review default template
  app.get("/api/prompt-templates/review-default", async (_req, reply) => {
    const [template] = await db
      .select()
      .from(promptTemplates)
      .where(and(eq(promptTemplates.name, "review-default"), isNull(promptTemplates.repoUrl)));
    if (template) {
      reply.send({ template: template.template });
    } else {
      const { DEFAULT_REVIEW_PROMPT_TEMPLATE } = await import("@optio/shared");
      reply.send({ template: DEFAULT_REVIEW_PROMPT_TEMPLATE });
    }
  });

  // List all templates — scoped to workspace
  app.get("/api/prompt-templates", async (req, reply) => {
    const workspaceId = req.user?.workspaceId ?? null;
    const templates = await listPromptTemplates(workspaceId);
    reply.send({ templates });
  });

  // Save template — assign workspace on insert
  app.post("/api/prompt-templates", async (req, reply) => {
    const body = saveTemplateSchema.parse(req.body);
    const workspaceId = req.user?.workspaceId ?? null;
    if (body.isReview) {
      // Save as review default
      const [existing] = await db
        .select()
        .from(promptTemplates)
        .where(and(eq(promptTemplates.name, "review-default"), isNull(promptTemplates.repoUrl)));
      if (existing) {
        // Verify workspace ownership before updating
        if (workspaceId && existing.workspaceId && existing.workspaceId !== workspaceId) {
          return reply.status(404).send({ error: "Template not found" });
        }
        await db
          .update(promptTemplates)
          .set({ template: body.template, updatedAt: new Date() })
          .where(eq(promptTemplates.id, existing.id));
      } else {
        await db.insert(promptTemplates).values({
          name: "review-default",
          template: body.template,
          isDefault: false,
          workspaceId,
        });
      }
    } else if (body.repoUrl) {
      await saveRepoPromptTemplate(body.repoUrl, body.template, body.autoMerge ?? false);
    } else {
      await saveDefaultPromptTemplate(body.template, body.autoMerge ?? false);
    }
    reply.status(201).send({ ok: true });
  });
}
