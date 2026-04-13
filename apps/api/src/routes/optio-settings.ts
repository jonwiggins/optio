import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as optioSettingsService from "../services/optio-settings-service.js";
import { logAction } from "../services/optio-action-service.js";

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
        response: { 200: SettingsResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const settings = await optioSettingsService.upsertSettings(req.body, workspaceId);
      logAction({
        userId: req.user?.id,
        action: "settings.update",
        params: { ...req.body },
        result: {},
        success: true,
      }).catch(() => {});
      reply.send({ settings });
    },
  );
}
