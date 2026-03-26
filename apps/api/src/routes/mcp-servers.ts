import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as mcpService from "../services/mcp-server-service.js";

const createMcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  installCommand: z.string().optional(),
  repoUrl: z.string().optional(),
  enabled: z.boolean().optional(),
});

const updateMcpServerSchema = z.object({
  name: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).nullable().optional(),
  installCommand: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function mcpServerRoutes(app: FastifyInstance) {
  // List MCP servers (global or filtered by scope)
  app.get("/api/mcp-servers", async (req, reply) => {
    const query = req.query as { scope?: string };
    const workspaceId = req.user?.workspaceId ?? null;
    const servers = await mcpService.listMcpServers(query.scope, workspaceId);
    reply.send({ servers });
  });

  // Get a single MCP server
  app.get("/api/mcp-servers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const server = await mcpService.getMcpServer(id);
    if (!server) return reply.status(404).send({ error: "MCP server not found" });
    reply.send({ server });
  });

  // Create a global MCP server
  app.post("/api/mcp-servers", async (req, reply) => {
    const input = createMcpServerSchema.parse(req.body);
    const workspaceId = req.user?.workspaceId ?? null;
    const server = await mcpService.createMcpServer(input, workspaceId);
    reply.status(201).send({ server });
  });

  // Update an MCP server
  app.patch("/api/mcp-servers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await mcpService.getMcpServer(id);
    if (!existing) return reply.status(404).send({ error: "MCP server not found" });
    const input = updateMcpServerSchema.parse(req.body);
    const server = await mcpService.updateMcpServer(id, input);
    reply.send({ server });
  });

  // Delete an MCP server
  app.delete("/api/mcp-servers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await mcpService.getMcpServer(id);
    if (!existing) return reply.status(404).send({ error: "MCP server not found" });
    await mcpService.deleteMcpServer(id);
    reply.status(204).send();
  });

  // List MCP servers for a specific repo (includes global servers)
  app.get("/api/repos/:id/mcp-servers", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { getRepo } = await import("../services/repo-service.js");
    const repo = await getRepo(id);
    if (!repo) return reply.status(404).send({ error: "Repo not found" });
    const workspaceId = req.user?.workspaceId ?? null;
    const servers = await mcpService.getMcpServersForTask(repo.repoUrl, workspaceId);
    reply.send({ servers });
  });

  // Create a repo-scoped MCP server
  app.post("/api/repos/:id/mcp-servers", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { getRepo } = await import("../services/repo-service.js");
    const repo = await getRepo(id);
    if (!repo) return reply.status(404).send({ error: "Repo not found" });
    const input = createMcpServerSchema.parse(req.body);
    const workspaceId = req.user?.workspaceId ?? null;
    const server = await mcpService.createMcpServer(
      { ...input, repoUrl: repo.repoUrl },
      workspaceId,
    );
    reply.status(201).send({ server });
  });
}
