import { eq, and, or, isNull, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { connectionProviders, connections, connectionAssignments, repos } from "../db/schema.js";
import { retrieveSecret } from "./secret-service.js";
import type {
  ConnectionProvider,
  Connection,
  ConnectionAssignment,
  ResolvedConnection,
  ConnectionProviderMcpConfig,
} from "@optio/shared";

// ── Built-in provider definitions ─────────────────────────────────────────

const BUILT_IN_PROVIDERS: Array<{
  slug: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  type: string;
  configSchema: Record<string, unknown>;
  requiredSecrets: string[];
  mcpConfig: ConnectionProviderMcpConfig | null;
  capabilities: string[];
}> = [
  {
    slug: "notion",
    name: "Notion",
    description: "Search and read Notion pages, databases, and comments",
    icon: "notion",
    category: "productivity",
    type: "mcp",
    configSchema: {
      type: "object",
      properties: {
        NOTION_API_KEY: { type: "string", title: "Notion API Key", format: "secret" },
      },
      required: ["NOTION_API_KEY"],
    },
    requiredSecrets: ["NOTION_API_KEY"],
    mcpConfig: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-notion"],
      envMapping: { NOTION_API_KEY: "NOTION_API_KEY" },
    },
    capabilities: ["search_pages", "read_page", "list_databases", "query_database"],
  },
  {
    slug: "github-enhanced",
    name: "GitHub (Enhanced)",
    description: "Access GitHub issues, discussions, PRs, and repository content beyond git",
    icon: "github",
    category: "productivity",
    type: "mcp",
    configSchema: {
      type: "object",
      properties: {
        GITHUB_TOKEN: {
          type: "string",
          title: "GitHub Personal Access Token",
          format: "secret",
        },
      },
      required: ["GITHUB_TOKEN"],
    },
    requiredSecrets: ["GITHUB_TOKEN"],
    mcpConfig: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      envMapping: { GITHUB_PERSONAL_ACCESS_TOKEN: "GITHUB_TOKEN" },
    },
    capabilities: ["search_repos", "read_issues", "create_issue", "read_prs", "read_files"],
  },
  {
    slug: "slack",
    name: "Slack",
    description: "Search messages, read channels, and post to Slack",
    icon: "slack",
    category: "productivity",
    type: "mcp",
    configSchema: {
      type: "object",
      properties: {
        SLACK_BOT_TOKEN: { type: "string", title: "Slack Bot Token", format: "secret" },
        SLACK_TEAM_ID: { type: "string", title: "Slack Team ID" },
      },
      required: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
    },
    requiredSecrets: ["SLACK_BOT_TOKEN"],
    mcpConfig: {
      command: "npx",
      args: ["-y", "@anthropic/mcp-server-slack"],
      envMapping: { SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN", SLACK_TEAM_ID: "SLACK_TEAM_ID" },
    },
    capabilities: ["search_messages", "read_channel", "post_message", "list_channels"],
  },
  {
    slug: "linear",
    name: "Linear",
    description: "Read and manage Linear issues, projects, and cycles",
    icon: "linear",
    category: "productivity",
    type: "mcp",
    configSchema: {
      type: "object",
      properties: {
        LINEAR_API_KEY: { type: "string", title: "Linear API Key", format: "secret" },
      },
      required: ["LINEAR_API_KEY"],
    },
    requiredSecrets: ["LINEAR_API_KEY"],
    mcpConfig: {
      command: "npx",
      args: ["-y", "mcp-linear"],
      envMapping: { LINEAR_API_KEY: "LINEAR_API_KEY" },
    },
    capabilities: ["list_issues", "read_issue", "create_issue", "update_issue", "list_projects"],
  },
  {
    slug: "postgres",
    name: "PostgreSQL",
    description: "Query PostgreSQL databases and inspect schema",
    icon: "database",
    category: "database",
    type: "mcp",
    configSchema: {
      type: "object",
      properties: {
        POSTGRES_URL: {
          type: "string",
          title: "PostgreSQL Connection URL",
          format: "secret",
        },
      },
      required: ["POSTGRES_URL"],
    },
    requiredSecrets: ["POSTGRES_URL"],
    mcpConfig: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres"],
      envMapping: { POSTGRES_CONNECTION_STRING: "POSTGRES_URL" },
    },
    capabilities: ["query", "list_tables", "describe_table"],
  },
  {
    slug: "sentry",
    name: "Sentry",
    description: "Search errors, read stack traces, and manage issues in Sentry",
    icon: "sentry",
    category: "cloud",
    type: "mcp",
    configSchema: {
      type: "object",
      properties: {
        SENTRY_AUTH_TOKEN: { type: "string", title: "Sentry Auth Token", format: "secret" },
        SENTRY_ORG: { type: "string", title: "Sentry Organization Slug" },
      },
      required: ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"],
    },
    requiredSecrets: ["SENTRY_AUTH_TOKEN"],
    mcpConfig: {
      command: "npx",
      args: ["-y", "@sentry/mcp-server"],
      envMapping: { SENTRY_AUTH_TOKEN: "SENTRY_AUTH_TOKEN", SENTRY_ORG: "SENTRY_ORG" },
    },
    capabilities: ["search_issues", "read_issue", "list_projects"],
  },
  {
    slug: "filesystem",
    name: "Filesystem",
    description: "Read and search files from a mounted directory or knowledge base",
    icon: "folder",
    category: "knowledge",
    type: "mcp",
    configSchema: {
      type: "object",
      properties: {
        ROOT_PATH: { type: "string", title: "Root directory path", default: "/workspace" },
      },
    },
    requiredSecrets: [],
    mcpConfig: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "{{ROOT_PATH}}"],
      envMapping: {},
    },
    capabilities: ["read_file", "write_file", "list_directory", "search_files"],
  },
  {
    slug: "custom-mcp",
    name: "Custom MCP Server",
    description: "Connect any MCP-compatible server with custom command and configuration",
    icon: "terminal",
    category: "custom",
    type: "mcp",
    configSchema: {
      type: "object",
      properties: {
        command: { type: "string", title: "Command" },
        args: { type: "string", title: "Arguments (one per line)" },
        env: { type: "string", title: "Environment variables (KEY=VALUE, one per line)" },
        installCommand: { type: "string", title: "Install command (optional)" },
      },
      required: ["command"],
    },
    requiredSecrets: [],
    mcpConfig: null,
    capabilities: [],
  },
  {
    slug: "custom-http",
    name: "HTTP API",
    description: "Connect any REST API endpoint with custom authentication",
    icon: "globe",
    category: "custom",
    type: "http",
    configSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", title: "Base URL" },
        authType: {
          type: "string",
          title: "Authentication type",
          enum: ["none", "api-key", "bearer"],
        },
        authHeader: { type: "string", title: "Auth header name", default: "Authorization" },
        AUTH_TOKEN: { type: "string", title: "Auth token/key", format: "secret" },
        description: {
          type: "string",
          title: "API description (helps agent understand usage)",
        },
      },
      required: ["baseUrl"],
    },
    requiredSecrets: [],
    mcpConfig: null,
    capabilities: [],
  },
];

// ── Provider CRUD ─────────────────────────────────────────────────────────

export async function listProviders(workspaceId?: string | null): Promise<ConnectionProvider[]> {
  const conditions = [];
  if (workspaceId) {
    // Return built-in (workspaceId IS NULL) + workspace-scoped
    conditions.push(
      or(
        eq(connectionProviders.workspaceId, workspaceId),
        isNull(connectionProviders.workspaceId),
      )!,
    );
  }

  const query =
    conditions.length > 0
      ? db
          .select()
          .from(connectionProviders)
          .where(and(...conditions))
      : db.select().from(connectionProviders);
  const rows = await query;
  return rows.map(mapProviderRow);
}

export async function getProvider(id: string): Promise<ConnectionProvider | null> {
  const [row] = await db.select().from(connectionProviders).where(eq(connectionProviders.id, id));
  return row ? mapProviderRow(row) : null;
}

export async function getProviderBySlug(
  slug: string,
  workspaceId?: string | null,
): Promise<ConnectionProvider | null> {
  const conditions = [eq(connectionProviders.slug, slug)];
  if (workspaceId) {
    conditions.push(
      or(
        eq(connectionProviders.workspaceId, workspaceId),
        isNull(connectionProviders.workspaceId),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(connectionProviders)
    .where(and(...conditions));

  // Prefer workspace-scoped over built-in when both match
  const wsScoped = rows.find((r) => r.workspaceId === workspaceId);
  const row = wsScoped ?? rows[0];
  return row ? mapProviderRow(row) : null;
}

export async function createProvider(
  input: {
    slug: string;
    name: string;
    description?: string;
    icon?: string;
    category?: string;
    type?: string;
    configSchema?: Record<string, unknown>;
    requiredSecrets?: string[];
    mcpConfig?: ConnectionProviderMcpConfig;
    capabilities?: string[];
    docsUrl?: string;
  },
  workspaceId?: string | null,
): Promise<ConnectionProvider> {
  const [row] = await db
    .insert(connectionProviders)
    .values({
      slug: input.slug,
      name: input.name,
      description: input.description ?? undefined,
      icon: input.icon ?? undefined,
      category: input.category ?? "custom",
      type: input.type ?? "mcp",
      configSchema: input.configSchema ?? undefined,
      requiredSecrets: input.requiredSecrets ?? [],
      mcpConfig: input.mcpConfig ?? undefined,
      capabilities: input.capabilities ?? [],
      docsUrl: input.docsUrl ?? undefined,
      builtIn: false,
      workspaceId: workspaceId ?? undefined,
    })
    .returning();
  return mapProviderRow(row);
}

/**
 * Idempotent seeder: creates or updates built-in providers.
 * Uses upsert on the partial (slug WHERE workspace_id IS NULL) unique index.
 */
export async function seedBuiltInProviders(): Promise<void> {
  for (const provider of BUILT_IN_PROVIDERS) {
    await db
      .insert(connectionProviders)
      .values({
        slug: provider.slug,
        name: provider.name,
        description: provider.description,
        icon: provider.icon,
        category: provider.category,
        type: provider.type,
        configSchema: provider.configSchema,
        requiredSecrets: provider.requiredSecrets,
        mcpConfig: provider.mcpConfig ?? undefined,
        capabilities: provider.capabilities,
        builtIn: true,
        workspaceId: undefined, // built-in providers have NULL workspaceId
      })
      .onConflictDoUpdate({
        // Built-in providers have NULL workspace_id, and the composite
        // (slug, workspace_id) constraint treats NULLs as distinct — its
        // conflict never fires, which duplicated every built-in provider on
        // each restart. Target the partial unique index on (slug) WHERE
        // workspace_id IS NULL instead.
        target: connectionProviders.slug,
        targetWhere: isNull(connectionProviders.workspaceId),
        set: {
          name: provider.name,
          description: provider.description,
          icon: provider.icon,
          category: provider.category,
          type: provider.type,
          configSchema: provider.configSchema,
          requiredSecrets: provider.requiredSecrets,
          mcpConfig: provider.mcpConfig ?? undefined,
          capabilities: provider.capabilities,
          builtIn: true,
          updatedAt: new Date(),
        },
      });
  }
}

// ── Connection CRUD ───────────────────────────────────────────────────────

export async function listConnections(workspaceId?: string | null): Promise<Connection[]> {
  const conditions = [];
  if (workspaceId) {
    conditions.push(or(eq(connections.workspaceId, workspaceId), isNull(connections.workspaceId))!);
  }

  const query =
    conditions.length > 0
      ? db
          .select({
            connection: connections,
            provider: connectionProviders,
          })
          .from(connections)
          .leftJoin(connectionProviders, eq(connections.providerId, connectionProviders.id))
          .where(and(...conditions))
      : db
          .select({
            connection: connections,
            provider: connectionProviders,
          })
          .from(connections)
          .leftJoin(connectionProviders, eq(connections.providerId, connectionProviders.id));

  const rows = await query;
  return rows.map((r) => mapConnectionRow(r.connection, r.provider));
}

export async function getConnection(id: string): Promise<Connection | null> {
  const [row] = await db
    .select({
      connection: connections,
      provider: connectionProviders,
    })
    .from(connections)
    .leftJoin(connectionProviders, eq(connections.providerId, connectionProviders.id))
    .where(eq(connections.id, id));

  if (!row) return null;

  const conn = mapConnectionRow(row.connection, row.provider);

  // Attach assignments
  const assignmentRows = await db
    .select()
    .from(connectionAssignments)
    .where(eq(connectionAssignments.connectionId, id));
  conn.assignments = assignmentRows.map(mapAssignmentRow);

  return conn;
}

export async function createConnection(
  input: {
    name: string;
    providerSlug?: string;
    providerId?: string;
    config?: Record<string, unknown>;
    scope?: string;
    repoUrl?: string;
    enabled?: boolean;
    assignments?: Array<{
      repoId?: string | null;
      agentTypes?: string[];
      permission?: string;
    }>;
  },
  workspaceId?: string | null,
): Promise<Connection> {
  // Resolve providerId from slug if needed
  let providerId = input.providerId;
  if (!providerId && input.providerSlug) {
    const provider = await getProviderBySlug(input.providerSlug, workspaceId);
    if (!provider) throw new Error(`Provider not found: ${input.providerSlug}`);
    providerId = provider.id;
  }
  if (!providerId) throw new Error("Either providerId or providerSlug is required");

  const [row] = await db
    .insert(connections)
    .values({
      name: input.name,
      providerId,
      config: input.config ?? undefined,
      scope: input.repoUrl ?? input.scope ?? "global",
      repoUrl: input.repoUrl ?? undefined,
      workspaceId: workspaceId ?? undefined,
      enabled: input.enabled ?? true,
    })
    .returning();

  // Create inline assignments
  if (input.assignments && input.assignments.length > 0) {
    for (const assignment of input.assignments) {
      await db.insert(connectionAssignments).values({
        connectionId: row.id,
        repoId: assignment.repoId ?? undefined,
        agentTypes: assignment.agentTypes ?? [],
        permission: assignment.permission ?? "read",
      });
    }
  }

  // Return with provider and assignments joined
  const full = await getConnection(row.id);
  return full!;
}

export async function updateConnection(
  id: string,
  input: {
    name?: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  },
): Promise<Connection> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.config !== undefined) updates.config = input.config;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  await db.update(connections).set(updates).where(eq(connections.id, id));

  const full = await getConnection(id);
  return full!;
}

export async function deleteConnection(id: string): Promise<void> {
  await db.delete(connections).where(eq(connections.id, id));
}

export async function testConnection(id: string): Promise<Connection> {
  const conn = await getConnection(id);
  if (!conn) throw new Error("Connection not found");

  // Basic health check: mark as healthy if we can read it, error on exception.
  // Future: provider-specific health checks (e.g., test API key validity).
  try {
    const updates = {
      status: "healthy" as const,
      statusMessage: "Connection OK",
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    };
    await db.update(connections).set(updates).where(eq(connections.id, id));
    return { ...conn, ...updates };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updates = {
      status: "error" as const,
      statusMessage: message,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    };
    await db.update(connections).set(updates).where(eq(connections.id, id));
    return { ...conn, ...updates };
  }
}

// ── Assignment CRUD ───────────────────────────────────────────────────────

export async function listAssignments(connectionId: string): Promise<ConnectionAssignment[]> {
  const rows = await db
    .select()
    .from(connectionAssignments)
    .where(eq(connectionAssignments.connectionId, connectionId));
  return rows.map(mapAssignmentRow);
}

/**
 * Fetch a single assignment by id (read-only). Used by the routes layer to
 * resolve the owning connection for workspace-scoping the flat
 * `/api/connection-assignments/:id` routes, which otherwise take only the
 * assignment id and would be an IDOR surface.
 */
export async function getAssignment(id: string): Promise<ConnectionAssignment | null> {
  const [row] = await db
    .select()
    .from(connectionAssignments)
    .where(eq(connectionAssignments.id, id));
  return row ? mapAssignmentRow(row) : null;
}

export async function createAssignment(
  connectionId: string,
  input: {
    repoId?: string | null;
    agentTypes?: string[];
    permission?: string;
  },
): Promise<ConnectionAssignment> {
  const [row] = await db
    .insert(connectionAssignments)
    .values({
      connectionId,
      repoId: input.repoId ?? undefined,
      agentTypes: input.agentTypes ?? [],
      permission: input.permission ?? "read",
    })
    .returning();
  return mapAssignmentRow(row);
}

export async function updateAssignment(
  id: string,
  input: {
    agentTypes?: string[];
    permission?: string;
    enabled?: boolean;
  },
): Promise<ConnectionAssignment> {
  const updates: Record<string, unknown> = {};
  if (input.agentTypes !== undefined) updates.agentTypes = input.agentTypes;
  if (input.permission !== undefined) updates.permission = input.permission;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  const [row] = await db
    .update(connectionAssignments)
    .set(updates)
    .where(eq(connectionAssignments.id, id))
    .returning();
  return mapAssignmentRow(row);
}

export async function deleteAssignment(id: string): Promise<void> {
  await db.delete(connectionAssignments).where(eq(connectionAssignments.id, id));
}

// ── Resolution (for task-worker) ──────────────────────────────────────────

/**
 * Resolve all connections that should be injected into a task.
 * Filters by: workspace, enabled state, repo assignments, and agent type.
 */
export async function getConnectionsForTask(
  repoUrl: string,
  agentType: string,
  workspaceId?: string | null,
): Promise<ResolvedConnection[]> {
  // 1. Find the repo by URL to get its ID
  const [repo] = await db.select().from(repos).where(eq(repos.repoUrl, repoUrl));

  // 2. Get all enabled connections for the workspace (with provider join)
  const wsConditions = [eq(connections.enabled, true)];
  if (workspaceId) {
    wsConditions.push(
      or(eq(connections.workspaceId, workspaceId), isNull(connections.workspaceId))!,
    );
  }

  const connRows = await db
    .select({
      connection: connections,
      provider: connectionProviders,
    })
    .from(connections)
    .innerJoin(connectionProviders, eq(connections.providerId, connectionProviders.id))
    .where(and(...wsConditions));

  if (connRows.length === 0) return [];

  // 3. Get all enabled assignments for these connections
  const connIds = connRows.map((r) => r.connection.id);
  const assignmentRows = await db
    .select()
    .from(connectionAssignments)
    .where(
      and(
        inArray(connectionAssignments.connectionId, connIds),
        eq(connectionAssignments.enabled, true),
      ),
    );

  // Index assignments by connectionId
  const assignmentsByConn = new Map<string, (typeof assignmentRows)[number][]>();
  for (const a of assignmentRows) {
    const existing = assignmentsByConn.get(a.connectionId) ?? [];
    existing.push(a);
    assignmentsByConn.set(a.connectionId, existing);
  }

  const results: ResolvedConnection[] = [];

  for (const { connection: conn, provider } of connRows) {
    const assignments = assignmentsByConn.get(conn.id) ?? [];

    // 4. Check if there's a matching assignment
    // Global assignments (repoId=null) match all repos.
    // Repo-specific assignments match by repo ID.
    const matching = assignments.find((a) => {
      // Global assignment
      if (!a.repoId) return true;
      // Repo-specific: match by repo ID
      if (repo && a.repoId === repo.id) return true;
      return false;
    });

    if (!matching) continue;

    // 5. Filter by agentType (empty agentTypes = all agents)
    const types = (matching.agentTypes as string[]) ?? [];
    if (types.length > 0 && !types.includes(agentType)) continue;

    // 6. Build resolved connection
    results.push({
      connectionId: conn.id,
      connectionName: conn.name,
      providerId: provider.id,
      providerSlug: provider.slug,
      providerName: provider.name,
      providerType: provider.type,
      mcpConfig: (provider.mcpConfig as ConnectionProviderMcpConfig) ?? null,
      config: (conn.config as Record<string, unknown>) ?? {},
      permission: matching.permission,
      agentTypes: types,
    });
  }

  return results;
}

// ── Row mappers ───────────────────────────────────────────────────────────

function mapProviderRow(row: typeof connectionProviders.$inferSelect): ConnectionProvider {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    icon: row.icon,
    category: row.category,
    type: row.type,
    configSchema: row.configSchema,
    requiredSecrets: row.requiredSecrets,
    mcpConfig: row.mcpConfig as ConnectionProviderMcpConfig | null,
    capabilities: row.capabilities,
    docsUrl: row.docsUrl,
    builtIn: row.builtIn,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapConnectionRow(
  row: typeof connections.$inferSelect,
  providerRow?: typeof connectionProviders.$inferSelect | null,
): Connection {
  return {
    id: row.id,
    name: row.name,
    providerId: row.providerId,
    config: row.config,
    scope: row.scope,
    repoUrl: row.repoUrl,
    workspaceId: row.workspaceId,
    enabled: row.enabled,
    status: row.status,
    statusMessage: row.statusMessage,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    provider: providerRow ? mapProviderRow(providerRow) : null,
    assignments: null,
  };
}

function mapAssignmentRow(row: typeof connectionAssignments.$inferSelect): ConnectionAssignment {
  return {
    id: row.id,
    connectionId: row.connectionId,
    repoId: row.repoId,
    agentTypes: row.agentTypes,
    permission: row.permission,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}
