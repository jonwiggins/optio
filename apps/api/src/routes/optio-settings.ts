import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as optioSettingsService from "../services/optio-settings-service.js";
import { logAction } from "../services/optio-action-service.js";
import { AGENT_TYPES, ANTHROPIC_CATALOG } from "@optio/shared";
import { modelBelongsToAgent } from "../services/agent-options-service.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { requireRole } from "../plugins/auth.js";
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
    reviewDepth: z
      .enum(["thorough", "light"])
      .optional()
      .describe(
        "How deep a code review goes on a repo that sets no depth of its own (thorough by default)",
      ),
  })
  .describe("Partial update to Optio assistant settings");

const SettingsResponseSchema = z.object({ settings: z.unknown() });

export async function optioSettingsRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/optio/settings",
    {
      schema: {
        operationId: "getOptioSettings",
        summary: "Get the Optio assistant settings",
        description: "Return the current settings for the Optio conversational assistant.",
        tags: ["Setup & Settings"],
        response: { 200: SettingsResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const settings = await optioSettingsService.getSettings(workspaceId);
      reply.send({ settings });
    },
  );

  app.put(
    "/api/optio/settings",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "updateOptioSettings",
        summary: "Update the Optio assistant settings",
        description:
          "Upsert settings for the Optio assistant: model, system prompt, " +
          "enabled tools, confirm-writes flag, max turns.",
        tags: ["Setup & Settings"],
        body: updateSettingsSchema,
        response: { 200: SettingsResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const unavailable =
        runtimeRefusal(body.agentRuntime) ?? runtimeRefusal(body.defaultReviewAgentType);
      if (unavailable) return reply.status(400).send({ error: unavailable });
      const current = await optioSettingsService.getSettings(req.user?.workspaceId ?? null);
      const runtime = body.agentRuntime ?? current?.agentRuntime ?? "claude-code";
      if (
        body.model &&
        !(runtime === "claude-code"
          ? Object.hasOwn(ANTHROPIC_CATALOG.aliases, body.model) ||
            /^claude-[a-z0-9][a-z0-9.-]*$/.test(body.model)
          : await modelBelongsToAgent(runtime, body.model, {
              workspaceId: req.user?.workspaceId ?? null,
            }))
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
          { workspaceId: req.user?.workspaceId ?? null },
        );
        if (!known) {
          return reply.status(400).send({
            error: `Default review model "${body.defaultReviewModel}" does not belong to the "${body.defaultReviewAgentType}" catalog.`,
          });
        }
      }

      const workspaceId = req.user?.workspaceId ?? null;
      const settings = await optioSettingsService.upsertSettings(body, workspaceId);
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "settings.update",
        params: { ...body },
        result: {},
        success: true,
      }).catch(() => {});
      reply.send({ settings });
    },
  );
}
