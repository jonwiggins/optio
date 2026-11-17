import {
  REMOTE_WORKSPACES_SWITCH,
  remoteWorkspacesPolicy,
} from "../services/remote-workspace-policy.js";
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
  ONBOARDING,
  WORKSPACE_CREATION_KEY,
  isLimitValue,
  limitPolicy,
  setDeploymentSetting,
  switchPolicy,
  workspaceCreationPolicy,
  type DeploymentLimit,
} from "../services/deployment-settings.js";
import {
  CLI_KEY_MAX_DAYS,
  SESSION_IDLE_MINUTES,
  SESSION_MAX_HOURS,
} from "../services/credential-lifetimes.js";
import { logAction } from "../services/optio-action-service.js";
import { isAuthDisabled } from "../services/oauth/index.js";

/**
 * Deployment-wide settings (services/deployment-settings.ts), on
 * Settings → Access. Anyone signed in reads them (the web app shows "New
 * workspace" by `mayCreateWorkspace`); only a deployment admin changes them.
 * A value of null goes back to the deployment's own default
 * (`OPTIO_WORKSPACE_CREATION` / chart `workspaces.creation`,
 * `OPTIO_ONBOARDING` / chart `onboarding.enabled`, and the session and CLI
 * key lifetimes in services/credential-lifetimes.ts).
 *
 * A feature that adds a setting adds its field to `SettingsResponseSchema`
 * and `UpdateBodySchema`, and its line to `current` and the `changes` below;
 * an on / off one answers as a `DeploymentSwitchSchema`.
 */

const SettingSourceSchema = z
  .enum(["app", "environment"])
  .describe("Saved in the app, or the deployment's environment default");

/** An on / off behaviour (services/deployment-settings.ts `SwitchPolicy`). */
const DeploymentSwitchSchema = z.object({
  value: z.boolean().describe("On now"),
  source: SettingSourceSchema,
  environment: z.boolean().describe("The environment's default"),
});

const WorkspaceCreationSchema = z.enum(["admins", "everyone"]);

/** A whole-number limit (services/deployment-settings.ts `LimitPolicy`). */
const DeploymentLimitSchema = z.object({
  value: z.number().int().nullable().describe("The limit now; null: none"),
  source: SettingSourceSchema,
  environment: z.number().int().nullable().describe("The environment's default; null: none"),
  min: z.number().int(),
  max: z.number().int(),
});

/** A limit to save: a whole number in bounds, 0 for "no limit", null to follow the deployment. */
const limitInput = (limit: DeploymentLimit, what: string) =>
  z
    .number()
    .int()
    .refine((v) => isLimitValue(limit, v), {
      message: `${what} must be 0 (no limit) or between ${limit.min} and ${limit.max}`,
    })
    .nullable()
    .optional()
    .describe(`${what}; 0 = no limit, null = the deployment's default`);

const withBounds = async (limit: DeploymentLimit) => ({
  ...(await limitPolicy(limit)),
  min: limit.min,
  max: limit.max,
});

const SettingsResponseSchema = z.object({
  remoteWorkspaces: DeploymentSwitchSchema,
  workspaceCreation: z
    .object({
      value: WorkspaceCreationSchema,
      source: SettingSourceSchema,
      environment: WorkspaceCreationSchema,
    })
    .describe("Who may create a workspace (everyone by default)"),
  onboarding: DeploymentSwitchSchema.describe(
    "The getting-started checklist and the in-app guide (off by default)",
  ),
  sessionMaxHours: DeploymentLimitSchema.describe(
    "Hours a sign-in session lasts at most (none: the built-in 30 days)",
  ),
  sessionIdleMinutes: DeploymentLimitSchema.describe(
    "Minutes unused after which a session ends (none: the built-in 7 days)",
  ),
  cliKeyMaxDays: DeploymentLimitSchema.describe(
    "Days a key made by a CLI login lasts (none: it never expires); new keys only",
  ),
  canEdit: z.boolean().describe("The caller is a deployment admin"),
  mayCreateWorkspace: z.boolean().describe("The caller may create a workspace now"),
});

const UpdateBodySchema = z
  .object({
    remoteWorkspaces: z.boolean().nullable().optional(),
    workspaceCreation: WorkspaceCreationSchema.nullable()
      .optional()
      .describe("Who may create a workspace; null = the deployment's default"),
    onboarding: z
      .boolean()
      .nullable()
      .optional()
      .describe(
        "Show the getting-started checklist and the guide; null = the deployment's default",
      ),
    sessionMaxHours: limitInput(SESSION_MAX_HOURS, "Session max lifetime in hours"),
    sessionIdleMinutes: limitInput(SESSION_IDLE_MINUTES, "Session idle timeout in minutes"),
    cliKeyMaxDays: limitInput(CLI_KEY_MAX_DAYS, "CLI key lifetime in days"),
  })
  .describe("Deployment settings to change");

export async function deploymentSettingsRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  const current = async (req: Parameters<typeof mayCreateWorkspace>[0]) => ({
    workspaceCreation: await workspaceCreationPolicy(),
    remoteWorkspaces: await remoteWorkspacesPolicy(),
    onboarding: await switchPolicy(ONBOARDING),
    sessionMaxHours: await withBounds(SESSION_MAX_HOURS),
    sessionIdleMinutes: await withBounds(SESSION_IDLE_MINUTES),
    cliKeyMaxDays: await withBounds(CLI_KEY_MAX_DAYS),
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
          "Who may create workspaces, whether the getting-started guide shows, and the " +
          "session and CLI key lifetimes (and where each comes from), whether the caller may change the settings, and " +
          "whether the caller may create a workspace now.",
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
      if (req.body.remoteWorkspaces !== undefined)
        changes.push([REMOTE_WORKSPACES_SWITCH.key, req.body.remoteWorkspaces]);
      if (req.body.workspaceCreation !== undefined)
        changes.push([WORKSPACE_CREATION_KEY, req.body.workspaceCreation]);
      if (req.body.onboarding !== undefined) changes.push([ONBOARDING.key, req.body.onboarding]);
      for (const [field, limit] of [
        ["sessionMaxHours", SESSION_MAX_HOURS],
        ["sessionIdleMinutes", SESSION_IDLE_MINUTES],
        ["cliKeyMaxDays", CLI_KEY_MAX_DAYS],
      ] as const) {
        if (req.body[field] !== undefined) changes.push([limit.key, req.body[field]]);
      }
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
