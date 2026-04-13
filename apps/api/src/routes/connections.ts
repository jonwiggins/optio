import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as connectionService from "../services/connection-service.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import {
  ConnectionProviderSchema,
  ConnectionSchema,
  ConnectionAssignmentSchema,
} from "../schemas/integration.js";

// ── Request schemas ───────────────────────────────────────────────────────

const SlugParamsSchema = z
  .object({ slug: z.string().describe("Provider slug (e.g. 'notion', 'postgres')") })
  .describe("Path parameters: provider slug");

const createProviderSchema = z
  .object({
    slug: z.string().min(1).describe("Unique slug for the provider"),
    name: z.string().min(1).describe("Display name"),
    description: z.string().optional(),
    icon: z.string().optional(),
    category: z.string().optional().describe("Category: productivity | database | cloud | custom"),
    type: z.string().optional().describe("Provider type: mcp | http | database"),
    configSchema: z.record(z.unknown()).optional().describe("JSON Schema for setup form"),
    requiredSecrets: z.array(z.string()).optional(),
    mcpConfig: z
      .object({
        command: z.string(),
        args: z.array(z.string()),
        envMapping: z.record(z.string()),
        installCommand: z.string().optional(),
      })
      .optional(),
    capabilities: z.array(z.string()).optional(),
    docsUrl: z.string().optional(),
  })
  .describe("Body for creating a custom connection provider");

const createConnectionSchema = z
  .object({
    name: z.string().min(1).describe("Display name for the connection"),
    providerSlug: z.string().optional().describe("Provider slug (resolves to providerId)"),
    providerId: z.string().optional().describe("Provider UUID"),
    config: z.record(z.unknown()).optional().describe("Provider-specific configuration"),
    scope: z.string().optional().describe("'global' or repo URL"),
    repoUrl: z.string().optional().describe("Repo URL (sets scope automatically)"),
    enabled: z.boolean().optional(),
    assignments: z
      .array(
        z.object({
          repoId: z.string().nullable().optional().describe("Repo ID or null for all repos"),
          agentTypes: z.array(z.string()).optional().describe("Agent types or empty for all"),
          permission: z.string().optional().describe("Permission: read | write | full"),
        }),
      )
      .optional()
      .describe("Inline assignment creation"),
  })
  .describe("Body for creating a connection");

const updateConnectionSchema = z
  .object({
    name: z.string().min(1).optional(),
    config: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .describe("Partial update to a connection");

const createAssignmentSchema = z
  .object({
    repoId: z.string().nullable().optional().describe("Repo ID or null for all repos"),
    agentTypes: z.array(z.string()).optional().describe("Agent types or empty for all"),
    permission: z.string().optional().describe("Permission: read | write | full"),
  })
  .describe("Body for creating a connection assignment");

const updateAssignmentSchema = z
  .object({
    agentTypes: z.array(z.string()).optional(),
    permission: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .describe("Partial update to a connection assignment");

// ── Response schemas ──────────────────────────────────────────────────────

const ProvidersListResponse = z.object({ providers: z.array(ConnectionProviderSchema) });
const ProviderResponse = z.object({ provider: ConnectionProviderSchema });
const ConnectionsListResponse = z.object({ connections: z.array(ConnectionSchema) });
const ConnectionResponse = z.object({ connection: ConnectionSchema });
const AssignmentsListResponse = z.object({ assignments: z.array(ConnectionAssignmentSchema) });
const AssignmentResponse = z.object({ assignment: ConnectionAssignmentSchema });

// ── Routes ────────────────────────────────────────────────────────────────

export async function connectionRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  // ── Provider routes ───────────────────────────────────────────────────

  app.get(
    "/api/connection-providers",
    {
      schema: {
        operationId: "listConnectionProviders",
        summary: "List connection providers",
        description:
          "List all available connection providers (built-in + workspace-scoped custom ones).",
        tags: ["Repos & Integrations"],
        response: { 200: ProvidersListResponse },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const providers = await connectionService.listProviders(workspaceId);
      reply.send({ providers });
    },
  );

  app.get(
    "/api/connection-providers/:slug",
    {
      schema: {
        operationId: "getConnectionProviderBySlug",
        summary: "Get a connection provider by slug",
        description: "Fetch a single connection provider by its slug.",
        tags: ["Repos & Integrations"],
        params: SlugParamsSchema,
        response: { 200: ProviderResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const provider = await connectionService.getProviderBySlug(req.params.slug, workspaceId);
      if (!provider) return reply.status(404).send({ error: "Connection provider not found" });
      reply.send({ provider });
    },
  );

  app.post(
    "/api/connection-providers",
    {
      schema: {
        operationId: "createConnectionProvider",
        summary: "Create a custom connection provider",
        description: "Register a new custom connection provider.",
        tags: ["Repos & Integrations"],
        body: createProviderSchema,
        response: { 201: ProviderResponse },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const provider = await connectionService.createProvider(req.body, workspaceId);
      logAction({
        userId: req.user?.id,
        action: "connection_provider.create",
        params: { slug: req.body.slug, name: req.body.name },
        result: { id: provider.id },
        success: true,
      }).catch(() => {});
      reply.status(201).send({ provider });
    },
  );

  // ── Connection routes ─────────────────────────────────────────────────

  app.get(
    "/api/connections",
    {
      schema: {
        operationId: "listConnections",
        summary: "List connections",
        description: "List all configured connections with joined provider info.",
        tags: ["Repos & Integrations"],
        response: { 200: ConnectionsListResponse },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const conns = await connectionService.listConnections(workspaceId);
      reply.send({ connections: conns });
    },
  );

  app.post(
    "/api/connections",
    {
      schema: {
        operationId: "createConnection",
        summary: "Create a connection",
        description: "Create a new connection instance. Optionally provide inline assignments.",
        tags: ["Repos & Integrations"],
        body: createConnectionSchema,
        response: { 201: ConnectionResponse },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const conn = await connectionService.createConnection(req.body, workspaceId);
      logAction({
        userId: req.user?.id,
        action: "connection.create",
        params: { name: req.body.name, providerSlug: req.body.providerSlug },
        result: { id: conn.id },
        success: true,
      }).catch(() => {});
      reply.status(201).send({ connection: conn });
    },
  );

  app.get(
    "/api/connections/:id",
    {
      schema: {
        operationId: "getConnection",
        summary: "Get a connection",
        description: "Fetch a single connection by ID, including provider info and assignments.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: ConnectionResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const conn = await connectionService.getConnection(req.params.id);
      if (!conn) return reply.status(404).send({ error: "Connection not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && conn.workspaceId && conn.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Connection not found" });
      }
      reply.send({ connection: conn });
    },
  );

  app.patch(
    "/api/connections/:id",
    {
      schema: {
        operationId: "updateConnection",
        summary: "Update a connection",
        description: "Partial update to a connection.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: updateConnectionSchema,
        response: { 200: ConnectionResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const existing = await connectionService.getConnection(req.params.id);
      if (!existing) return reply.status(404).send({ error: "Connection not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Connection not found" });
      }
      const conn = await connectionService.updateConnection(req.params.id, req.body);
      logAction({
        userId: req.user?.id,
        action: "connection.update",
        params: { connectionId: req.params.id, ...req.body },
        result: { id: req.params.id },
        success: true,
      }).catch(() => {});
      reply.send({ connection: conn });
    },
  );

  app.delete(
    "/api/connections/:id",
    {
      schema: {
        operationId: "deleteConnection",
        summary: "Delete a connection",
        description: "Delete a connection and all its assignments. Returns 204 on success.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const existing = await connectionService.getConnection(req.params.id);
      if (!existing) return reply.status(404).send({ error: "Connection not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Connection not found" });
      }
      await connectionService.deleteConnection(req.params.id);
      logAction({
        userId: req.user?.id,
        action: "connection.delete",
        params: { connectionId: req.params.id },
        result: { id: req.params.id },
        success: true,
      }).catch(() => {});
      reply.status(204).send(null);
    },
  );

  app.post(
    "/api/connections/:id/test",
    {
      schema: {
        operationId: "testConnection",
        summary: "Test connection health",
        description: "Run a basic health check on the connection and update its status.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: ConnectionResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const conn = await connectionService.testConnection(req.params.id);
        reply.send({ connection: conn });
      } catch (err) {
        if (err instanceof Error && err.message === "Connection not found") {
          return reply.status(404).send({ error: "Connection not found" });
        }
        throw err;
      }
    },
  );

  // ── Assignment routes ─────────────────────────────────────────────────

  app.get(
    "/api/connections/:id/assignments",
    {
      schema: {
        operationId: "listConnectionAssignments",
        summary: "List connection assignments",
        description: "List all repo/agent assignments for a connection.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: AssignmentsListResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const conn = await connectionService.getConnection(req.params.id);
      if (!conn) return reply.status(404).send({ error: "Connection not found" });
      const assignments = await connectionService.listAssignments(req.params.id);
      reply.send({ assignments });
    },
  );

  app.post(
    "/api/connections/:id/assignments",
    {
      schema: {
        operationId: "createConnectionAssignment",
        summary: "Create a connection assignment",
        description: "Assign a connection to a repo/agent combination.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: createAssignmentSchema,
        response: { 201: AssignmentResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const conn = await connectionService.getConnection(req.params.id);
      if (!conn) return reply.status(404).send({ error: "Connection not found" });
      const assignment = await connectionService.createAssignment(req.params.id, req.body);
      logAction({
        userId: req.user?.id,
        action: "connection.assign",
        params: { connectionId: req.params.id, ...req.body },
        result: { id: assignment.id },
        success: true,
      }).catch(() => {});
      reply.status(201).send({ assignment });
    },
  );

  app.patch(
    "/api/connection-assignments/:id",
    {
      schema: {
        operationId: "updateConnectionAssignment",
        summary: "Update a connection assignment",
        description: "Partial update to a connection assignment.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: updateAssignmentSchema,
        response: { 200: AssignmentResponse },
      },
    },
    async (req, reply) => {
      const assignment = await connectionService.updateAssignment(req.params.id, req.body);
      logAction({
        userId: req.user?.id,
        action: "connection_assignment.update",
        params: { assignmentId: req.params.id, ...req.body },
        result: { id: req.params.id },
        success: true,
      }).catch(() => {});
      reply.send({ assignment });
    },
  );

  app.delete(
    "/api/connection-assignments/:id",
    {
      schema: {
        operationId: "deleteConnectionAssignment",
        summary: "Delete a connection assignment",
        description: "Delete a connection assignment. Returns 204 on success.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await connectionService.deleteAssignment(req.params.id);
      logAction({
        userId: req.user?.id,
        action: "connection_assignment.delete",
        params: { assignmentId: req.params.id },
        result: { id: req.params.id },
        success: true,
      }).catch(() => {});
      reply.status(204).send(null);
    },
  );

  // ── Repo-scoped route ─────────────────────────────────────────────────

  app.get(
    "/api/repos/:id/connections",
    {
      schema: {
        operationId: "listRepoConnections",
        summary: "List connections for a repo",
        description:
          "Return all connections assigned to a repo (global assignments + repo-specific).",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: ConnectionsListResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { getRepo } = await import("../services/repo-service.js");
      const repo = await getRepo(req.params.id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      const workspaceId = req.user?.workspaceId ?? null;
      // Use the task resolver to get all matching connections, then return as Connection objects
      const resolved = await connectionService.getConnectionsForTask(
        repo.repoUrl,
        "", // empty agentType matches all
        workspaceId,
      );
      // Fetch full connection objects for each resolved connection
      const conns = await Promise.all(
        resolved.map((r) => connectionService.getConnection(r.connectionId)),
      );
      reply.send({ connections: conns.filter(Boolean) });
    },
  );
}
