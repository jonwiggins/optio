import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as optioSettingsService from "../services/optio-settings-service.js";
import { logAction } from "../services/optio-action-service.js";
import { AGENT_TYPES, modelBelongsToAgentCatalog } from "@optio/shared";
import { ErrorResponseSchema } from "../schemas/common.js";

const updateSettingsSchema = z
  .object({
    model: z
      .enum(["opus", "sonnet", "haiku"])
      .optional()
      .describe("Claude model for the Optio assistant"),
    systemPrompt: z.string().optional(),
    enabledTools: z
      .array(z.string())
      .min(1, "At least one tool must be enabled")
      .optional()
      .describe("Subset of tools the assistant is allowed to use"),
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

      // Mirror the per-repo validation: a default review model only makes
      // sense in the context of an explicit agent. If both fields are
      // provided, the model must belong to that agent's catalog.
      if (body.defaultReviewAgentType && body.defaultReviewModel) {
        if (!modelBelongsToAgentCatalog(body.defaultReviewAgentType, body.defaultReviewModel)) {
          return reply.status(400).send({
            error: `Default review model "${body.defaultReviewModel}" does not belong to the "${body.defaultReviewAgentType}" catalog.`,
          });
        }
      }

      const workspaceId = req.user?.workspaceId ?? null;
      const settings = await optioSettingsService.upsertSettings(body, workspaceId);
      logAction({
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
