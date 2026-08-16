import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import {
  getPromptTemplate,
  saveDefaultPromptTemplate,
  saveRepoPromptTemplate,
  listPromptTemplates,
  getPromptTemplateById,
  createNamedTemplate,
  updateNamedTemplate,
  deleteNamedTemplate,
  renderTemplateString,
} from "../services/prompt-template-service.js";
import { IdParamsSchema } from "../schemas/common.js";
import { db } from "../db/client.js";
import { promptTemplates } from "../db/schema.js";
import { DEFAULT_PROMPT_TEMPLATE } from "@optio/shared";
import { ErrorResponseSchema } from "../schemas/common.js";
import { PromptTemplateSchema } from "../schemas/integration.js";
import { requireRole } from "../plugins/auth.js";

const repoUrlQuerySchema = z
  .object({
    repoUrl: z.string().optional().describe("Repo URL to resolve the effective template for"),
  })
  .describe("Query parameters for effective-template lookup");

const saveTemplateSchema = z
  .object({
    template: z.string().min(1).describe("Prompt template content"),
    autoMerge: z.boolean().optional().describe("Auto-merge flag for the associated repo"),
    repoUrl: z
      .string()
      .optional()
      .describe("Repo URL to scope the template to; empty means global default"),
    isReview: z
      .boolean()
      .optional()
      .describe("If true, save as the review default instead of the coding default"),
  })
  .describe("Body for saving a prompt template");

const TemplateStringResponseSchema = z.object({ template: z.string() });
const EffectiveTemplateResponseSchema = z.unknown();
const TemplateListResponseSchema = z.object({ templates: z.array(PromptTemplateSchema) });
const OkResponseSchema = z.object({ ok: z.boolean() });

export async function promptTemplateRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/prompt-templates/effective",
    {
      schema: {
        operationId: "getEffectivePromptTemplate",
        summary: "Get the effective prompt template",
        description:
          "Resolve the effective prompt template for a repo: the repo-scoped " +
          "override if set, otherwise the global default, otherwise the hardcoded fallback.",
        tags: ["Repos & Integrations"],
        querystring: repoUrlQuerySchema,
        response: { 200: EffectiveTemplateResponseSchema },
      },
    },
    async (req, reply) => {
      const result = await getPromptTemplate(req.query.repoUrl);
      reply.send(result);
    },
  );

  app.get(
    "/api/prompt-templates/builtin-default",
    {
      schema: {
        operationId: "getBuiltinPromptTemplate",
        summary: "Get the built-in default prompt template",
        description:
          "Return the hardcoded default template shipped with the API — used " +
          "by the 'reset to default' button in the web UI.",
        tags: ["Repos & Integrations"],
        response: { 200: TemplateStringResponseSchema },
      },
    },
    async (_req, reply) => {
      reply.send({ template: DEFAULT_PROMPT_TEMPLATE });
    },
  );

  app.get(
    "/api/prompt-templates/review-default",
    {
      schema: {
        operationId: "getReviewDefaultPromptTemplate",
        summary: "Get the review default prompt template",
        description:
          "Return the current review default template — either the saved " +
          "override or the hardcoded fallback.",
        tags: ["Repos & Integrations"],
        response: { 200: TemplateStringResponseSchema },
      },
    },
    async (_req, reply) => {
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
    },
  );

  const listTemplatesQuerySchema = z
    .object({
      kind: z
        .enum(["prompt", "review", "job", "task"])
        .optional()
        .describe("Filter by template kind"),
    })
    .describe("Query parameters for listing prompt templates");

  app.get(
    "/api/prompt-templates",
    {
      schema: {
        operationId: "listPromptTemplates",
        summary: "List all prompt templates",
        description: "Return all prompt template rows in the current workspace.",
        tags: ["Repos & Integrations"],
        querystring: listTemplatesQuerySchema,
        response: { 200: TemplateListResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const { kind } = req.query;
      const templates = await listPromptTemplates({ workspaceId, kind });
      reply.send({ templates });
    },
  );

  app.post(
    "/api/prompt-templates",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "savePromptTemplate",
        summary: "Save a prompt template",
        description:
          "Save a prompt template. If `isReview` is true, saves as the review " +
          "default. Otherwise if `repoUrl` is set, saves as the repo-scoped " +
          "override; otherwise saves as the global coding default.",
        tags: ["Repos & Integrations"],
        body: saveTemplateSchema,
        response: { 201: OkResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const workspaceId = req.user?.workspaceId ?? null;
      if (body.isReview) {
        const [existing] = await db
          .select()
          .from(promptTemplates)
          .where(and(eq(promptTemplates.name, "review-default"), isNull(promptTemplates.repoUrl)));
        if (existing) {
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
    },
  );

  // ── Named-template CRUD (kinds: prompt | review | job | task) ──────────────

  const namedCreateSchema = z.object({
    name: z.string().min(1),
    template: z.string().min(1),
    kind: z.enum(["prompt", "review", "job", "task"]).default("prompt"),
    description: z.string().optional(),
    paramsSchema: z.record(z.unknown()).optional(),
    defaultAgentType: z.string().optional(),
  });

  const namedUpdateSchema = z.object({
    name: z.string().min(1).optional(),
    template: z.string().min(1).optional(),
    kind: z.enum(["prompt", "review", "job", "task"]).optional(),
    description: z.string().nullable().optional(),
    paramsSchema: z.record(z.unknown()).nullable().optional(),
    defaultAgentType: z.string().nullable().optional(),
  });

  app.post(
    "/api/prompt-templates/named",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createNamedTemplate",
        summary: "Create a named template",
        description:
          "Create a reusable template of any kind (coding prompt, review, job, task). " +
          "Supports {{param}} placeholders plus {{#if param}}...{{/if}} blocks.",
        tags: ["Repos & Integrations"],
        body: namedCreateSchema,
        response: {
          201: z.object({ template: PromptTemplateSchema }),
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const template = await createNamedTemplate({
          ...req.body,
          workspaceId: req.user?.workspaceId ?? null,
        });
        reply.status(201).send({ template });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.patch(
    "/api/prompt-templates/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "updateNamedTemplate",
        summary: "Update a named template",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: namedUpdateSchema,
        response: {
          200: z.object({ template: PromptTemplateSchema }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await getPromptTemplateById(id);
      if (!existing) return reply.status(404).send({ error: "Template not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Template not found" });
      }
      const template = await updateNamedTemplate(id, req.body);
      if (!template) return reply.status(404).send({ error: "Template not found" });
      reply.send({ template });
    },
  );

  app.delete(
    "/api/prompt-templates/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "deleteNamedTemplate",
        summary: "Delete a named template",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await getPromptTemplateById(id);
      if (!existing) return reply.status(404).send({ error: "Template not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Template not found" });
      }
      await deleteNamedTemplate(id);
      reply.status(204).send(null);
    },
  );

  app.post(
    "/api/prompt-templates/:id/preview",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "previewTemplate",
        summary: "Render a template with sample params",
        description:
          "Substitute {{param}} placeholders and {{#if}} blocks, returning the rendered string.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: z.object({ params: z.record(z.unknown()).default({}) }),
        response: {
          200: z.object({ rendered: z.string() }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await getPromptTemplateById(id);
      if (!existing) return reply.status(404).send({ error: "Template not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Template not found" });
      }
      const rendered = renderTemplateString(existing.template, req.body.params);
      reply.send({ rendered });
    },
  );
}
