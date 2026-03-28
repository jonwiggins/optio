import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  mcpServers: {
    id: "mcp_servers.id",
    scope: "mcp_servers.scope",
    workspaceId: "mcp_servers.workspace_id",
    enabled: "mcp_servers.enabled",
  },
}));

vi.mock("./secret-service.js", () => ({
  retrieveSecret: vi.fn(),
}));

import { db } from "../db/client.js";
import { retrieveSecret } from "./secret-service.js";
import {
  listMcpServers,
  getMcpServer,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  getMcpServersForTask,
  resolveSecretRefs,
  buildMcpJsonContent,
} from "./mcp-server-service.js";

const makeRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "mcp-1",
  name: "test-server",
  command: "npx",
  args: ["@test/mcp"],
  env: null,
  installCommand: null,
  scope: "global",
  repoUrl: null,
  workspaceId: null,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("mcp-server-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listMcpServers", () => {
    it("lists all servers with no filters", async () => {
      const rows = [makeRow()];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(rows),
      });

      const result = await listMcpServers();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("test-server");
    });

    it("filters by scope and workspaceId", async () => {
      const rows = [makeRow()];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      });

      const result = await listMcpServers("global", "ws-1");
      expect(result).toHaveLength(1);
    });
  });

  describe("getMcpServer", () => {
    it("returns server when found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([makeRow()]),
        }),
      });

      const result = await getMcpServer("mcp-1");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("test-server");
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getMcpServer("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("createMcpServer", () => {
    it("creates a server with defaults", async () => {
      const row = makeRow();
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([row]),
        }),
      });

      const result = await createMcpServer({
        name: "test-server",
        command: "npx",
        args: ["@test/mcp"],
      });

      expect(result.name).toBe("test-server");
      expect(result.command).toBe("npx");
    });

    it("creates a repo-scoped server", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return {
            returning: vi
              .fn()
              .mockResolvedValue([
                makeRow({ scope: "https://github.com/o/r", repoUrl: "https://github.com/o/r" }),
              ]),
          };
        }),
      });

      await createMcpServer({
        name: "repo-server",
        command: "node",
        repoUrl: "https://github.com/o/r",
      });

      expect(capturedValues.scope).toBe("https://github.com/o/r");
      expect(capturedValues.repoUrl).toBe("https://github.com/o/r");
    });
  });

  describe("updateMcpServer", () => {
    it("updates specified fields", async () => {
      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([makeRow({ name: "updated" })]),
            }),
          };
        }),
      });

      const result = await updateMcpServer("mcp-1", { name: "updated" });

      expect(capturedSet.name).toBe("updated");
      expect(capturedSet.updatedAt).toBeInstanceOf(Date);
      expect(result.name).toBe("updated");
    });

    it("only includes provided fields", async () => {
      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([makeRow()]),
            }),
          };
        }),
      });

      await updateMcpServer("mcp-1", { enabled: false });

      expect(capturedSet.enabled).toBe(false);
      expect(capturedSet.name).toBeUndefined();
    });
  });

  describe("deleteMcpServer", () => {
    it("deletes a server", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      await deleteMcpServer("mcp-1");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe("getMcpServersForTask", () => {
    it("returns enabled servers for repo, overriding globals", async () => {
      const globalRow = makeRow({ id: "mcp-g", name: "shared", scope: "global" });
      const repoRow = makeRow({
        id: "mcp-r",
        name: "shared",
        scope: "https://github.com/o/r",
      });
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([globalRow, repoRow]),
        }),
      });

      const result = await getMcpServersForTask("https://github.com/o/r");
      expect(result).toHaveLength(1);
      expect(result[0].scope).toBe("https://github.com/o/r");
    });

    it("keeps global server when no repo override exists", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([makeRow({ scope: "global" })]),
        }),
      });

      const result = await getMcpServersForTask("https://github.com/o/r");
      expect(result).toHaveLength(1);
      expect(result[0].scope).toBe("global");
    });
  });

  describe("resolveSecretRefs", () => {
    it("resolves ${{SECRET}} patterns in env vars", async () => {
      vi.mocked(retrieveSecret).mockResolvedValue("secret-value");

      const result = await resolveSecretRefs(
        { API_KEY: "${{MY_SECRET}}" },
        "https://github.com/o/r",
      );

      expect(result.API_KEY).toBe("secret-value");
    });

    it("falls back to global scope when repo scope fails", async () => {
      vi.mocked(retrieveSecret)
        .mockRejectedValueOnce(new Error("not found"))
        .mockResolvedValueOnce("global-value");

      const result = await resolveSecretRefs({ KEY: "${{MY_SECRET}}" }, "https://github.com/o/r");

      expect(result.KEY).toBe("global-value");
      expect(retrieveSecret).toHaveBeenCalledTimes(2);
    });

    it("leaves reference as-is when secret not found at all", async () => {
      vi.mocked(retrieveSecret).mockRejectedValue(new Error("not found"));

      const result = await resolveSecretRefs({ KEY: "${{MISSING}}" }, "https://github.com/o/r");

      expect(result.KEY).toBe("${{MISSING}}");
    });

    it("passes through values without secret refs", async () => {
      const result = await resolveSecretRefs({ PLAIN: "hello" }, "https://github.com/o/r");

      expect(result.PLAIN).toBe("hello");
      expect(retrieveSecret).not.toHaveBeenCalled();
    });

    it("resolves multiple refs in a single value", async () => {
      vi.mocked(retrieveSecret).mockResolvedValue("val");

      const result = await resolveSecretRefs(
        { COMBINED: "${{A}}:${{B}}" },
        "https://github.com/o/r",
      );

      expect(result.COMBINED).toBe("val:val");
    });
  });

  describe("buildMcpJsonContent", () => {
    it("builds valid .mcp.json content", async () => {
      vi.mocked(retrieveSecret).mockResolvedValue("resolved");

      const servers = [
        {
          id: "s-1",
          name: "my-server",
          command: "node",
          args: ["server.js"],
          env: { KEY: "${{SECRET}}" },
          installCommand: null,
          scope: "global",
          repoUrl: null,
          workspaceId: null,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const result = await buildMcpJsonContent(servers, "https://github.com/o/r");
      const parsed = JSON.parse(result);

      expect(parsed.mcpServers["my-server"]).toBeDefined();
      expect(parsed.mcpServers["my-server"].command).toBe("node");
      expect(parsed.mcpServers["my-server"].args).toEqual(["server.js"]);
      expect(parsed.mcpServers["my-server"].env.KEY).toBe("resolved");
    });

    it("omits env when no env vars", async () => {
      const servers = [
        {
          id: "s-1",
          name: "simple",
          command: "npx",
          args: ["server"],
          env: null,
          installCommand: null,
          scope: "global",
          repoUrl: null,
          workspaceId: null,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const result = await buildMcpJsonContent(servers, "https://github.com/o/r");
      const parsed = JSON.parse(result);

      expect(parsed.mcpServers["simple"].env).toBeUndefined();
    });

    it("resolves secret refs in args", async () => {
      vi.mocked(retrieveSecret).mockResolvedValue("token123");

      const servers = [
        {
          id: "s-1",
          name: "auth-server",
          command: "node",
          args: ["--token", "${{API_TOKEN}}"],
          env: null,
          installCommand: null,
          scope: "global",
          repoUrl: null,
          workspaceId: null,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const result = await buildMcpJsonContent(servers, "https://github.com/o/r");
      const parsed = JSON.parse(result);

      expect(parsed.mcpServers["auth-server"].args).toEqual(["--token", "token123"]);
    });
  });
});
