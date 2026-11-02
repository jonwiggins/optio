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
  setDeploymentSetting,
  switchPolicy,
  workspaceCreationPolicy,
} from "../services/deployment-settings.js";
import { logAction } from "../services/optio-action-service.js";
import {
  SHARED_GIT_TOKEN_REPOS_KEY,
  SHARED_GIT_TOKEN_SWITCH,
  saveSharedGitTokenRules,
  sharedGitTokenPolicy,
  sharedGitTokenRuleViews,
} from "../services/shared-git-token-policy.js";
import { isAuthDisabled } from "../services/oauth/index.js";

/**
 * Deployment-wide settings (services/deployment-settings.ts), on
 * Settings → Access. Anyone signed in reads them (the web app shows "New
 * workspace" by `mayCreateWorkspace`); only a deployment admin changes them.
 * A value of null goes back to the deployment's own default
 * (`OPTIO_WORKSPACE_CREATION` / chart `workspaces.creation`,
 * `OPTIO_ONBOARDING` / chart `onboarding.enabled`).
 *
 * The shared git token (services/shared-git-token-policy.ts) has its own
 * pair, `/api/deployment-settings/shared-git-token`, for deployment admins
 * only: its allowlist names workspaces and repositories.
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

const SharedGitTokenRuleSchema = z.object({
  workspace: z.string().min(1).max(200).describe("Workspace slug (or id, when saving)"),
  pattern: z
    .string()
    .min(1)
    .max(500)
    .describe("host/group/repo, host/group/* (everything below), or * (every repo)"),
});

const SharedGitTokenSchema = DeploymentSwitchSchema.extend({
  repos: z
    .array(SharedGitTokenRuleSchema)
    .describe("The repositories each workspace may use the shared git token for"),
}).describe(
  "Whether the deployment's git token is used only for the repositories a deployment " +
    "admin allowed per workspace (off by default), and the allowlist",
);

const SharedGitTokenUpdateSchema = z
  .object({
    restricted: z
      .boolean()
      .nullable()
      .optional()
      .describe("Allowed repos only; null = the deployment's default"),
    repos: z.array(SharedGitTokenRuleSchema).max(1000).optional().describe("Replace the allowlist"),
  })
  .describe("Shared git token settings to change");

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
  })
  .describe("Deployment settings to change");

export async function deploymentSettingsRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  const current = async (req: Parameters<typeof mayCreateWorkspace>[0]) => ({
    workspaceCreation: await workspaceCreationPolicy(),
    remoteWorkspaces: await remoteWorkspacesPolicy(),
    onboarding: await switchPolicy(ONBOARDING),
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
          "Who may create workspaces and whether the getting-started guide shows (and " +
          "where each comes from), whether the caller may change the settings, and " +
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

  const sharedGitToken = async () => ({
    ...(await sharedGitTokenPolicy()),
    repos: await sharedGitTokenRuleViews(),
  });

  app.get(
    "/api/deployment-settings/shared-git-token",
    {
      schema: {
        operationId: "getSharedGitTokenSettings",
        summary: "Shared git token: allowed repos",
        description:
          "Whether the deployment's own git credentials (GitHub App, the organization's " +
          "GITHUB_TOKEN / GITLAB_TOKEN) are used only for repositories a deployment admin " +
          "allowed per workspace, and the allowlist. Deployment admins only.",
        tags: ["Setup & Settings"],
        response: { 200: SharedGitTokenSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!req.user && !isAuthDisabled()) {
        return reply.status(401).send({ error: "Authentication required" });
      }
      const refused = await refuseUnlessDeploymentAdmin(
        req,
        reply,
        "Only a deployment admin sees the shared git token's allowlist",
      );
      if (refused) return reply;
      reply.send(await sharedGitToken());
    },
  );

  app.put(
    "/api/deployment-settings/shared-git-token",
    {
      schema: {
        operationId: "updateSharedGitTokenSettings",
        summary: "Change the shared git token's allowed repos",
        description:
          "Deployment admins only. `restricted: null` returns the switch to the deployment's " +
          "default (`OPTIO_SHARED_GIT_TOKEN_RESTRICTED`); `repos` replaces the allowlist " +
          "(workspace by slug or id). An unknown workspace or a malformed pattern is a 400 " +
          "and saves nothing.",
        tags: ["Setup & Settings"],
        body: SharedGitTokenUpdateSchema,
        response: {
          200: SharedGitTokenSchema,
          400: ErrorResponseSchema,
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
      const log = (key: string, result: Record<string, unknown>) =>
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "deployment_settings.update",
          params: { name: key },
          result: { key, ...result },
          success: true,
        }).catch(() => {});
      if (req.body.repos !== undefined) {
        try {
          await saveSharedGitTokenRules(req.body.repos, req.user?.id ?? null);
        } catch (err) {
          return reply.status(400).send({ error: (err as Error).message });
        }
        log(SHARED_GIT_TOKEN_REPOS_KEY, { entries: req.body.repos.length });
      }
      if (req.body.restricted !== undefined) {
        await setDeploymentSetting(
          SHARED_GIT_TOKEN_SWITCH.key,
          req.body.restricted,
          req.user?.id ?? null,
        );
        log(SHARED_GIT_TOKEN_SWITCH.key, { value: req.body.restricted });
      }
      reply.send(await sharedGitToken());
    },
  );
}
