import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import {
  actorOf,
  canChange,
  canSee,
  changeRefusal,
  ownerColumnsForNew,
  withOwnerNames,
} from "../services/ownership.js";
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
import { IdParamsSchema, ResourceOwnerSchema } from "../schemas/common.js";
import { db } from "../db/client.js";
import { promptTemplates } from "../db/schema.js";
import { DEFAULT_PROMPT_TEMPLATE, DEFAULT_REVIEW_PROMPT_TEMPLATE } from "@optio/shared";
import {
  REVIEW_DEFAULT_TEMPLATE_NAME,
  workspaceReviewTemplate,
} from "../services/review-defaults.js";
import { seedStarterPrompts } from "../services/starter-prompts.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { PromptTemplateSchema } from "../schemas/integration.js";
import { requireRole } from "../plugins/auth.js";
import { withManagedBy } from "../services/config/managed.js";

const repoUrlQuerySchema = z
  .object({
    repoUrl: z.string().optional().describe("Repo URL to resolve the effective template for"),
  })
  .describe("Query parameters for effective-template lookup");

const saveTemplateSchema = z
  .object({
    template: z.string().min(1).describe("Prompt template content"),
    autoMerge: z
      .boolean()
      .optional()
      .describe(
        "Ignored (kept for older clients): automatic merging is the repo's or the work's " +
          "setting, and turning it on needs a person's confirmation there",
      ),
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
const ReviewDefaultResponseSchema = z.object({
  template: z.string(),
  saved: z
    .boolean()
    .describe("True when the workspace saved its own; false = the built-in prompt, kept current"),
  builtin: z.string().describe("The built-in review prompt (Reset to default)"),
});
const EffectiveTemplateResponseSchema = z.unknown();
const TemplateListResponseSchema = z.object({ templates: z.array(PromptTemplateSchema) });
const OkResponseSchema = z.object({ ok: z.boolean() });

/** The template, when it is in the caller's workspace and the caller may see it (else 404). */
async function requireVisibleTemplate(req: FastifyRequest, reply: FastifyReply, id: string) {
  const existing = await getPromptTemplateById(id);
  const wsId = req.user?.workspaceId;
  if (
    !existing ||
    (wsId && existing.workspaceId && existing.workspaceId !== wsId) ||
    !canSee(existing.ownerUserId, actorOf(req), existing.ownerTeamId)
  ) {
    reply.status(404).send({ error: "Template not found" });
    return null;
  }
  return existing;
}

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
          "Return the review prompt a repo without its own uses — the workspace's " +
          "saved one, else the built-in.",
        tags: ["Repos & Integrations"],
        response: { 200: ReviewDefaultResponseSchema },
      },
    },
    async (req, reply) => {
      const saved = await workspaceReviewTemplate(req.user?.workspaceId ?? null);
      reply.send({
        template: saved ?? DEFAULT_REVIEW_PROMPT_TEMPLATE,
        saved: saved !== null,
        builtin: DEFAULT_REVIEW_PROMPT_TEMPLATE,
      });
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
      // The organization's prompts and the caller's own; admins see every one (ownership.ts).
      const templates = await withOwnerNames(
        await listPromptTemplates({ workspaceId, kind, viewer: actorOf(req) }),
      );
      reply.send({ templates: await withManagedBy(templates, "prompt_templates") });
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
        // The workspace's own row (review-defaults.ts reads it at run time).
        const [existing] = await db
          .select()
          .from(promptTemplates)
          .where(
            and(
              eq(promptTemplates.name, REVIEW_DEFAULT_TEMPLATE_NAME),
              isNull(promptTemplates.repoUrl),
              isNull(promptTemplates.ownerUserId),
              workspaceId
                ? eq(promptTemplates.workspaceId, workspaceId)
                : isNull(promptTemplates.workspaceId),
            ),
          );
        if (body.template.trim() === DEFAULT_REVIEW_PROMPT_TEMPLATE.trim()) {
          // Saving the built-in text stores nothing: the workspace follows the
          // built-in prompt, and its upgrades, again.
          if (existing) await db.delete(promptTemplates).where(eq(promptTemplates.id, existing.id));
        } else if (existing) {
          await db
            .update(promptTemplates)
            .set({ template: body.template, updatedAt: new Date() })
            .where(eq(promptTemplates.id, existing.id));
        } else {
          await db.insert(promptTemplates).values({
            name: REVIEW_DEFAULT_TEMPLATE_NAME,
            template: body.template,
            kind: "review",
            isDefault: false,
            workspaceId,
          });
        }
      } else if (body.repoUrl) {
        // A template's autoMerge merges nothing (the reconciler reads the repo's
        // and the work's confirmed setting, shared work/auto-merge.ts), so a
        // template never stores it on: no way around the confirmation.
        await saveRepoPromptTemplate(body.repoUrl, body.template, false);
      } else {
        await saveDefaultPromptTemplate(body.template, false);
      }
      reply.status(201).send({ ok: true });
    },
  );

  app.post(
    "/api/prompt-templates/seed",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "seedStarterPrompts",
        summary: "Restore the starter prompts",
        description:
          "Add the organization's starter prompts (Create a Claude Code skill, Code " +
          "review, Write a README, …) that are missing, and put edited ones back to " +
          "their text. Never duplicates, and never touches a prompt of someone's own " +
          "that shares a starter's name. Requires `admin` role.",
        tags: ["Repos & Integrations"],
        response: {
          200: z.object({ created: z.number(), restored: z.number(), unchanged: z.number() }),
        },
      },
    },
    async (_req, reply) => {
      reply.send(await seedStarterPrompts({ restore: true }));
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
    owner: ResourceOwnerSchema.optional().describe(
      "Who it belongs to: the organization (`workspace`, the default), a team (`team:<id>`, the caller a member) or the caller (`me`)",
    ),
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
        const { owner, ...input } = req.body;
        const template = await createNamedTemplate({
          ...input,
          workspaceId: req.user?.workspaceId ?? null,
          ...ownerColumnsForNew(owner, actorOf(req)),
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
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await requireVisibleTemplate(req, reply, id);
      if (!existing) return;
      if (
        !canChange(existing.ownerUserId, actorOf(req), true, "edit", {
          ownerTeamId: existing.ownerTeamId,
          orgNeeds: "member",
        })
      ) {
        return reply.status(403).send({
          error: changeRefusal(existing.ownerUserId, "prompt", "member", existing.ownerTeamId),
        });
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
        response: { 204: z.null(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await requireVisibleTemplate(req, reply, id);
      if (!existing) return;
      if (
        !canChange(existing.ownerUserId, actorOf(req), true, "delete", {
          ownerTeamId: existing.ownerTeamId,
          orgNeeds: "member",
        })
      ) {
        return reply.status(403).send({
          error: changeRefusal(existing.ownerUserId, "prompt", "member", existing.ownerTeamId),
        });
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
      const existing = await requireVisibleTemplate(req, reply, id);
      if (!existing) return;
      const rendered = renderTemplateString(existing.template, req.body.params);
      reply.send({ rendered });
    },
  );
}
