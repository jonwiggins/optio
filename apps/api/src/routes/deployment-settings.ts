import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponseSchema } from "../schemas/common.js";
import {
  mayCreateWorkspace,
  refuseUnlessDeploymentAdmin,
  requesterIsDeploymentAdmin,
} from "../services/deployment-admin-gates.js";
import {
  WORKSPACE_CREATION_KEY,
  setDeploymentSetting,
  workspaceCreationPolicy,
} from "../services/deployment-settings.js";
import { logAction } from "../services/optio-action-service.js";
import { isAuthDisabled } from "../services/oauth/index.js";

/**
 * Deployment-wide settings (services/deployment-settings.ts), on
 * Settings → Access. Anyone signed in reads them (the web app shows "New
 * workspace" by `mayCreateWorkspace`); only a deployment admin changes them.
 * A value of null goes back to the deployment's own default
 * (`OPTIO_WORKSPACE_CREATION` / chart `workspaces.creation`).
 *
 * A feature that adds a setting adds its field to `SettingsResponseSchema`
 * and `UpdateBodySchema`, and its line to `current` and the `changes` below;
 * an on / off one answers as a `DeploymentSwitchSchema`.
 */

export const SettingSourceSchema = z
  .enum(["app", "environment"])
  .describe("Saved in the app, or the deployment's environment default");

/** An on / off behaviour (services/deployment-settings.ts `SwitchPolicy`). */
export const DeploymentSwitchSchema = z.object({
  value: z.boolean().describe("On now"),
  source: SettingSourceSchema,
  environment: z.boolean().describe("The environment's default"),
});

const WorkspaceCreationSchema = z.enum(["admins", "everyone"]);

const SettingsResponseSchema = z.object({
  workspaceCreation: z
    .object({
      value: WorkspaceCreationSchema,
      source: SettingSourceSchema,
      environment: WorkspaceCreationSchema,
    })
    .describe("Who may create a workspace (everyone by default)"),
  canEdit: z.boolean().describe("The caller is a deployment admin"),
  mayCreateWorkspace: z.boolean().describe("The caller may create a workspace now"),
});

const UpdateBodySchema = z
  .object({
    workspaceCreation: WorkspaceCreationSchema.nullable()
      .optional()
      .describe("Who may create a workspace; null = the deployment's default"),
  })
  .describe("Deployment settings to change");

export async function deploymentSettingsRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  const current = async (req: Parameters<typeof mayCreateWorkspace>[0]) => ({
    workspaceCreation: await workspaceCreationPolicy(),
    canEdit: await requesterIsDeploymentAdmin(req),
    mayCreateWorkspace: await mayCreateWorkspace(req),
  });

  app.get(
    "/api/deployment-settings",
    {
      schema: {
        operationId: "getDeploymentSettings",
        summary: "Deployment-wide settings",
        description:
          "Who may create workspaces (and where that comes from), whether the caller " +
          "may change the settings, and whether the caller may create a workspace now.",
        tags: ["Setup & Settings"],
        response: { 200: SettingsResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      // With auth disabled the local dev user acts as the admin, as on every settings route.
      if (!req.user && !isAuthDisabled()) {
        return reply.status(401).send({ error: "Authentication required" });
      }
      reply.send(await current(req));
    },
  );

  app.put(
    "/api/deployment-settings",
    {
      schema: {
        operationId: "updateDeploymentSettings",
        summary: "Change deployment-wide settings",
        description:
          "Deployment admins only. `null` returns a setting to the deployment's default.",
        tags: ["Setup & Settings"],
        body: UpdateBodySchema,
        response: {
          200: SettingsResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user && !isAuthDisabled()) {
        return reply.status(401).send({ error: "Authentication required" });
      }
      const refused = await refuseUnlessDeploymentAdmin(
        req,
        reply,
        "Only a deployment admin changes deployment settings",
      );
      if (refused) return reply;
      const changes: Array<[string, unknown]> = [];
      if (req.body.workspaceCreation !== undefined)
        changes.push([WORKSPACE_CREATION_KEY, req.body.workspaceCreation]);
      for (const [key, value] of changes) {
        await setDeploymentSetting(key, value, req.user?.id ?? null);
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "deployment_settings.update",
          params: { name: key },
          // The log keeps only allowlisted params (optio-action-service.ts).
          result: { key, value },
          success: true,
        }).catch(() => {});
      }
      reply.send(await current(req));
    },
  );
}
