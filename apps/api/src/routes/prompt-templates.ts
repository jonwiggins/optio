import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  actorOf,
  canChange,
  canSee,
  changeRefusal,
  ownerForNew,
  withOwnerNames,
} from "../services/ownership.js";
import {
  getPromptTemplate,
  getReviewDefaultTemplate,
  saveDefaultPromptTemplate,
  saveRepoPromptTemplate,
  saveReviewDefaultTemplate,
  listPromptTemplates,
  getPromptTemplateById,
  createNamedTemplate,
  updateNamedTemplate,
  deleteNamedTemplate,
  isSystemPromptRow,
  renderTemplateString,
  reservedPromptName,
} from "../services/prompt-template-service.js";
import { IdParamsSchema } from "../schemas/common.js";
import { DEFAULT_PROMPT_TEMPLATE, DEFAULT_REVIEW_PROMPT_TEMPLATE } from "@optio/shared";
import { isAuthDisabled } from "../services/oauth/index.js";
import { isUniqueViolation } from "../utils/db-errors.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { PromptTemplateSchema } from "../schemas/integration.js";
import { requireDeploymentAdmin, requireRole } from "../plugins/auth.js";
import { withManagedBy } from "../services/config/managed.js";

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
    scope: z
      .enum(["workspace", "deployment"])
      .optional()
      .describe(
        "Whose default it is: the caller's workspace's (`workspace`, the default; workspace " +
          "admins), or the deployment's, which every workspace without its own falls back to " +
          "(`deployment`; deployment admins)",
      ),
  })
  .describe("Body for saving a prompt template");

const TemplateStringResponseSchema = z.object({ template: z.string() });
const EffectiveTemplateResponseSchema = z.unknown();
const TemplateListResponseSchema = z.object({ templates: z.array(PromptTemplateSchema) });
const OkResponseSchema = z.object({ ok: z.boolean() });

/**
 * The template, when it is in the caller's workspace or the deployment's
 * (no workspace) and the caller may see it (else 404). A repo row saved
 * without a workspace was some workspace's own, so it isn't the deployment's.
 */
async function requireVisibleTemplate(req: FastifyRequest, reply: FastifyReply, id: string) {
  const existing = await getPromptTemplateById(id);
  const wsId = req.user?.workspaceId;
  if (
    !existing ||
    (wsId && existing.workspaceId && existing.workspaceId !== wsId) ||
    (wsId && !existing.workspaceId && existing.repoUrl) ||
    !canSee(existing.ownerUserId, actorOf(req))
  ) {
    reply.status(404).send({ error: "Template not found" });
    return null;
  }
  return existing;
}

/**
 * Whether the requester may change what every workspace shares — the
 * deployment's default prompts and the prompts with no workspace (the
 * starter prompts): a deployment admin, or, until someone holds that role,
 * an admin of the founding workspace (the rule `requireDeploymentAdmin`
 * applies to restoring the starter prompts).
 */
async function mayChangeDeploymentPrompts(req: FastifyRequest): Promise<boolean> {
  if (isAuthDisabled()) return true;
  if (!req.user) return false;
  const { isDeploymentAdmin, hasDeploymentAdmin, isFoundingWorkspaceAdmin } =
    await import("../services/sign-in-config-service.js");
  if (await isDeploymentAdmin(req.user)) return true;
  return !(await hasDeploymentAdmin()) && (await isFoundingWorkspaceAdmin(req.user.id));
}

const DEPLOYMENT_PROMPT_REFUSAL =
  "This prompt is shared by every workspace — only a deployment admin can change it";
const WORKSPACE_DEFAULT_REFUSAL = "Only a workspace admin changes the workspace's default prompts";

export async function promptTemplateRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/prompt-templates/effective",
    {
      schema: {
        operationId: "getEffectivePromptTemplate",
        summary: "Get the effective prompt template",
        description:
          "Resolve the effective prompt template for a repo in the caller's workspace: " +
          "the workspace's repo override if set, otherwise the workspace's default, " +
          "otherwise the deployment's, otherwise the hardcoded fallback.",
        tags: ["Repos & Integrations"],
        querystring: repoUrlQuerySchema,
        response: { 200: EffectiveTemplateResponseSchema },
      },
    },
    async (req, reply) => {
      const result = await getPromptTemplate(req.query.repoUrl, {
        workspaceId: req.user?.workspaceId ?? null,
      });
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
          "Return the current review default template — the caller's workspace's, " +
          "else the deployment's, else the hardcoded fallback.",
        tags: ["Repos & Integrations"],
        response: { 200: TemplateStringResponseSchema },
      },
    },
    async (req, reply) => {
      const saved = await getReviewDefaultTemplate(req.user?.workspaceId ?? null);
      reply.send({ template: saved ?? DEFAULT_REVIEW_PROMPT_TEMPLATE });
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
          "Save a default prompt template. If `isReview` is true, saves the review " +
          "default. Otherwise if `repoUrl` is set, saves the repo-scoped override; " +
          "otherwise saves the coding default. Defaults belong to the caller's " +
          "workspace (workspace admins) unless `scope` is `deployment` (deployment admins).",
        tags: ["Repos & Integrations"],
        body: saveTemplateSchema,
        response: {
          201: OkResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const workspaceId = req.user?.workspaceId ?? null;
      // The deployment's default is what every workspace without its own
      // reads; a workspace's is its admins' to set.
      const deployment = body.scope === "deployment" || !workspaceId;
      if (deployment) {
        if (!(await mayChangeDeploymentPrompts(req))) {
          return reply
            .status(403)
            .send({ error: "Only a deployment admin changes the deployment's default prompts" });
        }
      } else if (!isAuthDisabled() && req.user?.workspaceRole !== "admin") {
        return reply.status(403).send({ error: WORKSPACE_DEFAULT_REFUSAL });
      }
      const scope = deployment ? null : workspaceId;
      try {
        if (body.isReview) {
          await saveReviewDefaultTemplate(body.template, scope);
        } else if (body.repoUrl) {
          if (!scope && !isAuthDisabled()) {
            return reply
              .status(400)
              .send({ error: "A repo's prompt belongs to a workspace — save it there" });
          }
          await saveRepoPromptTemplate(body.repoUrl, body.template, body.autoMerge ?? false, scope);
        } else {
          await saveDefaultPromptTemplate(body.template, body.autoMerge ?? false, scope);
        }
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.status(409).send({
            error: "A prompt with the default's name is in the way — rename it in Prompts first",
          });
        }
        throw err;
      }
      reply.status(201).send({ ok: true });
    },
  );

  app.post(
    "/api/prompt-templates/seed",
    {
      // Starter rows have no workspace: every workspace lists them, so
      // restoring them is a deployment-wide write, not one workspace's.
      preHandler: [requireDeploymentAdmin],
      schema: {
        operationId: "seedStarterPrompts",
        summary: "Restore the starter prompts",
        description:
          "Add the organization's starter prompts (Create a Claude Code skill, Code " +
          "review, Write a README, …) that are missing, and put edited ones back to " +
          "their text. Never duplicates, and never touches a prompt of someone's own " +
          "that shares a starter's name. Starter prompts are shared by every " +
          "workspace, so this requires a deployment admin.",
        tags: ["Repos & Integrations"],
        response: {
          200: z.object({ created: z.number(), restored: z.number(), unchanged: z.number() }),
        },
      },
    },
    async (_req, reply) => {
      const { seedStarterPrompts } = await import("../services/starter-prompts.js");
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
    owner: z
      .enum(["workspace", "me"])
      .optional()
      .describe(
        "Who it belongs to: the organization (`workspace`, the default) or the caller (`me`)",
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
      const reserved = reservedPromptName(req.body.name);
      if (reserved) return reply.status(400).send({ error: reserved });
      try {
        const { owner, ...input } = req.body;
        const template = await createNamedTemplate({
          ...input,
          workspaceId: req.user?.workspaceId ?? null,
          ownerUserId: ownerForNew(owner, actorOf(req)),
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
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await requireVisibleTemplate(req, reply, id);
      if (!existing) return;
      // No workspace: the deployment's (starter prompts, defaults), every workspace's to read.
      if (!existing.workspaceId && !(await mayChangeDeploymentPrompts(req))) {
        return reply.status(403).send({ error: DEPLOYMENT_PROMPT_REFUSAL });
      }
      // The workspace's defaults are its admins', here as through POST /api/prompt-templates.
      if (isSystemPromptRow(existing) && !actorOf(req).isAdmin) {
        return reply.status(403).send({ error: WORKSPACE_DEFAULT_REFUSAL });
      }
      const reserved = req.body.name !== existing.name ? reservedPromptName(req.body.name) : null;
      if (reserved) return reply.status(400).send({ error: reserved });
      if (!canChange(existing.ownerUserId, actorOf(req), true, "edit")) {
        return reply
          .status(403)
          .send({ error: changeRefusal(existing.ownerUserId, "prompt", "member") });
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
      if (!existing.workspaceId && !(await mayChangeDeploymentPrompts(req))) {
        return reply.status(403).send({ error: DEPLOYMENT_PROMPT_REFUSAL });
      }
      if (isSystemPromptRow(existing) && !actorOf(req).isAdmin) {
        return reply.status(403).send({ error: WORKSPACE_DEFAULT_REFUSAL });
      }
      if (!canChange(existing.ownerUserId, actorOf(req), true, "delete")) {
        return reply
          .status(403)
          .send({ error: changeRefusal(existing.ownerUserId, "prompt", "member") });
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
