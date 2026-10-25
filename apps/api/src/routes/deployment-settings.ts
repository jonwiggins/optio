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
  MERGE_CONFIRMATION_KEY,
  ONBOARDING_KEY,
  TEAMS_KEY,
  WORKSPACE_CREATION_KEY,
  setDeploymentSetting,
  switchPolicy,
  workspaceCreationPolicy,
} from "../services/deployment-settings.js";
import { logAction } from "../services/optio-action-service.js";

/**
 * Deployment-wide settings (services/deployment-settings.ts), on
 * Settings → Access. Anyone signed in reads them (the web app shows "New
 * workspace" by `mayCreateWorkspace`, and Teams only while `teams` is on);
 * only a deployment admin changes them. A value of null goes back to the
 * deployment's own default (`OPTIO_WORKSPACE_CREATION` / chart
 * `workspaces.creation`, `OPTIO_TEAMS_ENABLED` / chart `teams.enabled`,
 * `OPTIO_MERGE_CONFIRMATION` / chart `merge.confirmation`, `OPTIO_ONBOARDING` /
 * chart `onboarding.enabled`).
 */

const WorkspaceCreationSchema = z.enum(["admins", "everyone"]);

const SwitchSchema = z.object({
  value: z.boolean(),
  source: z.enum(["app", "environment"]),
  environment: z.boolean(),
});

const SettingsResponseSchema = z.object({
  workspaceCreation: z.object({
    value: WorkspaceCreationSchema,
    source: z.enum(["app", "environment"]),
    environment: WorkspaceCreationSchema,
  }),
  teams: SwitchSchema.describe("Teams are on (off by default)"),
  mergeConfirmation: SwitchSchema.describe(
    "Automatic merging needs the checkbox and a confirmation (off by default)",
  ),
  onboarding: SwitchSchema.describe(
    "The getting-started checklist and the in-app guide show (off by default)",
  ),
  canEdit: z.boolean().describe("The caller is a deployment admin"),
  mayCreateWorkspace: z.boolean().describe("The caller may create a workspace now"),
});

const UpdateBodySchema = z
  .object({
    workspaceCreation: WorkspaceCreationSchema.nullable()
      .optional()
      .describe("Who may create a workspace; null = the deployment's default"),
    teams: z
      .boolean()
      .nullable()
      .optional()
      .describe("Teams on or off; null = the deployment's default"),
    mergeConfirmation: z
      .boolean()
      .nullable()
      .optional()
      .describe("Automatic merging needs a confirmation; null = the deployment's default"),
    onboarding: z
      .boolean()
      .nullable()
      .optional()
      .describe("The getting-started guide on or off; null = the deployment's default"),
  })
  .describe("Deployment settings to change");

export async function deploymentSettingsRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  const current = async (req: Parameters<typeof mayCreateWorkspace>[0]) => ({
    workspaceCreation: await workspaceCreationPolicy(),
    teams: await switchPolicy(TEAMS_KEY),
    mergeConfirmation: await switchPolicy(MERGE_CONFIRMATION_KEY),
    onboarding: await switchPolicy(ONBOARDING_KEY),
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
          "Who may create workspaces, whether teams are on, whether automatic merging " +
          "needs a confirmation and whether the getting-started guide shows (and where each " +
          "comes from), whether the caller may change them, and whether the caller may " +
          "create a workspace now.",
        tags: ["Setup & Settings"],
        response: { 200: SettingsResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
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
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const refused = await refuseUnlessDeploymentAdmin(
        req,
        reply,
        "Only a deployment admin changes deployment settings",
      );
      if (refused) return reply;
      const changes: Array<[string, unknown]> = [];
      if (req.body.workspaceCreation !== undefined)
        changes.push([WORKSPACE_CREATION_KEY, req.body.workspaceCreation]);
      if (req.body.teams !== undefined) changes.push([TEAMS_KEY, req.body.teams]);
      if (req.body.mergeConfirmation !== undefined)
        changes.push([MERGE_CONFIRMATION_KEY, req.body.mergeConfirmation]);
      if (req.body.onboarding !== undefined) changes.push([ONBOARDING_KEY, req.body.onboarding]);
      for (const [key, value] of changes) {
        await setDeploymentSetting(key, value, req.user.id ?? null);
        logAction({
          workspaceId: req.user.workspaceId ?? null,
          userId: req.user.id,
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
