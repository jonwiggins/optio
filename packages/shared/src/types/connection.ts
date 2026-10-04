// ── Connection Provider (catalog entry) ────────────────────────────────────

export interface ConnectionProviderMcpConfig {
  command: string;
  args: string[];
  envMapping: Record<string, string>; // maps config/secret fields → MCP server env vars
  installCommand?: string;
  /**
   * Static env for the MCP server: each value is a `{{key}}` template over
   * the connection's config (`{{name}}` is the connection's name; a secret
   * key resolves from the encrypted store). A var whose template renders
   * empty is left out.
   */
  env?: Record<string, string>;
  /** The tools run only when this boolean config key is on. */
  enabledBy?: string;
}

/**
 * How Optio checks a connection works ("Test"): an HTTP request whose url
 * and headers are `{{key}}` templates over the connection's config, or an
 * AWS STS GetCallerIdentity with its keys.
 */
export type ConnectionHealthCheck =
  | {
      kind: "http";
      method?: "GET" | "POST";
      url: string;
      headers?: Record<string, string>;
      expectStatus?: number;
    }
  | { kind: "aws-sts" };

/**
 * What a connection gives the agent: `credentials` (secret config fields),
 * `tools` (an MCP server), `env` (vars exported into the agent's own shell),
 * `note` (text telling the agent how to use the service). Derived from the
 * provider's manifest and the connection's own settings, never stored.
 */
export type ConnectionPart = "credentials" | "tools" | "env" | "note";
export const CONNECTION_PARTS: readonly ConnectionPart[] = ["credentials", "tools", "env", "note"];

export interface ConnectionProvider {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  category: string; // "productivity" | "database" | "cloud" | "knowledge" | "custom"
  type: string; // "mcp" | "http" | "database"
  /**
   * JSON Schema for the setup form. A property with `format: "secret"` is a
   * credential (encrypted at rest, never returned); one with `enum` may carry
   * `enumTitles` (labels in the same order); `type: "boolean"` is a toggle.
   */
  configSchema?: Record<string, unknown> | null;
  requiredSecrets?: string[] | null;
  mcpConfig?: ConnectionProviderMcpConfig | null;
  /**
   * Vars exported into the agent's own shell (so CLIs and SDKs work), each a
   * `{{key}}` template over the connection's config; an empty render is left
   * out. A connection can switch this off (`exportShellEnv`).
   */
  shellEnv?: Record<string, string> | null;
  /** Text given to the agent (as a skill file) telling it how to use the service. */
  note?: string | null;
  healthCheck?: ConnectionHealthCheck | null;
  /** What connections of this provider can give an agent. */
  parts: ConnectionPart[];
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
  shellEnv?: Record<string, string>;
  note?: string;
  healthCheck?: ConnectionHealthCheck;
  capabilities?: string[];
  docsUrl?: string;
}

// ── Connection (configured instance) ───────────────────────────────────────

export type ConnectionStatus = "healthy" | "error" | "unknown";

export interface Connection {
  id: string;
  name: string;
  providerId: string;
  /**
   * The non-secret config. Secret fields (the provider's `format: "secret"`
   * properties) are encrypted on the row and never returned; their names are
   * in `secretFields`. A `${{NAME}}` reference to a stored secret is config,
   * not a value, so it stays here.
   */
  config?: Record<string, unknown> | null;
  /** The secret config fields this connection has a value for. */
  secretFields: string[];
  /** Whether the provider's `shellEnv` is exported into the agent's shell. */
  exportShellEnv: boolean;
  /** What this connection gives an agent (see `ConnectionPart`). */
  parts: ConnectionPart[];
  scope: string; // "global" or repo URL
  repoUrl?: string | null;
  workspaceId?: string | null;
  /**
   * Null = the organization's; set = one person's own: only injected into
   * work that person owns, and only visible to them (and admins, by name).
   */
  ownerUserId?: string | null;
  /** Display name of `ownerUserId`, for a private connection (lists only). */
  ownerName?: string | null;
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
  /** Default `workspace`; `workspace` needs an admin. */
  owner?: "workspace" | "me";
  // Inline assignment creation
  assignments?: Array<{
    repoId?: string | null;
    agentTypes?: string[];
    permission?: string;
  }>;
}

export interface UpdateConnectionInput {
  name?: string;
  /**
   * Merged into the stored config. A secret field that is omitted or empty
   * keeps its value; `null` clears it.
   */
  config?: Record<string, unknown>;
  enabled?: boolean;
  exportShellEnv?: boolean;
  /** When given, replaces every assignment. */
  assignments?: Array<{
    repoId?: string | null;
    agentTypes?: string[];
    permission?: string;
  }>;
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
  /** The decrypted secret config fields. Never leaves the API. */
  secrets: Record<string, string>;
  /** The form's defaults for config keys the connection left unset. */
  configDefaults: Record<string, string>;
  shellEnv: Record<string, string> | null;
  exportShellEnv: boolean;
  note: string | null;
  permission: string;
  agentTypes: string[];
}
