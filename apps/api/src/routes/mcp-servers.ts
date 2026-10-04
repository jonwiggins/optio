import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as mcpService from "../services/mcp-server-service.js";
import {
  actorOf,
  canChange,
  canSee,
  changeRefusal,
  ownerForNew,
  withOwnerNames,
} from "../services/ownership.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { McpServerSchema } from "../schemas/integration.js";
import { requireRole } from "../plugins/auth.js";

const scopeQuerySchema = z
  .object({
    scope: z.string().optional().describe("Optional scope filter (`global` | `repo`)"),
  })
  .describe("Query parameters for listing MCP servers");

const createMcpServerSchema = z
  .object({
    name: z.string().min(1),
    command: z.string().min(1).describe("Executable command the MCP server runs"),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional().describe("Environment variable bag"),
    installCommand: z.string().optional().describe("Optional install step to run once"),
    repoUrl: z.string().optional().describe("Optional repo scope; empty means global"),
    enabled: z.boolean().optional(),
    owner: z
      .enum(["workspace", "me"])
      .optional()
      .describe(
        "Who it belongs to: the organization (`workspace`, the default) or the caller (`me`)",
      ),
  })
  .describe("Body for creating an MCP server");

const updateMcpServerSchema = z
  .object({
    name: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).nullable().optional(),
    installCommand: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .describe("Partial update to an MCP server");

const ServersListResponseSchema = z.object({ servers: z.array(McpServerSchema) });
const ServerResponseSchema = z.object({ server: McpServerSchema });

/** The server, when it is in the caller's workspace and the caller may see it (else 404). */
async function requireVisibleServer(req: FastifyRequest, reply: FastifyReply, id: string) {
  const server = await mcpService.getMcpServer(id);
  const wsId = req.user?.workspaceId;
  if (
    !server ||
    (wsId && server.workspaceId && server.workspaceId !== wsId) ||
    !canSee(server.ownerUserId, actorOf(req))
  ) {
    reply.status(404).send({ error: "MCP server not found" });
    return null;
  }
  return server;
}

export async function mcpServerRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/mcp-servers",
    {
      schema: {
        operationId: "listMcpServers",
        summary: "List MCP servers",
        description:
          "List all configured MCP (Model Context Protocol) servers, " +
          "optionally filtered by scope.",
        tags: ["Repos & Integrations"],
        querystring: scopeQuerySchema,
        response: { 200: ServersListResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      // The organization's servers and the caller's own; admins see every one,
      // private ones named with their owner (services/ownership.ts).
      const servers = await withOwnerNames(
        await mcpService.listMcpServers(req.query.scope, workspaceId, actorOf(req)),
      );
      reply.send({ servers });
    },
  );

  app.get(
    "/api/mcp-servers/:id",
    {
      schema: {
        operationId: "getMcpServer",
        summary: "Get an MCP server",
        description: "Fetch a single MCP server by ID.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: ServerResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const server = await mcpService.getMcpServer(id);
      if (!server) return reply.status(404).send({ error: "MCP server not found" });
      const wsId = req.user?.workspaceId;
      if (
        (wsId && server.workspaceId && server.workspaceId !== wsId) ||
        !canSee(server.ownerUserId, actorOf(req))
      ) {
        return reply.status(404).send({ error: "MCP server not found" });
      }
      reply.send({ server });
    },
  );

  app.post(
    "/api/mcp-servers",
    {
      // Members add their own (`owner: me`); the organization's need an admin.
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createMcpServer",
        summary: "Create a global MCP server",
        description:
          "Register a new MCP server. Omit `repoUrl` to create a global server. " +
          "`owner: me` makes it the caller's private server (any member); the " +
          "organization's need an admin.",
        tags: ["Repos & Integrations"],
        body: createMcpServerSchema,
        response: { 201: ServerResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const actor = actorOf(req);
      const { owner, ...input } = req.body;
      const ownerUserId = ownerForNew(owner, actor);
      if (!ownerUserId && !actor.isAdmin) {
        return reply
          .status(403)
          .send({ error: "Only admins can add an MCP server for the organization" });
      }
      const server = await mcpService.createMcpServer({ ...input, ownerUserId }, workspaceId);
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "mcp_server.create",
        params: { name: req.body.name, command: req.body.command },
        result: { id: server.id },
        success: true,
      }).catch(() => {});
      reply.status(201).send({ server });
    },
  );

  app.patch(
    "/api/mcp-servers/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "updateMcpServer",
        summary: "Update an MCP server",
        description:
          "Partial update to an MCP server: the organization's by an admin, a private one by its owner.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: updateMcpServerSchema,
        response: { 200: ServerResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await requireVisibleServer(req, reply, id);
      if (!existing) return;
      const actor = actorOf(req);
      if (!canChange(existing.ownerUserId, actor, actor.isAdmin, "edit")) {
        return reply.status(403).send({ error: changeRefusal(existing.ownerUserId, "MCP server") });
      }
      const server = await mcpService.updateMcpServer(id, req.body);
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "mcp_server.update",
        params: { mcpServerId: id, ...req.body },
        result: { id },
        success: true,
      }).catch(() => {});
      reply.send({ server });
    },
  );

  app.delete(
    "/api/mcp-servers/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "deleteMcpServer",
        summary: "Delete an MCP server",
        description:
          "Delete an MCP server (the organization's: admins; a private one: its owner or an admin). Returns 204 on success.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await requireVisibleServer(req, reply, id);
      if (!existing) return;
      const actor = actorOf(req);
      if (!canChange(existing.ownerUserId, actor, actor.isAdmin, "delete")) {
        return reply.status(403).send({ error: changeRefusal(existing.ownerUserId, "MCP server") });
      }
      await mcpService.deleteMcpServer(id);
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "mcp_server.delete",
        params: { mcpServerId: id },
        result: { id },
        success: true,
      }).catch(() => {});
      reply.status(204).send(null);
    },
  );

  app.get(
    "/api/repos/:id/mcp-servers",
    {
      schema: {
        operationId: "listRepoMcpServers",
        summary: "List MCP servers for a repo",
        description:
          "Return the effective MCP server set for a repo: all global servers " +
          "plus any repo-scoped servers.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: ServersListResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { getRepo } = await import("../services/repo-service.js");
      const repo = await getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      const workspaceId = req.user?.workspaceId ?? null;
      // The set the caller's own work on this repo would get: the organization's plus theirs.
      const servers = await mcpService.getMcpServersForTask(
        repo.repoUrl,
        workspaceId,
        req.user?.id ?? null,
      );
      reply.send({ servers });
    },
  );

  app.post(
    "/api/repos/:id/mcp-servers",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createRepoMcpServer",
        summary: "Create a repo-scoped MCP server",
        description:
          "Register an MCP server that only applies to tasks for the given repo. " +
          "`owner: me` makes it the caller's private server; the organization's need an admin.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: createMcpServerSchema,
        response: { 201: ServerResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { getRepo } = await import("../services/repo-service.js");
      const repo = await getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      const workspaceId = req.user?.workspaceId ?? null;
      const actor = actorOf(req);
      const { owner, ...input } = req.body;
      const ownerUserId = ownerForNew(owner, actor);
      if (!ownerUserId && !actor.isAdmin) {
        return reply
          .status(403)
          .send({ error: "Only admins can add an MCP server for the organization" });
      }
      const server = await mcpService.createMcpServer(
        { ...input, repoUrl: repo.repoUrl, ownerUserId },
        workspaceId,
      );
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "mcp_server.create",
        params: { name: req.body.name, repoId: id },
        result: { id: server.id },
        success: true,
      }).catch(() => {});
      reply.status(201).send({ server });
    },
  );
}
