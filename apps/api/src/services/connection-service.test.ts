import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("connection-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Provider CRUD ────────────────────────────────────────────────────

  describe("listProviders", () => {
    it("lists all providers with no filter", async () => {
      const rows = [makeProviderRow()];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(rows),
      });

      const result = await listProviders();
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe("notion");
    });

    it("filters by workspaceId when provided", async () => {
      const rows = [makeProviderRow({ workspaceId: "ws-1" })];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      });

      const result = await listProviders("ws-1");
      expect(result).toHaveLength(1);
      expect(result[0].workspaceId).toBe("ws-1");
    });
  });

  describe("getProvider", () => {
    it("returns provider when found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([makeProviderRow()]),
        }),
      });

      const result = await getProvider("prov-1");
      expect(result).not.toBeNull();
      expect(result!.slug).toBe("notion");
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getProvider("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("getProviderBySlug", () => {
    it("returns provider matching slug", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([makeProviderRow()]),
        }),
      });

      const result = await getProviderBySlug("notion");
      expect(result).not.toBeNull();
      expect(result!.slug).toBe("notion");
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getProviderBySlug("nonexistent");
      expect(result).toBeNull();
    });

    it("prefers workspace-scoped provider over built-in", async () => {
      const builtIn = makeProviderRow({ id: "prov-builtin", workspaceId: null });
      const wsScoped = makeProviderRow({ id: "prov-ws", workspaceId: "ws-1" });
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([builtIn, wsScoped]),
        }),
      });

      const result = await getProviderBySlug("notion", "ws-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("prov-ws");
    });
  });

  describe("createProvider", () => {
    it("creates provider with defaults", async () => {
      const row = makeProviderRow({ builtIn: false });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([row]),
        }),
      });

      const result = await createProvider({
        slug: "notion",
        name: "Notion",
      });

      expect(result.slug).toBe("notion");
      expect(result.name).toBe("Notion");
    });

    it("passes workspaceId through", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return {
            returning: vi
              .fn()
              .mockResolvedValue([makeProviderRow({ workspaceId: "ws-1", builtIn: false })]),
          };
        }),
      });

      const result = await createProvider({ slug: "custom", name: "Custom" }, "ws-1");

      expect(capturedValues.workspaceId).toBe("ws-1");
      expect(capturedValues.builtIn).toBe(false);
      expect(result.workspaceId).toBe("ws-1");
    });
  });

  // ── Connection CRUD ──────────────────────────────────────────────────

  describe("listConnections", () => {
    it("returns connections with joined provider data", async () => {
      const rows = [{ connection: makeConnectionRow(), provider: makeProviderRow() }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockResolvedValue(rows),
        }),
      });

      const result = await listConnections();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Our Notion");
      expect(result[0].provider).not.toBeNull();
      expect(result[0].provider!.slug).toBe("notion");
    });

    it("filters by workspaceId when provided", async () => {
      const rows = [{ connection: makeConnectionRow(), provider: makeProviderRow() }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(rows),
          }),
        }),
      });

      const result = await listConnections("ws-1");
      expect(result).toHaveLength(1);
    });
  });

  describe("getConnection", () => {
    it("returns connection with provider and assignments", async () => {
      const connRows = [{ connection: makeConnectionRow(), provider: makeProviderRow() }];
      const assignmentRows = [makeAssignmentRow()];

      // First call: select connection with provider join
      // Second call: select assignments
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(connRows),
              }),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(assignmentRows),
          }),
        };
      });

      const result = await getConnection("conn-1");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("Our Notion");
      expect(result!.provider).not.toBeNull();
      expect(result!.assignments).toHaveLength(1);
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await getConnection("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("createConnection", () => {
    it("creates connection and returns it", async () => {
      const connRow = makeConnectionRow();
      const providerRow = makeProviderRow();

      // Mock getProviderBySlug (select for slug lookup)
      // Mock insert for connection
      // Mock getConnection (select for join + select for assignments)
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // getProviderBySlug
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([providerRow]),
            }),
          };
        }
        if (selectCallCount === 2) {
          // getConnection: connection with provider join
          return {
            from: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([{ connection: connRow, provider: providerRow }]),
              }),
            }),
          };
        }
        // getConnection: assignments
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        };
      });

      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([connRow]),
        }),
      });

      const result = await createConnection({
        name: "Our Notion",
        providerSlug: "notion",
        config: { NOTION_API_KEY: "secret-key" },
      });

      expect(result.name).toBe("Our Notion");
      expect(result.provider).not.toBeNull();
    });

    it("creates inline assignments when provided", async () => {
      const connRow = makeConnectionRow();
      const providerRow = makeProviderRow();

      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([providerRow]),
            }),
          };
        }
        if (selectCallCount === 2) {
          return {
            from: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([{ connection: connRow, provider: providerRow }]),
              }),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([makeAssignmentRow()]),
          }),
        };
      });

      let insertCallCount = 0;
      (db.insert as any) = vi.fn().mockImplementation(() => {
        insertCallCount++;
        if (insertCallCount === 1) {
          // connection insert
          return {
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([connRow]),
            }),
          };
        }
        // assignment inserts (no returning needed)
        return {
          values: vi.fn().mockResolvedValue(undefined),
        };
      });

      const result = await createConnection({
        name: "Our Notion",
        providerSlug: "notion",
        assignments: [{ repoId: null, agentTypes: [], permission: "read" }],
      });

      expect(result.assignments).toHaveLength(1);
      expect(insertCallCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("updateConnection", () => {
    it("updates specified fields", async () => {
      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockResolvedValue(undefined),
          };
        }),
      });

      // Mock getConnection for the return value
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([
                  {
                    connection: makeConnectionRow({ name: "Updated" }),
                    provider: makeProviderRow(),
                  },
                ]),
              }),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        };
      });

      const result = await updateConnection("conn-1", { name: "Updated" });

      expect(capturedSet.name).toBe("Updated");
      expect(capturedSet.updatedAt).toBeInstanceOf(Date);
      expect(result.name).toBe("Updated");
    });

    it("includes updatedAt even with no other fields", async () => {
      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockResolvedValue(undefined),
          };
        }),
      });

      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi
                  .fn()
                  .mockResolvedValue([
                    { connection: makeConnectionRow(), provider: makeProviderRow() },
                  ]),
              }),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        };
      });

      await updateConnection("conn-1", {});

      expect(capturedSet.updatedAt).toBeInstanceOf(Date);
      expect(capturedSet.name).toBeUndefined();
    });
  });

  describe("deleteConnection", () => {
    it("deletes a connection", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      await deleteConnection("conn-1");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  // ── Assignment CRUD ──────────────────────────────────────────────────

  describe("listAssignments", () => {
    it("returns assignments for a connection", async () => {
      const rows = [makeAssignmentRow()];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      });

      const result = await listAssignments("conn-1");
      expect(result).toHaveLength(1);
      expect(result[0].connectionId).toBe("conn-1");
    });
  });

  describe("createAssignment", () => {
    it("creates assignment with defaults", async () => {
      const row = makeAssignmentRow();
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([row]),
        }),
      });

      const result = await createAssignment("conn-1", {});
      expect(result.connectionId).toBe("conn-1");
      expect(result.permission).toBe("read");
    });
  });

  describe("updateAssignment", () => {
    it("updates assignment fields", async () => {
      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([makeAssignmentRow({ permission: "write" })]),
            }),
          };
        }),
      });

      const result = await updateAssignment("assign-1", { permission: "write" });

      expect(capturedSet.permission).toBe("write");
      expect(result.permission).toBe("write");
    });
  });

  describe("deleteAssignment", () => {
    it("deletes assignment", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      await deleteAssignment("assign-1");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  // ── getConnectionsForTask ────────────────────────────────────────────

  describe("getConnectionsForTask", () => {
    /**
     * Helper to mock the three sequential DB queries that getConnectionsForTask
     * makes:
     *   1. select repo by URL
     *   2. select enabled connections (innerJoin with providers)
     *   3. select enabled assignments for those connections
     */
    function mockTaskQueries(repoRows: any[], connProviderRows: any[], assignmentRows: any[]) {
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // 1. repo lookup
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(repoRows),
            }),
          };
        }
        if (selectCallCount === 2) {
          // 2. connections with provider innerJoin
          return {
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(connProviderRows),
              }),
            }),
          };
        }
        // 3. assignments
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(assignmentRows),
          }),
        };
      });
    }

    it("returns connections matching repo with global assignment (repoId=null)", async () => {
      mockTaskQueries(
        [{ id: "repo-1", repoUrl: "https://github.com/o/r" }],
        [
          {
            connection: makeConnectionRow(),
            provider: makeProviderRow(),
          },
        ],
        [makeAssignmentRow({ connectionId: "conn-1", repoId: null, agentTypes: [] })],
      );

      const result = await getConnectionsForTask("https://github.com/o/r", "claude", "ws-1");

      expect(result).toHaveLength(1);
      expect(result[0].connectionId).toBe("conn-1");
      expect(result[0].providerSlug).toBe("notion");
    });

    it("uses any covering assignment that allows the agent, preferring the repo's own", async () => {
      mockTaskQueries(
        [{ id: "repo-1", repoUrl: "https://github.com/o/r" }],
        [{ connection: makeConnectionRow(), provider: makeProviderRow() }],
        [
          // Global, limited to another agent — listed first, as the DB may.
          makeAssignmentRow({
            id: "a-global",
            connectionId: "conn-1",
            repoId: null,
            agentTypes: ["codex"],
            permission: "read",
          }),
          makeAssignmentRow({
            id: "a-repo",
            connectionId: "conn-1",
            repoId: "repo-1",
            agentTypes: [],
            permission: "write",
          }),
        ],
      );

      const result = await getConnectionsForTask("https://github.com/o/r", "claude", "ws-1");

      expect(result).toHaveLength(1);
      expect(result[0].permission).toBe("write");
      expect(result[0].agentTypes).toEqual([]);
    });

    it("filters by agent type when agentTypes is set on assignment", async () => {
      mockTaskQueries(
        [{ id: "repo-1", repoUrl: "https://github.com/o/r" }],
        [
          {
            connection: makeConnectionRow(),
            provider: makeProviderRow(),
          },
        ],
        [
          makeAssignmentRow({
            connectionId: "conn-1",
            repoId: null,
            agentTypes: ["codex"],
          }),
        ],
      );

      const result = await getConnectionsForTask("https://github.com/o/r", "claude", "ws-1");

      expect(result).toHaveLength(0);
    });

    it("includes connection when agentType matches", async () => {
      mockTaskQueries(
        [{ id: "repo-1", repoUrl: "https://github.com/o/r" }],
        [
          {
            connection: makeConnectionRow(),
            provider: makeProviderRow(),
          },
        ],
        [
          makeAssignmentRow({
            connectionId: "conn-1",
            repoId: null,
            agentTypes: ["claude", "codex"],
          }),
        ],
      );

      const result = await getConnectionsForTask("https://github.com/o/r", "claude", "ws-1");

      expect(result).toHaveLength(1);
      expect(result[0].connectionId).toBe("conn-1");
    });

    it("returns empty when no matching assignments", async () => {
      mockTaskQueries(
        [{ id: "repo-1", repoUrl: "https://github.com/o/r" }],
        [
          {
            connection: makeConnectionRow(),
            provider: makeProviderRow(),
          },
        ],
        // Assignment for a different connection
        [makeAssignmentRow({ connectionId: "conn-other", repoId: null })],
      );

      const result = await getConnectionsForTask("https://github.com/o/r", "claude", "ws-1");

      expect(result).toHaveLength(0);
    });

    it("returns connections when assignment has matching repoId", async () => {
      mockTaskQueries(
        [{ id: "repo-1", repoUrl: "https://github.com/o/r" }],
        [
          {
            connection: makeConnectionRow(),
            provider: makeProviderRow(),
          },
        ],
        [makeAssignmentRow({ connectionId: "conn-1", repoId: "repo-1" })],
      );

      const result = await getConnectionsForTask("https://github.com/o/r", "claude", "ws-1");

      expect(result).toHaveLength(1);
      expect(result[0].connectionId).toBe("conn-1");
    });

    it("excludes connection when assignment repoId does not match", async () => {
      mockTaskQueries(
        [{ id: "repo-1", repoUrl: "https://github.com/o/r" }],
        [
          {
            connection: makeConnectionRow(),
            provider: makeProviderRow(),
          },
        ],
        [makeAssignmentRow({ connectionId: "conn-1", repoId: "repo-other" })],
      );

      const result = await getConnectionsForTask("https://github.com/o/r", "claude", "ws-1");

      expect(result).toHaveLength(0);
    });

    it("returns empty when no enabled connections exist", async () => {
      mockTaskQueries([{ id: "repo-1", repoUrl: "https://github.com/o/r" }], [], []);

      const result = await getConnectionsForTask("https://github.com/o/r", "claude", "ws-1");

      expect(result).toHaveLength(0);
    });

    it("works when repo is not found in database", async () => {
      // repo not found, but global assignment still matches (repoId=null)
      mockTaskQueries(
        [],
        [
          {
            connection: makeConnectionRow(),
            provider: makeProviderRow(),
          },
        ],
        [makeAssignmentRow({ connectionId: "conn-1", repoId: null, agentTypes: [] })],
      );

      const result = await getConnectionsForTask("https://github.com/o/unknown", "claude", "ws-1");

      expect(result).toHaveLength(1);
      expect(result[0].connectionId).toBe("conn-1");
    });

    it("resolves correct provider fields in result", async () => {
      const provider = makeProviderRow({
        id: "prov-slack",
        slug: "slack",
        name: "Slack",
        type: "mcp",
        mcpConfig: {
          command: "npx",
          args: ["-y", "@anthropic/mcp-server-slack"],
          envMapping: { SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN" },
        },
      });

      mockTaskQueries(
        [{ id: "repo-1", repoUrl: "https://github.com/o/r" }],
        [
          {
            connection: makeConnectionRow({
              id: "conn-slack",
              providerId: "prov-slack",
              config: { SLACK_BOT_TOKEN: "xoxb-123" },
            }),
            provider,
          },
        ],
        [makeAssignmentRow({ connectionId: "conn-slack", repoId: null, permission: "write" })],
      );

      const result = await getConnectionsForTask("https://github.com/o/r", "claude", "ws-1");

      expect(result).toHaveLength(1);
      expect(result[0].providerSlug).toBe("slack");
      expect(result[0].providerName).toBe("Slack");
      expect(result[0].providerType).toBe("mcp");
      expect(result[0].mcpConfig).toEqual(provider.mcpConfig);
      expect(result[0].config).toEqual({ SLACK_BOT_TOKEN: "xoxb-123" });
      expect(result[0].permission).toBe("write");
    });
  });
});
