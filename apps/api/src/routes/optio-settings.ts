import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as optioSettingsService from "../services/optio-settings-service.js";
import { logAction } from "../services/optio-action-service.js";
import { AGENT_TYPES, ANTHROPIC_CATALOG } from "@optio/shared";
import { modelBelongsToAgent } from "../services/agent-options-service.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { requireDeploymentAdmin, requireRole } from "../plugins/auth.js";
import { runtimeRefusal } from "../services/feature-guard.js";

const updateSettingsSchema = z
  .object({
    agentRuntime: z
      .enum(["claude-code", "codex", "copilot", "gemini", "opencode", "cursor", "pi"])
      .optional(),
    agentOptions: z.record(z.union([z.string().max(2000), z.boolean()])).optional(),
    model: z
      .string()
      .trim()
      .max(128)
      .optional()
      .describe("Model for the selected assistant harness; blank uses its default"),
    systemPrompt: z.string().optional(),
    enabledTools: z
      .array(z.string())
      .optional()
      .describe("Subset of controller MCP tools; an empty array enables all"),
    confirmWrites: z.boolean().optional().describe("If true, prompt before write operations"),
    maxTurns: z.number().int().min(5).max(50).optional(),
    defaultReviewAgentType: z
      .enum([...AGENT_TYPES] as [string, ...string[]])
      .nullable()
      .optional()
      .describe("Workspace-level default agent for code reviews; null to clear"),
    defaultReviewModel: z
      .string()
      .nullable()
      .optional()
      .describe("Workspace-level default review model; null to clear"),
    scope: z
      .enum(["workspace", "deployment"])
      .optional()
      .describe(
        "Whose settings to change: the caller's workspace's (`workspace`, the default; " +
          "workspace admins), or the deployment's, which every workspace without its own " +
          "reads (`deployment`; deployment admins)",
      ),
  })
  .describe("Partial update to Optio assistant settings");

const settingsQuerySchema = z
  .object({
    scope: z
      .enum(["workspace", "deployment"])
      .optional()
      .describe(
        "Whose settings to read: the caller's workspace's (the default), or the " +
          "deployment's (deployment admins)",
      ),
  })
  .describe("Query parameters for reading the Optio assistant settings");

const SettingsResponseSchema = z.object({
  settings: z.unknown(),
  source: z
    .enum(["workspace", "deployment", "builtin"])
    .optional()
    .describe(
      "Where the settings come from: the workspace's own, the deployment's defaults " +
        "(the workspace has none of its own), or the built-in defaults (nothing saved)",
    ),
});

type Scope = "workspace" | "deployment" | undefined;

/**
 * The deployment's settings (no workspace) are what every workspace without
 * its own reads, so reading or changing them takes a deployment admin, as
 * the deployment's default prompts do; a workspace's take its admin to change.
 */
async function requireScopeRole(
  scope: Scope,
  req: FastifyRequest,
  reply: FastifyReply,
  workspaceRole?: "admin",
) {
  if (scope === "deployment") return requireDeploymentAdmin(req, reply);
  if (workspaceRole) return requireRole(workspaceRole)(req, reply);
}

/** Where `settings` (read for `workspaceId`) came from: a saved row has an id. */
function sourceOf(
  settings: { id?: string; workspaceId?: string | null } | null | undefined,
  workspaceId: string | null,
): "workspace" | "deployment" | "builtin" {
  if (!settings?.id) return "builtin";
  return workspaceId && settings.workspaceId === workspaceId ? "workspace" : "deployment";
}

export async function optioSettingsRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/optio/settings",
    {
      preHandler: [(req, reply) => requireScopeRole(req.query.scope, req, reply)],
      schema: {
        operationId: "getOptioSettings",
        summary: "Get the Optio assistant settings",
        description:
          "Return the current settings for the Optio conversational assistant: the " +
          "workspace's own, else the deployment's, else the built-in defaults. With " +
          "`scope=deployment` (deployment admins), the deployment's.",
        tags: ["Setup & Settings"],
        querystring: settingsQuerySchema,
        response: {
          200: SettingsResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const workspaceId = req.query.scope === "deployment" ? null : (req.user?.workspaceId ?? null);
      const settings = await optioSettingsService.getSettings(workspaceId);
      reply.send({ settings, source: sourceOf(settings, workspaceId) });
    },
  );

  app.put(
    "/api/optio/settings",
    {
      preHandler: [(req, reply) => requireScopeRole(req.body.scope, req, reply, "admin")],
      schema: {
        operationId: "updateOptioSettings",
        summary: "Update the Optio assistant settings",
        description:
          "Upsert settings for the Optio assistant: model, system prompt, " +
          "enabled tools, confirm-writes flag, max turns. The caller's workspace's " +
          "(workspace admins) unless `scope` is `deployment` (deployment admins).",
        tags: ["Setup & Settings"],
        body: updateSettingsSchema,
        response: {
          200: SettingsResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { scope, ...body } = req.body;
      // The deployment's row has no workspace; checking a model against the
      // live list uses the deployment's credentials there.
      const workspaceId = scope === "deployment" ? null : (req.user?.workspaceId ?? null);
      const unavailable =
        runtimeRefusal(body.agentRuntime) ?? runtimeRefusal(body.defaultReviewAgentType);
      if (unavailable) return reply.status(400).send({ error: unavailable });
      const current = await optioSettingsService.getSettings(workspaceId);
      const runtime = body.agentRuntime ?? current?.agentRuntime ?? "claude-code";
      if (
        body.model &&
        !(runtime === "claude-code"
          ? Object.hasOwn(ANTHROPIC_CATALOG.aliases, body.model) ||
            /^claude-[a-z0-9][a-z0-9.-]*$/.test(body.model)
          : await modelBelongsToAgent(runtime, body.model, { workspaceId }))
      ) {
        return reply.status(400).send({ error: `Model does not belong to ${runtime}` });
      }
      if (body.agentRuntime && body.agentRuntime !== current?.agentRuntime) {
        body.model ??= "";
        body.agentOptions ??= {};
      }

      // Mirror the per-repo validation: a default review model only makes
      // sense in the context of an explicit agent. If both fields are
      // provided, the model must be one that agent offers — in the baseline
      // catalog or the live list the picker shows (#644).
      if (body.defaultReviewAgentType && body.defaultReviewModel) {
        const known = await modelBelongsToAgent(
          body.defaultReviewAgentType,
          body.defaultReviewModel,
          { workspaceId },
        );
        if (!known) {
          return reply.status(400).send({
            error: `Default review model "${body.defaultReviewModel}" does not belong to the "${body.defaultReviewAgentType}" catalog.`,
          });
        }
      }

      const settings = await optioSettingsService.upsertSettings(body, workspaceId);
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "settings.update",
        params: scope ? { ...body, scope } : { ...body },
        result: {},
        success: true,
      }).catch(() => {});
      reply.send({ settings, source: workspaceId ? "workspace" : "deployment" });
    },
  );
}
