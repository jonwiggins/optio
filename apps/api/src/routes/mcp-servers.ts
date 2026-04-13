import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as mcpService from "../services/mcp-server-service.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { McpServerSchema } from "../schemas/integration.js";

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
      const servers = await mcpService.listMcpServers(req.query.scope, workspaceId);
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
      if (wsId && server.workspaceId && server.workspaceId !== wsId) {
        return reply.status(404).send({ error: "MCP server not found" });
      }
      reply.send({ server });
    },
  );

  app.post(
    "/api/mcp-servers",
    {
      schema: {
        operationId: "createMcpServer",
        summary: "Create a global MCP server",
        description: "Register a new MCP server. Omit `repoUrl` to create a global server.",
        tags: ["Repos & Integrations"],
        body: createMcpServerSchema,
        response: { 201: ServerResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const server = await mcpService.createMcpServer(req.body, workspaceId);
      logAction({
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
      schema: {
        operationId: "updateMcpServer",
        summary: "Update an MCP server",
        description: "Partial update to an MCP server.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: updateMcpServerSchema,
        response: { 200: ServerResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await mcpService.getMcpServer(id);
      if (!existing) return reply.status(404).send({ error: "MCP server not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "MCP server not found" });
      }
      const server = await mcpService.updateMcpServer(id, req.body);
      logAction({
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
      schema: {
        operationId: "deleteMcpServer",
        summary: "Delete an MCP server",
        description: "Delete an MCP server. Returns 204 on success.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await mcpService.getMcpServer(id);
      if (!existing) return reply.status(404).send({ error: "MCP server not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "MCP server not found" });
      }
      await mcpService.deleteMcpServer(id);
      logAction({
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
      const servers = await mcpService.getMcpServersForTask(repo.repoUrl, workspaceId);
      reply.send({ servers });
    },
  );

  app.post(
    "/api/repos/:id/mcp-servers",
    {
      schema: {
        operationId: "createRepoMcpServer",
        summary: "Create a repo-scoped MCP server",
        description: "Register an MCP server that only applies to tasks for the given repo.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: createMcpServerSchema,
        response: { 201: ServerResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { getRepo } = await import("../services/repo-service.js");
      const repo = await getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      const workspaceId = req.user?.workspaceId ?? null;
      const server = await mcpService.createMcpServer(
        { ...req.body, repoUrl: repo.repoUrl },
        workspaceId,
      );
      logAction({
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
