import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock db BEFORE imports
vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// Mock schema with string column references
vi.mock("../db/schema.js", () => ({
  connectionProviders: {
    id: "connection_providers.id",
    slug: "connection_providers.slug",
    workspaceId: "connection_providers.workspace_id",
    builtIn: "connection_providers.built_in",
    category: "connection_providers.category",
  },
  connections: {
    id: "connections.id",
    providerId: "connections.provider_id",
    workspaceId: "connections.workspace_id",
    scope: "connections.scope",
    enabled: "connections.enabled",
    status: "connections.status",
  },
  connectionAssignments: {
    id: "connection_assignments.id",
    connectionId: "connection_assignments.connection_id",
    repoId: "connection_assignments.repo_id",
    enabled: "connection_assignments.enabled",
  },
  repos: {
    id: "repos.id",
    repoUrl: "repos.repo_url",
  },
}));

vi.mock("./secret-service.js", () => ({
  retrieveSecret: vi.fn(),
  encrypt: vi.fn((plaintext: string) => ({
    alg: 1,
    iv: Buffer.from("iv"),
    ciphertext: Buffer.from(plaintext),
    authTag: Buffer.from("tag"),
  })),
  decrypt: vi.fn((blob: { ciphertext: Buffer }) => blob.ciphertext.toString()),
}));

vi.mock("./connection-health.js", () => ({
  runHealthCheck: vi.fn().mockResolvedValue(null),
}));

// Import AFTER mocks
import { db } from "../db/client.js";
import {
  listProviders,
  getProvider,
  getProviderBySlug,
  createProvider,
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
  listAssignments,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  getConnectionsForTask,
} from "./connection-service.js";

// ── Row factory helpers ──────────────────────────────────────────────────

const makeProviderRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "prov-1",
  slug: "notion",
  name: "Notion",
  description: "Search Notion",
  icon: "notion",
  category: "productivity",
  type: "mcp",
  configSchema: null,
  requiredSecrets: [],
  mcpConfig: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-notion"],
    envMapping: { NOTION_API_KEY: "NOTION_API_KEY" },
  },
  capabilities: ["search_pages"],
  docsUrl: null,
  builtIn: true,
  workspaceId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeConnectionRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "conn-1",
  name: "Our Notion",
  providerId: "prov-1",
  config: { NOTION_API_KEY: "secret-key" },
  scope: "global",
  repoUrl: null,
  workspaceId: "ws-1",
  enabled: true,
  status: "unknown",
  statusMessage: null,
  lastCheckedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeAssignmentRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "assign-1",
  connectionId: "conn-1",
  repoId: null,
  agentTypes: [],
  permission: "read",
  enabled: true,
  createdAt: new Date(),
  ...overrides,
});

describe("connection providers with OPTIO_CONNECTION_PROVIDERS narrowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPTIO_CONNECTION_PROVIDERS", "postgres,filesystem,custom-http,custom-mcp");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists the built-ins it keeps and every custom provider (all stay seeded)", async () => {
    const rows = [
      makeProviderRow({ id: "p1", slug: "notion", builtIn: true }),
      makeProviderRow({ id: "p2", slug: "postgres", builtIn: true }),
      makeProviderRow({ id: "p3", slug: "github-enhanced", builtIn: true }),
      makeProviderRow({ id: "p4", slug: "our-wiki", builtIn: false, workspaceId: "ws-1" }),
    ];
    (db.select as any) = vi.fn().mockReturnValue({ from: vi.fn().mockResolvedValue(rows) });
    expect((await listProviders()).map((p) => p.slug)).toEqual(["postgres", "our-wiki"]);

    vi.stubEnv("OPTIO_CONNECTION_PROVIDERS", "");
    expect(await listProviders()).toHaveLength(4);
  });

  it("refuses a connection to a built-in it leaves out", async () => {
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([makeProviderRow({ slug: "notion", builtIn: true })]),
      }),
    });
    (db.insert as any) = vi.fn();
    await expect(
      createConnection({ name: "Our Notion", providerSlug: "notion", config: {} }),
    ).rejects.toThrow("notion isn't available in this deployment");
    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ── Built-in provider manifests ──────────────────────────────────────────

import {
  BUILT_IN_PROVIDERS,
  connectionParts,
  providerEnvNameError,
  providerParts,
  secretFieldNames,
  splitConfig,
} from "./connection-service.js";
