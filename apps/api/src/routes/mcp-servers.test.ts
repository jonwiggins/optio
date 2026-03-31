import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListMcpServers = vi.fn();
const mockGetMcpServer = vi.fn();
const mockCreateMcpServer = vi.fn();
const mockUpdateMcpServer = vi.fn();
const mockDeleteMcpServer = vi.fn();
const mockGetMcpServersForTask = vi.fn();

vi.mock("../services/mcp-server-service.js", () => ({
  listMcpServers: (...args: unknown[]) => mockListMcpServers(...args),
  getMcpServer: (...args: unknown[]) => mockGetMcpServer(...args),
  createMcpServer: (...args: unknown[]) => mockCreateMcpServer(...args),
  updateMcpServer: (...args: unknown[]) => mockUpdateMcpServer(...args),
  deleteMcpServer: (...args: unknown[]) => mockDeleteMcpServer(...args),
  getMcpServersForTask: (...args: unknown[]) => mockGetMcpServersForTask(...args),
}));

const mockGetRepo = vi.fn();
vi.mock("../services/repo-service.js", () => ({
  getRepo: (...args: unknown[]) => mockGetRepo(...args),
}));

import { mcpServerRoutes } from "./mcp-servers.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { workspaceId: "ws-1" };
    done();
  });
  await mcpServerRoutes(app);
  await app.ready();
  return app;
}

describe("GET /api/mcp-servers", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists MCP servers", async () => {
    mockListMcpServers.mockResolvedValue([{ id: "mcp-1", name: "puppeteer" }]);

    const res = await app.inject({ method: "GET", url: "/api/mcp-servers" });

    expect(res.statusCode).toBe(200);
    expect(res.json().servers).toHaveLength(1);
    expect(mockListMcpServers).toHaveBeenCalledWith(undefined, "ws-1");
  });
});

describe("GET /api/mcp-servers/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns 404 for MCP server from another workspace", async () => {
    mockGetMcpServer.mockResolvedValue({ id: "mcp-1", workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/mcp-servers/mcp-1" });

    expect(res.statusCode).toBe(404);
  });

  it("returns MCP server from own workspace", async () => {
    mockGetMcpServer.mockResolvedValue({ id: "mcp-1", workspaceId: "ws-1", name: "test" });

    const res = await app.inject({ method: "GET", url: "/api/mcp-servers/mcp-1" });

    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/mcp-servers", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates an MCP server", async () => {
    mockCreateMcpServer.mockResolvedValue({ id: "mcp-1", name: "puppeteer" });

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: { name: "puppeteer", command: "npx @anthropic-ai/mcp-puppeteer" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "puppeteer", command: "npx @anthropic-ai/mcp-puppeteer" }),
      "ws-1",
    );
  });

  it("rejects missing command (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: { name: "puppeteer" },
    });

    expect(res.statusCode).toBe(500);
  });
});

describe("PATCH /api/mcp-servers/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates an MCP server", async () => {
    mockGetMcpServer.mockResolvedValue({ id: "mcp-1", workspaceId: "ws-1" });
    mockUpdateMcpServer.mockResolvedValue({ id: "mcp-1", enabled: false });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/mcp-1",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for MCP server from another workspace", async () => {
    mockGetMcpServer.mockResolvedValue({ id: "mcp-1", workspaceId: "ws-other" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/mcp-1",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for nonexistent server", async () => {
    mockGetMcpServer.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/nonexistent",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/mcp-servers/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes an MCP server", async () => {
    mockGetMcpServer.mockResolvedValue({ id: "mcp-1", workspaceId: "ws-1" });
    mockDeleteMcpServer.mockResolvedValue(undefined);

    const res = await app.inject({ method: "DELETE", url: "/api/mcp-servers/mcp-1" });

    expect(res.statusCode).toBe(204);
  });

  it("returns 404 for nonexistent server", async () => {
    mockGetMcpServer.mockResolvedValue(null);

    const res = await app.inject({ method: "DELETE", url: "/api/mcp-servers/nonexistent" });

    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/repos/:id/mcp-servers", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns MCP servers for a repo", async () => {
    mockGetRepo.mockResolvedValue({ id: "repo-1", repoUrl: "https://github.com/org/repo" });
    mockGetMcpServersForTask.mockResolvedValue([{ id: "mcp-1" }]);

    const res = await app.inject({ method: "GET", url: "/api/repos/repo-1/mcp-servers" });

    expect(res.statusCode).toBe(200);
    expect(res.json().servers).toHaveLength(1);
    expect(mockGetMcpServersForTask).toHaveBeenCalledWith("https://github.com/org/repo", "ws-1");
  });

  it("returns 404 for nonexistent repo", async () => {
    mockGetRepo.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/repos/nonexistent/mcp-servers" });

    expect(res.statusCode).toBe(404);
  });
});
