import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as workspaceService from "../services/workspace-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { WorkspaceSchema, WorkspaceMemberSchema } from "../schemas/workspace.js";

const createWorkspaceSchema = z
  .object({
    name: z.string().min(1).max(100),
    slug: z
      .string()
      .min(1)
      .max(50)
      .regex(/^[a-z0-9-]+$/, "lowercase alphanumeric with hyphens only")
      .describe("URL-safe workspace slug"),
    description: z.string().max(500).optional(),
  })
  .describe("Body for creating a workspace");

const updateWorkspaceSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    slug: z
      .string()
      .min(1)
      .max(50)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    description: z.string().max(500).nullable().optional(),
    allowDockerInDocker: z.boolean().optional(),
  })
  .describe("Partial update to a workspace");

const addMemberSchema = z
  .object({
    userId: z.string().uuid(),
    role: z.enum(["admin", "member", "viewer"]).optional(),
  })
  .describe("Body for adding a workspace member");

const updateMemberSchema = z
  .object({
    role: z.enum(["admin", "member", "viewer"]),
  })
  .describe("Body for updating a member's role");

const memberParamsSchema = z
  .object({
    id: z.string().describe("Workspace UUID"),
    userId: z.string().describe("User UUID"),
  })
  .describe("Path parameters: workspace id + user id");

const WorkspaceListResponseSchema = z.object({ workspaces: z.array(WorkspaceSchema) });
const WorkspaceResponseSchema = z.object({ workspace: WorkspaceSchema });
const WorkspaceDetailResponseSchema = z.object({
  workspace: WorkspaceSchema,
  role: z.string(),
});
const MemberListResponseSchema = z.object({ members: z.array(WorkspaceMemberSchema) });
const OkResponseSchema = z.object({ ok: z.boolean() });

export async function workspaceRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/workspaces",
    {
      schema: {
        operationId: "listUserWorkspaces",
        summary: "List the current user's workspaces",
        description: "Return all workspaces the authenticated user is a member of.",
        tags: ["Workspaces"],
        response: { 200: WorkspaceListResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const workspaces = await workspaceService.listUserWorkspaces(req.user.id);
      reply.send({ workspaces });
    },
  );

  app.get(
    "/api/workspaces/:id",
    {
      schema: {
        operationId: "getWorkspace",
        summary: "Get a workspace",
        description: "Fetch a single workspace by ID. Returns 403 if the caller is not a member.",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        response: {
          200: WorkspaceDetailResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const { id } = req.params;
      const workspace = await workspaceService.getWorkspace(id);
      if (!workspace) return reply.status(404).send({ error: "Workspace not found" });

      const role = await workspaceService.getUserRole(id, req.user.id);
      if (!role) return reply.status(403).send({ error: "Not a member of this workspace" });

      reply.send({ workspace, role });
    },
  );

  app.post(
    "/api/workspaces",
    {
      schema: {
        operationId: "createWorkspace",
        summary: "Create a workspace",
        description: "Create a new workspace. The creator is automatically added as admin.",
        tags: ["Workspaces"],
        body: createWorkspaceSchema,
        response: { 201: WorkspaceResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const workspace = await workspaceService.createWorkspace(req.body, req.user.id);
      reply.status(201).send({ workspace });
    },
  );

  app.patch(
    "/api/workspaces/:id",
    {
      schema: {
        operationId: "updateWorkspace",
        summary: "Update a workspace",
        description: "Partial update to a workspace. Requires admin role in the workspace.",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        body: updateWorkspaceSchema,
        response: {
          200: WorkspaceResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const { id } = req.params;

      const role = await workspaceService.getUserRole(id, req.user.id);
      if (role !== "admin") return reply.status(403).send({ error: "Admin role required" });

      const workspace = await workspaceService.updateWorkspace(id, req.body);
      if (!workspace) return reply.status(404).send({ error: "Workspace not found" });
      reply.send({ workspace });
    },
  );

  app.delete(
    "/api/workspaces/:id",
    {
      schema: {
        operationId: "deleteWorkspace",
        summary: "Delete a workspace",
        description: "Delete a workspace and all of its associated data. Requires admin role.",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        response: {
          204: z.null(),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const { id } = req.params;

      const role = await workspaceService.getUserRole(id, req.user.id);
      if (role !== "admin") return reply.status(403).send({ error: "Admin role required" });

      await workspaceService.deleteWorkspace(id);
      reply.status(204).send(null);
    },
  );

  app.post(
    "/api/workspaces/:id/switch",
    {
      schema: {
        operationId: "switchActiveWorkspace",
        summary: "Switch the active workspace",
        description:
          "Update the current user's active workspace ID. Affects which " +
          "workspace is scoped on subsequent requests.",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        response: { 200: OkResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const { id } = req.params;
      await workspaceService.switchWorkspace(req.user.id, id);
      reply.send({ ok: true });
    },
  );

  app.get(
    "/api/workspaces/:id/members",
    {
      schema: {
        operationId: "listWorkspaceMembers",
        summary: "List workspace members",
        description: "Return all members of a workspace. Any member can call this.",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        response: {
          200: MemberListResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const { id } = req.params;

      const role = await workspaceService.getUserRole(id, req.user.id);
      if (!role) return reply.status(403).send({ error: "Not a member of this workspace" });

      const members = await workspaceService.listMembers(id);
      reply.send({ members });
    },
  );

  app.post(
    "/api/workspaces/:id/members",
    {
      schema: {
        operationId: "addWorkspaceMember",
        summary: "Add a member to a workspace",
        description:
          "Add an existing user to a workspace with the given role. Requires " +
          "admin role. Returns 404 if the target user does not exist, and 409 " +
          "if the user is already a member (use the role-update endpoint to " +
          "change an existing member's role).",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        body: addMemberSchema,
        response: {
          201: OkResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const { id } = req.params;

      const callerRole = await workspaceService.getUserRole(id, req.user.id);
      if (callerRole !== "admin") return reply.status(403).send({ error: "Admin role required" });

      try {
        await workspaceService.addMember(id, req.body.userId, req.body.role);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "User not found") {
          return reply.status(404).send({ error: "User not found" });
        }
        if (msg === "User is already a member of this workspace") {
          return reply.status(409).send({ error: msg });
        }
        throw err;
      }
      reply.status(201).send({ ok: true });
    },
  );

  app.patch(
    "/api/workspaces/:id/members/:userId",
    {
      schema: {
        operationId: "updateWorkspaceMemberRole",
        summary: "Update a member's role",
        description: "Change a workspace member's role. Requires admin role.",
        tags: ["Workspaces"],
        params: memberParamsSchema,
        body: updateMemberSchema,
        response: {
          200: OkResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const { id, userId } = req.params;

      const callerRole = await workspaceService.getUserRole(id, req.user.id);
      if (callerRole !== "admin") return reply.status(403).send({ error: "Admin role required" });

      await workspaceService.updateMemberRole(id, userId, req.body.role);
      reply.send({ ok: true });
    },
  );

  app.delete(
    "/api/workspaces/:id/members/:userId",
    {
      schema: {
        operationId: "removeWorkspaceMember",
        summary: "Remove a member from a workspace",
        description: "Remove a member. Requires admin role. Returns 204 on success.",
        tags: ["Workspaces"],
        params: memberParamsSchema,
        response: {
          204: z.null(),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: "Authentication required" });
      const { id, userId } = req.params;

      const callerRole = await workspaceService.getUserRole(id, req.user.id);
      if (callerRole !== "admin") return reply.status(403).send({ error: "Admin role required" });

      await workspaceService.removeMember(id, userId);
      reply.status(204).send(null);
    },
  );
}
