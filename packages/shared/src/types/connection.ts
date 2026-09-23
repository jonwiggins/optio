// ── Connection Provider (catalog entry) ────────────────────────────────────

export interface ConnectionProviderMcpConfig {
  command: string;
  args: string[];
  envMapping: Record<string, string>; // maps config/secret fields → MCP server env vars
  installCommand?: string;
}

export interface ConnectionProvider {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  category: string; // "productivity" | "database" | "cloud" | "knowledge" | "custom"
  type: string; // "mcp" | "http" | "database"
  configSchema?: Record<string, unknown> | null; // JSON Schema for the setup form
  requiredSecrets?: string[] | null;
  mcpConfig?: ConnectionProviderMcpConfig | null;
  capabilities?: string[] | null;
  docsUrl?: string | null;
  builtIn: boolean;
  workspaceId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateConnectionProviderInput {
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
}

// ── Connection (configured instance) ───────────────────────────────────────

export type ConnectionStatus = "healthy" | "error" | "unknown";

export interface Connection {
  id: string;
  name: string;
  providerId: string;
  config?: Record<string, unknown> | null;
  scope: string; // "global" or repo URL
  repoUrl?: string | null;
  workspaceId?: string | null;
  enabled: boolean;
  status: ConnectionStatus;
  statusMessage?: string | null;
  lastCheckedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // Joined fields (optional, populated by service layer)
  provider?: ConnectionProvider | null;
  assignments?: ConnectionAssignment[] | null;
}

export interface CreateConnectionInput {
  name: string;
  providerSlug?: string; // resolve to providerId
  providerId?: string;
  config?: Record<string, unknown>;
  scope?: string;
  repoUrl?: string;
  enabled?: boolean;
  // Inline assignment creation
  assignments?: Array<{
    repoId?: string | null;
    agentTypes?: string[];
    permission?: string;
  }>;
}

export interface UpdateConnectionInput {
  name?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

// ── Connection Assignment ──────────────────────────────────────────────────

export interface ConnectionAssignment {
  id: string;
  connectionId: string;
  repoId?: string | null; // null = all repos
  agentTypes?: string[] | null; // empty/null = all agents
  permission: string; // "read" | "write" | "full"
  enabled: boolean;
  createdAt: Date;
}

export interface CreateConnectionAssignmentInput {
  repoId?: string | null;
  agentTypes?: string[];
  permission?: string;
}

export interface UpdateConnectionAssignmentInput {
  agentTypes?: string[];
  permission?: string;
  enabled?: boolean;
}

/**
 * A connection as `GET /api/repos/:id/connections` lists it: every enabled
 * connection with an enabled assignment covering that repo (its own or a
 * global one), whichever agent types that assignment is limited to.
 */
export interface RepoConnection extends Connection {
  /**
   * The agent types the connection is injected for on this repo — the union
   * over its assignments that cover the repo. Empty = every agent.
   */
  agentTypes: string[];
}

// ── Resolved connection (for task injection) ───────────────────────────────

export interface ResolvedConnection {
  connectionId: string;
  connectionName: string;
  providerId: string;
  providerSlug: string;
  providerName: string;
  providerType: string;
  mcpConfig: ConnectionProviderMcpConfig | null;
  config: Record<string, unknown>;
  permission: string;
  agentTypes: string[];
}
