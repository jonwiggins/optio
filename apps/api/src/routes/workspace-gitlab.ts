import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { logAction } from "../services/optio-action-service.js";
import * as gitlab from "../services/workspace-gitlab-service.js";

/**
 * Workspace Settings → GitLab: the GitLab servers this workspace signs in
 * to with its own credentials. Members read the list (never a token);
 * admins add, replace, re-default and remove servers. Every route acts on
 * the caller's current workspace only.
 */

const ServerSchema = z
  .object({
    id: z.string(),
    host: z.string().describe("Lower-case host, with a port when it is not 443"),
    accountUsername: z.string().nullable().describe("Who the token signs in as"),
    accountName: z.string().nullable(),
    isDefault: z.boolean().describe("The server the Add repository picker lists first"),
    hasToken: z.boolean(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .describe("A GitLab server the workspace signs in to with its own token");

const SettingsResponseSchema = z
  .object({
    servers: z.array(ServerSchema),
    allowedHosts: z
      .array(z.string())
      .describe("Hosts the operator lets credentials go to (gitlab.com and GITLAB_HOSTS)"),
    deploymentFallback: z
      .boolean()
      .describe(
        "Whether this workspace falls back to the deployment's GitLab credentials when it has none of its own",
      ),
  })
  .describe("This workspace's GitLab configuration");

const CreateBodySchema = z
  .object({
    host: z.string().min(1).max(300),
    token: z.string().min(1).max(4096),
    isDefault: z.boolean().optional(),
  })
  .describe("A GitLab server and the token this workspace signs in with");

const UpdateBodySchema = z
  .object({
    token: z.string().min(1).max(4096).optional().describe("Replace the stored token"),
    isDefault: z.literal(true).optional().describe("Make this the workspace's default server"),
  })
  .describe("Change a GitLab server");

const ServerParamsSchema = z
  .object({ id: z.string().uuid().describe("The server's id") })
  .describe("Path parameters: GitLab server id");

const ServerResponseSchema = z.object({ server: ServerSchema });

function workspaceOf(req: { user?: { workspaceId?: string | null } }, reply: FastifyReply) {
  const workspaceId = req.user?.workspaceId ?? null;
  if (!workspaceId) {
    reply.status(400).send({
      error:
        "There is no workspace here (sign-in is off): the deployment's GITLAB_TOKEN / GITLAB_HOST apply",
      details: "no_workspace",
    });
    return null;
  }
  return workspaceId;
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof gitlab.WorkspaceGitLabError) {
    return reply.status(err.status).send({ error: err.message });
  }
  throw err;
}

export async function workspaceGitLabRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/workspace/gitlab",
    {
      schema: {
        operationId: "getWorkspaceGitLab",
        summary: "This workspace's GitLab servers",
        description:
          "The GitLab servers the current workspace signs in to with its own " +
          "tokens (never the tokens), the hosts a workspace may add, and " +
          "whether it falls back to the deployment's GitLab credentials.",
        tags: ["Workspaces"],
        response: { 200: SettingsResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = workspaceOf(req, reply);
      if (!workspaceId) return;
      const [servers, deploymentFallback] = await Promise.all([
        gitlab.listWorkspaceGitLabServers(workspaceId),
        gitlab.mayUseDeploymentGitLab(workspaceId),
      ]);
      reply.send({ servers, allowedHosts: gitlab.operatorGitLabHosts(), deploymentFallback });
    },
  );

  app.post(
    "/api/workspace/gitlab/servers",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "addWorkspaceGitLabServer",
        summary: "Add a GitLab server to this workspace",
        description:
          "Store the token this workspace signs in to a GitLab server with. " +
          "The host must be gitlab.com or listed in GITLAB_HOSTS; the token " +
          "is checked against the server's /api/v4/user before it is stored. " +
          "Saving a host the workspace already has replaces its token. The " +
          "token is used for this workspace only. Requires workspace admin.",
        tags: ["Workspaces"],
        body: CreateBodySchema,
        response: { 201: ServerResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = workspaceOf(req, reply);
      if (!workspaceId) return;
      try {
        const server = await gitlab.saveWorkspaceGitLabServer(workspaceId, req.body, {
          userId: req.user?.id ?? null,
        });
        logAction({
          workspaceId,
          userId: req.user?.id,
          action: "workspace.gitlab.save",
          params: { host: server.host },
          result: { id: server.id, account: server.accountUsername },
          success: true,
        }).catch(() => {});
        reply.status(201).send({ server });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.patch(
    "/api/workspace/gitlab/servers/:id",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "updateWorkspaceGitLabServer",
        summary: "Change a GitLab server of this workspace",
        description:
          "Replace a server's token (checked against the server first) or make " +
          "it the workspace's default. Requires workspace admin.",
        tags: ["Workspaces"],
        params: ServerParamsSchema,
        body: UpdateBodySchema,
        response: { 200: ServerResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = workspaceOf(req, reply);
      if (!workspaceId) return;
      try {
        const existing = (await gitlab.listWorkspaceGitLabServers(workspaceId)).find(
          (s) => s.id === req.params.id,
        );
        if (!existing) return reply.status(404).send({ error: "GitLab server not found" });
        if (req.body.token) {
          await gitlab.saveWorkspaceGitLabServer(
            workspaceId,
            { host: existing.host, token: req.body.token, isDefault: req.body.isDefault },
            { userId: req.user?.id ?? null },
          );
        } else if (req.body.isDefault) {
          await gitlab.setDefaultWorkspaceGitLabServer(workspaceId, existing.id);
        }
        const server = (await gitlab.listWorkspaceGitLabServers(workspaceId)).find(
          (s) => s.id === existing.id,
        )!;
        logAction({
          workspaceId,
          userId: req.user?.id,
          action: "workspace.gitlab.update",
          params: { host: server.host, token: !!req.body.token, isDefault: !!req.body.isDefault },
          result: { id: server.id },
          success: true,
        }).catch(() => {});
        reply.send({ server });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete(
    "/api/workspace/gitlab/servers/:id",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "removeWorkspaceGitLabServer",
        summary: "Remove a GitLab server from this workspace",
        description:
          "Delete the server and the workspace's token for it. Work on that " +
          "server then has no GitLab credentials from this workspace. " +
          "Requires workspace admin.",
        tags: ["Workspaces"],
        params: ServerParamsSchema,
        response: { 204: z.null(), 400: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = workspaceOf(req, reply);
      if (!workspaceId) return;
      try {
        await gitlab.removeWorkspaceGitLabServer(workspaceId, req.params.id);
        logAction({
          workspaceId,
          userId: req.user?.id,
          action: "workspace.gitlab.remove",
          params: { id: req.params.id },
          result: {},
          success: true,
        }).catch(() => {});
        reply.status(204).send(null);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
