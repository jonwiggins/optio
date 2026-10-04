import { eq, and, or, isNull, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { connectionProviders, connections, connectionAssignments, repos } from "../db/schema.js";
import { decrypt, encrypt, retrieveSecret } from "./secret-service.js";
import { runHealthCheck } from "./connection-health.js";
import { logger } from "../logger.js";
import { isReservedPodEnvName, VALID_ENV_NAME } from "../utils/pod-env.js";
import type {
  ConnectionProvider,
  Connection,
  ConnectionAssignment,
  ConnectionHealthCheck,
  ConnectionPart,
  RepoConnection,
  ResolvedConnection,
  ConnectionProviderMcpConfig,
  IdOverrides,
} from "@optio/shared";
import { loadWithOverrides } from "@optio/shared";

// ── Built-in provider definitions ─────────────────────────────────────────

/** Where the agent images keep the REST bridge (packages/mcp-bridge). */
export const MCP_BRIDGE_PATH = "/opt/optio/mcp-bridge.js";

export interface BuiltInProvider {
  slug: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  type: string;
  configSchema: Record<string, unknown>;
  requiredSecrets: string[];
  mcpConfig: ConnectionProviderMcpConfig | null;
  shellEnv?: Record<string, string>;
  note?: string;
  healthCheck?: ConnectionHealthCheck;
  capabilities: string[];
}

export const BUILT_IN_PROVIDERS: BuiltInProvider[] = [
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
    // The entry is built from the connection's own config (customMcpEntry).
    mcpConfig: null,
    capabilities: [],
  },
  {
    slug: "custom-http",
    name: "HTTP API",
    description: "Any REST API with a token: the agent gets a request tool for it",
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
          enumTitles: ["None", "API key (sent as-is)", "Bearer token"],
          default: "bearer",
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
    mcpConfig: {
      command: "node",
      args: [MCP_BRIDGE_PATH],
      envMapping: {},
      env: {
        OPTIO_HTTP_NAME: "{{name}}",
        OPTIO_HTTP_BASE_URL: "{{baseUrl}}",
        OPTIO_HTTP_AUTH_HEADER: "{{authHeader}}",
        OPTIO_HTTP_AUTH_SCHEME: "{{authType}}",
        OPTIO_HTTP_AUTH_TOKEN: "{{AUTH_TOKEN}}",
        OPTIO_HTTP_DESCRIPTION: "{{description}}",
      },
    },
    capabilities: ["request"],
  },
  {
    slug: "aws",
    name: "AWS",
    description: "Sign the agent's AWS CLI and SDKs in; optionally run the AWS API tools",
    icon: "aws",
    category: "cloud",
    type: "mcp",
    configSchema: {
      type: "object",
      properties: {
        AWS_ACCESS_KEY_ID: { type: "string", title: "Access key ID", format: "secret" },
        AWS_SECRET_ACCESS_KEY: { type: "string", title: "Secret access key", format: "secret" },
        AWS_SESSION_TOKEN: {
          type: "string",
          title: "Session token (temporary credentials only)",
          format: "secret",
        },
        AWS_REGION: { type: "string", title: "Region", default: "us-east-1" },
        AWS_TOOLS: {
          type: "boolean",
          title: "Also run the AWS API MCP server (needs the python or full agent image)",
          default: false,
        },
      },
      required: [],
    },
    requiredSecrets: [],
    shellEnv: {
      AWS_ACCESS_KEY_ID: "{{AWS_ACCESS_KEY_ID}}",
      AWS_SECRET_ACCESS_KEY: "{{AWS_SECRET_ACCESS_KEY}}",
      AWS_SESSION_TOKEN: "{{AWS_SESSION_TOKEN}}",
      AWS_REGION: "{{AWS_REGION}}",
    },
    mcpConfig: {
      command: "uvx",
      args: ["awslabs.aws-api-mcp-server@latest"],
      envMapping: {},
      env: {
        AWS_ACCESS_KEY_ID: "{{AWS_ACCESS_KEY_ID}}",
        AWS_SECRET_ACCESS_KEY: "{{AWS_SECRET_ACCESS_KEY}}",
        AWS_SESSION_TOKEN: "{{AWS_SESSION_TOKEN}}",
        AWS_REGION: "{{AWS_REGION}}",
      },
      enabledBy: "AWS_TOOLS",
    },
    note: [
      "The AWS CLI (`aws`) and every AWS SDK are signed in through the",
      "environment: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION",
      "(and AWS_SESSION_TOKEN for temporary credentials). When no keys were",
      "given, the pod's own IAM role applies. Check who you are with",
      "`aws sts get-caller-identity` before changing anything.",
    ].join(" "),
    healthCheck: { kind: "aws-sts" },
    capabilities: ["cli", "sdk"],
  },
  {
    slug: "pylon",
    name: "Pylon",
    description: "Read and update support issues, accounts, and contacts in Pylon",
    icon: "pylon",
    category: "productivity",
    type: "http",
    configSchema: {
      type: "object",
      properties: {
        PYLON_API_TOKEN: { type: "string", title: "API token", format: "secret" },
        PYLON_API_HOST: {
          type: "string",
          title: "Region",
          enum: ["api.usepylon.com", "api.eu.usepylon.com"],
          enumTitles: ["US", "EU"],
          default: "api.usepylon.com",
        },
      },
      required: ["PYLON_API_TOKEN"],
    },
    requiredSecrets: ["PYLON_API_TOKEN"],
    mcpConfig: {
      command: "node",
      args: [MCP_BRIDGE_PATH],
      envMapping: {},
      env: {
        OPTIO_HTTP_NAME: "{{name}}",
        OPTIO_HTTP_BASE_URL: "https://{{PYLON_API_HOST}}",
        OPTIO_HTTP_AUTH_VALUE: "Bearer {{PYLON_API_TOKEN}}",
        OPTIO_HTTP_DESCRIPTION:
          "Pylon customer-support REST API: issues (/issues), accounts (/accounts), contacts (/contacts), users (/users). GET /me returns the signed-in user.",
      },
    },
    note: [
      "Pylon is the support desk. Use the `request` tool of the Pylon MCP server:",
      "GET /issues?filter=… lists issues, GET /issues/{id} reads one, PATCH /issues/{id}",
      "changes state or assignee, POST /issues/{id}/messages?internal=true adds an",
      "internal note. Accounts are /accounts and contacts /contacts.",
      "Never send a customer-facing message unless the task says so.",
    ].join(" "),
    healthCheck: {
      kind: "http",
      url: "https://{{PYLON_API_HOST}}/me",
      headers: { Authorization: "Bearer {{PYLON_API_TOKEN}}" },
    },
    capabilities: ["list_issues", "read_issue", "update_issue", "list_accounts", "list_contacts"],
  },
  {
    slug: "pagerduty",
    name: "PagerDuty",
    description: "Read and act on incidents, services, and on-call schedules in PagerDuty",
    icon: "pagerduty",
    category: "cloud",
    type: "http",
    configSchema: {
      type: "object",
      properties: {
        PAGERDUTY_API_TOKEN: { type: "string", title: "REST API key", format: "secret" },
      },
      required: ["PAGERDUTY_API_TOKEN"],
    },
    requiredSecrets: ["PAGERDUTY_API_TOKEN"],
    mcpConfig: {
      command: "node",
      args: [MCP_BRIDGE_PATH],
      envMapping: {},
      env: {
        OPTIO_HTTP_NAME: "{{name}}",
        OPTIO_HTTP_BASE_URL: "https://api.pagerduty.com",
        OPTIO_HTTP_AUTH_VALUE: "Token token={{PAGERDUTY_API_TOKEN}}",
        OPTIO_HTTP_EXTRA_HEADERS: '{"Accept":"application/vnd.pagerduty+json;version=2"}',
        OPTIO_HTTP_DESCRIPTION:
          "PagerDuty REST API v2: incidents (/incidents), services (/services), schedules (/schedules), on-calls (/oncalls), users (/users).",
      },
    },
    note: [
      "PagerDuty is the incident tracker. Use the `request` tool of the PagerDuty",
      "MCP server: GET /incidents?statuses[]=triggered lists open incidents,",
      "GET /incidents/{id} reads one, PUT /incidents/{id} acknowledges or resolves",
      '(body {"incident":{"type":"incident_reference","status":"resolved"}}),',
      "POST /incidents/{id}/notes adds a note. Writes need a From: header with a",
      "PagerDuty user's email.",
    ].join(" "),
    healthCheck: {
      kind: "http",
      url: "https://api.pagerduty.com/abilities",
      headers: {
        Authorization: "Token token={{PAGERDUTY_API_TOKEN}}",
        Accept: "application/vnd.pagerduty+json;version=2",
      },
    },
    capabilities: ["list_incidents", "read_incident", "update_incident", "list_services"],
  },
];

// ── Provider manifest helpers ─────────────────────────────────────────────

/** The config keys a provider's form marks `format: "secret"` (credentials). */
export function secretFieldNames(
  provider: Pick<ConnectionProvider, "configSchema"> | null | undefined,
): string[] {
  const props = (provider?.configSchema as { properties?: Record<string, unknown> } | null)
    ?.properties;
  if (!props) return [];
  return Object.entries(props)
    .filter(([, p]) => (p as { format?: string })?.format === "secret")
    .map(([k]) => k);
}

/** Whether a config value is a `${{NAME}}` reference to a stored secret. */
export function isSecretRef(value: unknown): value is string {
  return typeof value === "string" && /^\$\{\{\s*[\w.-]+\s*\}\}$/.test(value);
}

type ProviderManifest = Pick<
  ConnectionProvider,
  "configSchema" | "requiredSecrets" | "mcpConfig" | "shellEnv" | "note"
>;

/** What connections of this provider can give an agent. */
export function providerParts(provider: ProviderManifest): ConnectionPart[] {
  const parts: ConnectionPart[] = [];
  if (secretFieldNames(provider).length > 0 || (provider.requiredSecrets?.length ?? 0) > 0) {
    parts.push("credentials");
  }
  if (provider.mcpConfig) parts.push("tools");
  if (provider.shellEnv && Object.keys(provider.shellEnv).length > 0) parts.push("env");
  if (provider.note?.trim()) parts.push("note");
  return parts;
}

/**
 * What one connection gives an agent: the provider's parts, minus tools its
 * `enabledBy` switch has off and env it doesn't export. Credentials count
 * only when the connection holds a value or reference for one.
 */
export function connectionParts(
  provider: ProviderManifest | null | undefined,
  conn: {
    config?: Record<string, unknown> | null;
    secretFields?: string[];
    exportShellEnv?: boolean;
    providerSlug?: string | null;
  },
): ConnectionPart[] {
  if (!provider) return [];
  const parts: ConnectionPart[] = [];
  const config = conn.config ?? {};
  const secretNames = secretFieldNames(provider);
  const hasCredential =
    (conn.secretFields?.length ?? 0) > 0 || secretNames.some((k) => isSecretRef(config[k]));
  if (hasCredential) parts.push("credentials");
  const mcp = provider.mcpConfig;
  const customMcp = conn.providerSlug === "custom-mcp" && typeof config.command === "string";
  if (customMcp || (mcp && (!mcp.enabledBy || config[mcp.enabledBy] === true))) {
    parts.push("tools");
  }
  if (
    provider.shellEnv &&
    Object.keys(provider.shellEnv).length > 0 &&
    (conn.exportShellEnv ?? true)
  ) {
    parts.push("env");
  }
  if (provider.note?.trim()) parts.push("note");
  return parts;
}

/**
 * Every env var a provider would set must be a valid name the pod exec can
 * export, and never one Optio or the agent runtime owns.
 */
export function providerEnvNameError(
  provider: Pick<ConnectionProvider, "shellEnv" | "mcpConfig">,
): string | null {
  const names = [
    ...Object.keys(provider.shellEnv ?? {}),
    ...Object.keys(provider.mcpConfig?.env ?? {}),
  ];
  for (const name of names) {
    if (!VALID_ENV_NAME.test(name)) return `Invalid environment variable name: ${name}`;
    if (isReservedPodEnvName(name) && !name.startsWith("OPTIO_HTTP_")) {
      return `Reserved environment variable name: ${name}`;
    }
  }
  return null;
}

// ── Secret config (encrypted on the row) ──────────────────────────────────

function secretConfigAAD(id: string): Buffer {
  return Buffer.from(`connection|${id}`);
}

function sealSecretConfig(id: string, secrets: Record<string, string>) {
  if (Object.keys(secrets).length === 0) {
    return { secretConfig: null, secretConfigIv: null, secretConfigAuthTag: null };
  }
  const blob = encrypt(JSON.stringify(secrets), secretConfigAAD(id));
  return {
    secretConfig: blob.ciphertext,
    secretConfigIv: blob.iv,
    secretConfigAuthTag: blob.authTag,
  };
}

type ConnectionRow = typeof connections.$inferSelect;

/** The decrypted secret config fields of a row (empty when it has none). */
export function openSecretConfig(row: ConnectionRow): Record<string, string> {
  if (!row.secretConfig || !row.secretConfigIv || !row.secretConfigAuthTag) return {};
  try {
    const json = decrypt(
      {
        alg: 1,
        ciphertext: row.secretConfig,
        iv: row.secretConfigIv,
        authTag: row.secretConfigAuthTag,
      },
      secretConfigAAD(row.id),
      `connection ${row.name}`,
    );
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch (err) {
    logger.warn({ err, connectionId: row.id }, "Could not decrypt a connection's secret config");
    return {};
  }
}

/**
 * Splits a config the API received into what is stored plain and what is
 * sealed: a secret field with a real value is sealed; a `${{NAME}}`
 * reference stays plain (it names a stored secret, it isn't one); an empty
 * or masked value means "keep what is stored"; `null` clears it.
 */
export function splitConfig(
  provider: Pick<ConnectionProvider, "configSchema"> | null | undefined,
  input: Record<string, unknown>,
): { config: Record<string, unknown>; secrets: Record<string, string>; cleared: string[] } {
  const secretNames = new Set(secretFieldNames(provider));
  const config: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  const cleared: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!secretNames.has(key)) {
      config[key] = value;
      continue;
    }
    if (value === null) {
      cleared.push(key);
    } else if (isSecretRef(value)) {
      config[key] = value;
      cleared.push(key);
    } else if (typeof value === "string" && value !== "" && !/^[•*]+$/.test(value)) {
      secrets[key] = value;
    }
    // "", masked, or non-string: keep what is stored.
  }
  return { config, secrets, cleared };
}

/**
 * Boot-time heal: connections created before v2 hold their secret fields in
 * the plain `config`. Moves each such value into the encrypted column.
 * Idempotent; returns how many rows it sealed.
 */
export async function sealPlaintextConnectionSecrets(): Promise<number> {
  const rows = await db
    .select({ connection: connections, provider: connectionProviders })
    .from(connections)
    .leftJoin(connectionProviders, eq(connections.providerId, connectionProviders.id));
  let sealed = 0;
  for (const { connection: row, provider } of rows) {
    const names = secretFieldNames(provider ? mapProviderRow(provider) : null);
    const config = { ...((row.config as Record<string, unknown> | null) ?? {}) };
    const moved: Record<string, string> = {};
    for (const name of names) {
      const v = config[name];
      if (typeof v === "string" && v !== "" && !isSecretRef(v)) {
        moved[name] = v;
        delete config[name];
      }
    }
    if (Object.keys(moved).length === 0) continue;
    const secrets = { ...openSecretConfig(row), ...moved };
    await db
      .update(connections)
      .set({ config, ...sealSecretConfig(row.id, secrets), updatedAt: new Date() })
      .where(eq(connections.id, row.id));
    sealed++;
  }
  if (sealed > 0) logger.info({ sealed }, "Sealed plaintext connection credentials");
  return sealed;
}

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
    shellEnv?: Record<string, string>;
    note?: string;
    healthCheck?: ConnectionHealthCheck;
    capabilities?: string[];
    docsUrl?: string;
  },
  workspaceId?: string | null,
): Promise<ConnectionProvider> {
  const envError = providerEnvNameError({
    shellEnv: input.shellEnv ?? null,
    mcpConfig: input.mcpConfig ?? null,
  });
  if (envError) throw new Error(envError);
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
      shellEnv: input.shellEnv ?? undefined,
      note: input.note ?? undefined,
      healthCheck: input.healthCheck ?? undefined,
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
        shellEnv: provider.shellEnv ?? null,
        note: provider.note ?? null,
        healthCheck: provider.healthCheck ?? null,
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
          mcpConfig: provider.mcpConfig ?? null,
          shellEnv: provider.shellEnv ?? null,
          note: provider.note ?? null,
          healthCheck: provider.healthCheck ?? null,
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
    /** Null = the organization's; set = one person's own. */
    ownerUserId?: string | null;
    assignments?: Array<{
      repoId?: string | null;
      agentTypes?: string[];
      permission?: string;
    }>;
  },
  workspaceId?: string | null,
): Promise<Connection> {
  // Resolve the provider (by slug, else by id)
  let provider: ConnectionProvider | null = null;
  if (input.providerSlug && !input.providerId) {
    provider = await getProviderBySlug(input.providerSlug, workspaceId);
    if (!provider) throw new Error(`Provider not found: ${input.providerSlug}`);
  } else if (input.providerId) {
    provider = await getProvider(input.providerId);
    if (!provider) throw new Error(`Provider not found: ${input.providerId}`);
  }
  if (!provider) throw new Error("Either providerId or providerSlug is required");
  const providerId = provider.id;

  // Secret fields are sealed on the row (AAD = the row's id), so insert
  // first and seal second — the same two steps as model providers.
  const { config, secrets } = splitConfig(provider, input.config ?? {});
  const [row] = await db
    .insert(connections)
    .values({
      name: input.name,
      providerId,
      config,
      scope: input.repoUrl ?? input.scope ?? "global",
      repoUrl: input.repoUrl ?? undefined,
      workspaceId: workspaceId ?? undefined,
      enabled: input.enabled ?? true,
      ownerUserId: input.ownerUserId ?? null,
    })
    .returning();
  if (Object.keys(secrets).length > 0) {
    await db
      .update(connections)
      .set(sealSecretConfig(row.id, secrets))
      .where(eq(connections.id, row.id));
  }

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

/**
 * Changes a connection. `config` is merged into what is stored: a secret
 * field that is omitted or empty keeps its value, `null` clears it, a
 * `${{NAME}}` reference replaces a stored value. `assignments`, when given,
 * replaces every assignment.
 */
export async function updateConnection(
  id: string,
  input: {
    name?: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
    exportShellEnv?: boolean;
    assignments?: Array<{
      repoId?: string | null;
      agentTypes?: string[];
      permission?: string;
    }>;
  },
): Promise<Connection> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.exportShellEnv !== undefined) updates.exportShellEnv = input.exportShellEnv;
  if (input.config !== undefined) {
    const [existing] = await db
      .select({ connection: connections, provider: connectionProviders })
      .from(connections)
      .leftJoin(connectionProviders, eq(connections.providerId, connectionProviders.id))
      .where(eq(connections.id, id));
    if (!existing) throw new Error("Connection not found");
    const provider = existing.provider ? mapProviderRow(existing.provider) : null;
    const { config, secrets, cleared } = splitConfig(provider, input.config);
    const stored = openSecretConfig(existing.connection);
    for (const key of cleared) delete stored[key];
    const merged = { ...stored, ...secrets };
    const plain = { ...((existing.connection.config as Record<string, unknown>) ?? {}), ...config };
    // A stored value wins over an older reference to a secret of the same name.
    for (const key of Object.keys(merged)) if (isSecretRef(plain[key])) delete plain[key];
    for (const [key, value] of Object.entries(plain)) if (value === null) delete plain[key];
    updates.config = plain;
    Object.assign(updates, sealSecretConfig(id, merged));
  }

  if (input.assignments) {
    const assignments = input.assignments;
    await db.transaction(async (tx) => {
      await tx.update(connections).set(updates).where(eq(connections.id, id));
      await tx.delete(connectionAssignments).where(eq(connectionAssignments.connectionId, id));
      for (const assignment of assignments) {
        await tx.insert(connectionAssignments).values({
          connectionId: id,
          repoId: assignment.repoId ?? undefined,
          agentTypes: assignment.agentTypes ?? [],
          permission: assignment.permission ?? "read",
        });
      }
    });
  } else {
    await db.update(connections).set(updates).where(eq(connections.id, id));
  }

  const full = await getConnection(id);
  return full!;
}

export async function deleteConnection(id: string): Promise<void> {
  await db.delete(connections).where(eq(connections.id, id));
}

/**
 * Runs the provider's health check with the connection's own values and
 * records the outcome. A provider without one leaves the status `unknown`.
 */
export async function testConnection(id: string): Promise<Connection> {
  const [found] = await db
    .select({ connection: connections, provider: connectionProviders })
    .from(connections)
    .leftJoin(connectionProviders, eq(connections.providerId, connectionProviders.id))
    .where(eq(connections.id, id));
  if (!found) throw new Error("Connection not found");
  const provider = found.provider ? mapProviderRow(found.provider) : null;
  const secrets = openSecretConfig(found.connection);
  const config = (found.connection.config as Record<string, unknown>) ?? {};
  const lookup = (key: string): string | undefined => {
    if (key === "name") return found.connection.name;
    if (secrets[key] !== undefined) return secrets[key];
    const v = config[key];
    if (typeof v === "string" && !isSecretRef(v)) return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const fallback = defaultOf(provider, key);
    return fallback;
  };
  const result = await runHealthCheck(provider?.healthCheck ?? null, lookup);
  const updates = result
    ? {
        status: result.status,
        statusMessage: result.message,
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
      }
    : {
        status: "unknown" as const,
        statusMessage: "This provider has no health check",
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
      };
  await db.update(connections).set(updates).where(eq(connections.id, id));
  const full = await getConnection(id);
  return full!;
}

/** The form's defaults for a provider's config keys, as strings. */
export function configDefaults(
  configSchema: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const props = (configSchema as { properties?: Record<string, unknown> } | null)?.properties;
  const out: Record<string, string> = {};
  for (const [key, prop] of Object.entries(props ?? {})) {
    const d = (prop as { default?: unknown } | undefined)?.default;
    if (typeof d === "string") out[key] = d;
    else if (typeof d === "number" || typeof d === "boolean") out[key] = String(d);
  }
  return out;
}

/** The form's default for a config key, when the provider declares one. */
function defaultOf(provider: ConnectionProvider | null, key: string): string | undefined {
  return configDefaults(provider?.configSchema)[key];
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

type AssignmentRow = typeof connectionAssignments.$inferSelect;

/** Empty (or null) agentTypes means the assignment covers every agent. */
function assignmentAgentTypes(a: AssignmentRow): string[] {
  return (a.agentTypes as string[] | null) ?? [];
}

/**
 * Every enabled connection in the workspace that has an enabled assignment
 * covering the repo (a global assignment covers every repo), with those
 * assignments. One read path for task injection and the repo listing.
 */
async function loadRepoConnections(
  repoUrl: string,
  workspaceId?: string | null,
): Promise<
  Array<{
    connection: typeof connections.$inferSelect;
    provider: typeof connectionProviders.$inferSelect;
    assignments: AssignmentRow[];
  }>
> {
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

  // 4. Keep the assignments that cover this repo: global ones (repoId=null)
  // and the repo's own.
  const byConn = new Map<string, AssignmentRow[]>();
  for (const a of assignmentRows) {
    if (a.repoId && (!repo || a.repoId !== repo.id)) continue;
    const list = byConn.get(a.connectionId) ?? [];
    list.push(a);
    byConn.set(a.connectionId, list);
  }

  return connRows
    .filter((r) => byConn.has(r.connection.id))
    .map((r) => ({ ...r, assignments: byConn.get(r.connection.id)! }));
}

/**
 * Resolve all connections that should be injected into a task.
 * Filters by: workspace, enabled state, repo assignments, and agent type.
 */
export async function getConnectionsForTask(
  repoUrl: string,
  agentType: string,
  workspaceId?: string | null,
  /** The work's owner: a personal connection only reaches work its owner owns. */
  ownerUserId?: string | null,
  /** The work's own changes (`WorkSettings.connections`): ids added or left out. */
  overrides?: IdOverrides | null,
): Promise<ResolvedConnection[]> {
  return loadWithOverrides(
    assignedConnections(repoUrl, agentType, workspaceId, ownerUserId),
    () => usableConnections(overrides?.add ?? [], workspaceId, ownerUserId),
    (c) => c.connectionId,
    overrides,
  );
}

/** A connection as an agent gets it, with the permission and agent types it reaches. */
function resolvedConnection(
  conn: typeof connections.$inferSelect,
  provider: typeof connectionProviders.$inferSelect,
  permission: ResolvedConnection["permission"],
  agentTypes: string[],
): ResolvedConnection {
  return {
    connectionId: conn.id,
    connectionName: conn.name,
    providerId: provider.id,
    providerSlug: provider.slug,
    providerName: provider.name,
    providerType: provider.type,
    mcpConfig: (provider.mcpConfig as ConnectionProviderMcpConfig) ?? null,
    config: (conn.config as Record<string, unknown>) ?? {},
    secrets: openSecretConfig(conn),
    configDefaults: configDefaults(provider.configSchema),
    shellEnv: provider.shellEnv ?? null,
    exportShellEnv: conn.exportShellEnv,
    note: provider.note ?? null,
    permission,
    agentTypes,
  };
}

/**
 * Connections by id that a piece of work may add for itself: enabled, in its
 * workspace (or global), and the organization's or its owner's. An added
 * connection has no assignment, so it reaches every agent with the default
 * permission.
 */
async function usableConnections(
  ids: string[],
  workspaceId?: string | null,
  ownerUserId?: string | null,
): Promise<ResolvedConnection[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ connection: connections, provider: connectionProviders })
    .from(connections)
    .innerJoin(connectionProviders, eq(connections.providerId, connectionProviders.id))
    .where(
      and(
        inArray(connections.id, ids),
        eq(connections.enabled, true),
        workspaceId
          ? or(eq(connections.workspaceId, workspaceId), isNull(connections.workspaceId))
          : undefined,
      ),
    );
  return rows
    .filter((r) => !r.connection.ownerUserId || r.connection.ownerUserId === (ownerUserId ?? null))
    .map(({ connection, provider }) => resolvedConnection(connection, provider, "read", []));
}

/** The connections the repo's (and global) assignments give this agent. */
async function assignedConnections(
  repoUrl: string,
  agentType: string,
  workspaceId?: string | null,
  ownerUserId?: string | null,
): Promise<ResolvedConnection[]> {
  const results: ResolvedConnection[] = [];

  for (const { connection: conn, provider, assignments } of await loadRepoConnections(
    repoUrl,
    workspaceId,
  )) {
    if (conn.ownerUserId && conn.ownerUserId !== (ownerUserId ?? null)) continue;
    // 5. An assignment that covers this repo AND this agent type (empty
    // agentTypes = all agents). Every covering assignment counts — a global
    // one limited to another agent must not hide the repo's own. The repo's
    // own assignment wins over a global one (its permission applies).
    const matching = assignments
      .filter((a) => {
        const types = assignmentAgentTypes(a);
        return types.length === 0 || types.includes(agentType);
      })
      .sort((a, b) => Number(!a.repoId) - Number(!b.repoId))[0];
    if (!matching) continue;

    results.push(
      resolvedConnection(conn, provider, matching.permission, assignmentAgentTypes(matching)),
    );
  }

  return results;
}

/**
 * Every connection that applies to a repo, for any agent — what
 * `GET /api/repos/:id/connections` lists. Each carries its full assignment
 * list plus `agentTypes`: the agent types it's injected for on this repo
 * (union of the covering assignments; empty = every agent).
 */
export async function listConnectionsForRepo(
  repoUrl: string,
  workspaceId?: string | null,
): Promise<RepoConnection[]> {
  const matches = await loadRepoConnections(repoUrl, workspaceId);
  if (matches.length === 0) return [];

  const allAssignments = await db
    .select()
    .from(connectionAssignments)
    .where(
      inArray(
        connectionAssignments.connectionId,
        matches.map((m) => m.connection.id),
      ),
    );

  return matches.map(({ connection, provider, assignments }) => {
    const everyAgent = assignments.some((a) => assignmentAgentTypes(a).length === 0);
    const agentTypes = everyAgent
      ? []
      : [...new Set(assignments.flatMap((a) => assignmentAgentTypes(a)))];
    return {
      ...mapConnectionRow(connection, provider),
      assignments: allAssignments
        .filter((a) => a.connectionId === connection.id)
        .map(mapAssignmentRow),
      agentTypes,
    };
  });
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
    shellEnv: row.shellEnv ?? null,
    note: row.note ?? null,
    healthCheck: (row.healthCheck as ConnectionHealthCheck | null) ?? null,
    parts: providerParts({
      configSchema: row.configSchema,
      requiredSecrets: row.requiredSecrets,
      mcpConfig: row.mcpConfig as ConnectionProviderMcpConfig | null,
      shellEnv: row.shellEnv ?? null,
      note: row.note ?? null,
    }),
    capabilities: row.capabilities,
    docsUrl: row.docsUrl,
    builtIn: row.builtIn,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A connection as the API returns it: the plain config, the names (never
 * the values) of its sealed secret fields, and what it gives an agent.
 */
function mapConnectionRow(
  row: typeof connections.$inferSelect,
  providerRow?: typeof connectionProviders.$inferSelect | null,
): Connection {
  const provider = providerRow ? mapProviderRow(providerRow) : null;
  const secretFields = Object.keys(openSecretConfig(row));
  const secretNames = new Set(secretFieldNames(provider));
  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((row.config as Record<string, unknown> | null) ?? {})) {
    // A pre-v2 row may still hold a plaintext secret: never return it.
    if (secretNames.has(k) && !isSecretRef(v)) continue;
    config[k] = v;
  }
  return {
    id: row.id,
    name: row.name,
    providerId: row.providerId,
    config,
    secretFields,
    exportShellEnv: row.exportShellEnv,
    parts: connectionParts(provider, {
      config,
      secretFields,
      exportShellEnv: row.exportShellEnv,
      providerSlug: provider?.slug ?? null,
    }),
    scope: row.scope,
    repoUrl: row.repoUrl,
    workspaceId: row.workspaceId,
    ownerUserId: row.ownerUserId,
    enabled: row.enabled,
    status: row.status,
    statusMessage: row.statusMessage,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    provider,
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
