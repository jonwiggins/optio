import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockListProviders = vi.fn();
const mockGetProvider = vi.fn();
const mockGetProviderBySlug = vi.fn();
const mockCreateProvider = vi.fn();
const mockListConnections = vi.fn();
const mockGetConnection = vi.fn();
const mockCreateConnection = vi.fn();
const mockUpdateConnection = vi.fn();
const mockDeleteConnection = vi.fn();
const mockTestConnection = vi.fn();
const mockListAssignments = vi.fn();
const mockGetAssignment = vi.fn();
const mockCreateAssignment = vi.fn();
const mockUpdateAssignment = vi.fn();
const mockDeleteAssignment = vi.fn();
const mockGetConnectionsForTask = vi.fn();

vi.mock("../services/connection-service.js", () => ({
  listProviders: (...args: unknown[]) => mockListProviders(...args),
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
  getProviderBySlug: (...args: unknown[]) => mockGetProviderBySlug(...args),
  createProvider: (...args: unknown[]) => mockCreateProvider(...args),
  listConnections: (...args: unknown[]) => mockListConnections(...args),
  getConnection: (...args: unknown[]) => mockGetConnection(...args),
  createConnection: (...args: unknown[]) => mockCreateConnection(...args),
  updateConnection: (...args: unknown[]) => mockUpdateConnection(...args),
  deleteConnection: (...args: unknown[]) => mockDeleteConnection(...args),
  testConnection: (...args: unknown[]) => mockTestConnection(...args),
  listAssignments: (...args: unknown[]) => mockListAssignments(...args),
  getAssignment: (...args: unknown[]) => mockGetAssignment(...args),
  createAssignment: (...args: unknown[]) => mockCreateAssignment(...args),
  updateAssignment: (...args: unknown[]) => mockUpdateAssignment(...args),
  deleteAssignment: (...args: unknown[]) => mockDeleteAssignment(...args),
  getConnectionsForTask: (...args: unknown[]) => mockGetConnectionsForTask(...args),
}));

const mockGetRepo = vi.fn();
vi.mock("../services/repo-service.js", () => ({
  getRepo: (...args: unknown[]) => mockGetRepo(...args),
}));

import { connectionRoutes } from "./connections.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(connectionRoutes);
}

// ── Provider routes ────────────────────────────────────────────────────────

describe("GET /api/connection-providers", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists providers", async () => {
    mockListProviders.mockResolvedValue([{ id: "prov-1", slug: "notion" }]);

    const res = await app.inject({ method: "GET", url: "/api/connection-providers" });

    expect(res.statusCode).toBe(200);
    expect(res.json().providers).toHaveLength(1);
    expect(mockListProviders).toHaveBeenCalledWith("ws-1");
  });
});

describe("GET /api/connection-providers/:slug", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns provider by slug", async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: "prov-1", slug: "notion", name: "Notion" });

    const res = await app.inject({ method: "GET", url: "/api/connection-providers/notion" });

    expect(res.statusCode).toBe(200);
    expect(res.json().provider.slug).toBe("notion");
    expect(mockGetProviderBySlug).toHaveBeenCalledWith("notion", "ws-1");
  });

  it("returns 404 when provider not found", async () => {
    mockGetProviderBySlug.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/connection-providers/nonexistent" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/connection-providers", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a provider", async () => {
    mockCreateProvider.mockResolvedValue({ id: "prov-1", slug: "custom", name: "Custom" });

    const res = await app.inject({
      method: "POST",
      url: "/api/connection-providers",
      payload: { slug: "custom", name: "Custom" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateProvider).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "custom", name: "Custom" }),
      "ws-1",
    );
  });

  it("rejects missing slug (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/connection-providers",
      payload: { name: "Custom" },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ── Connection routes ──────────────────────────────────────────────────────

describe("GET /api/connections", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists connections", async () => {
    mockListConnections.mockResolvedValue([{ id: "conn-1", name: "My Notion" }]);

    const res = await app.inject({ method: "GET", url: "/api/connections" });

    expect(res.statusCode).toBe(200);
    expect(res.json().connections).toHaveLength(1);
    expect(mockListConnections).toHaveBeenCalledWith("ws-1");
  });
});

describe("POST /api/connections", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a connection", async () => {
    mockCreateConnection.mockResolvedValue({ id: "conn-1", name: "My Notion" });

    const res = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { name: "My Notion", providerSlug: "notion" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateConnection).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My Notion", providerSlug: "notion" }),
      "ws-1",
    );
  });

  it("rejects missing name (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { providerSlug: "notion" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/connections/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns connection from own workspace", async () => {
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-1", name: "My Notion" });

    const res = await app.inject({ method: "GET", url: "/api/connections/conn-1" });

    expect(res.statusCode).toBe(200);
    expect(res.json().connection.id).toBe("conn-1");
  });

  it("returns 404 when connection not found", async () => {
    mockGetConnection.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/connections/nonexistent" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for connection from another workspace", async () => {
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/connections/conn-1" });

    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /api/connections/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates a connection", async () => {
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-1" });
    mockUpdateConnection.mockResolvedValue({ id: "conn-1", enabled: false });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/connections/conn-1",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateConnection).toHaveBeenCalledWith("conn-1", { enabled: false });
  });

  it("returns 404 when connection not found", async () => {
    mockGetConnection.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/connections/nonexistent",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for connection from another workspace", async () => {
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-other" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/connections/conn-1",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/connections/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a connection", async () => {
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-1" });
    mockDeleteConnection.mockResolvedValue(undefined);

    const res = await app.inject({ method: "DELETE", url: "/api/connections/conn-1" });

    expect(res.statusCode).toBe(204);
  });

  it("returns 404 when connection not found", async () => {
    mockGetConnection.mockResolvedValue(null);

    const res = await app.inject({ method: "DELETE", url: "/api/connections/nonexistent" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for connection from another workspace", async () => {
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-other" });

    const res = await app.inject({ method: "DELETE", url: "/api/connections/conn-1" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/connections/:id/test", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns updated connection after test", async () => {
    mockTestConnection.mockResolvedValue({ id: "conn-1", status: "connected" });

    const res = await app.inject({ method: "POST", url: "/api/connections/conn-1/test" });

    expect(res.statusCode).toBe(200);
    expect(res.json().connection.status).toBe("connected");
    expect(mockTestConnection).toHaveBeenCalledWith("conn-1");
  });

  it("returns 404 when connection not found", async () => {
    mockTestConnection.mockRejectedValue(new Error("Connection not found"));

    const res = await app.inject({ method: "POST", url: "/api/connections/nonexistent/test" });

    expect(res.statusCode).toBe(404);
  });
});

// ── Assignment routes ──────────────────────────────────────────────────────

describe("GET /api/connections/:id/assignments", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists assignments for a connection", async () => {
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-1" });
    mockListAssignments.mockResolvedValue([{ id: "asgn-1", connectionId: "conn-1" }]);

    const res = await app.inject({ method: "GET", url: "/api/connections/conn-1/assignments" });

    expect(res.statusCode).toBe(200);
    expect(res.json().assignments).toHaveLength(1);
    expect(mockListAssignments).toHaveBeenCalledWith("conn-1");
  });

  it("returns 404 when connection not found", async () => {
    mockGetConnection.mockResolvedValue(null);

    const res = await app.inject({
      method: "GET",
      url: "/api/connections/nonexistent/assignments",
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a connection in another workspace (no assignment read)", async () => {
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/connections/conn-1/assignments" });

    expect(res.statusCode).toBe(404);
    expect(mockListAssignments).not.toHaveBeenCalled();
  });
});

describe("POST /api/connections/:id/assignments", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates an assignment", async () => {
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-1" });
    mockCreateAssignment.mockResolvedValue({
      id: "asgn-1",
      connectionId: "conn-1",
      repoId: "repo-1",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/connections/conn-1/assignments",
      payload: { repoId: "repo-1", permission: "read" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateAssignment).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({ repoId: "repo-1", permission: "read" }),
    );
  });

  it("returns 404 when connection not found", async () => {
    mockGetConnection.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/connections/nonexistent/assignments",
      payload: { repoId: "repo-1" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a connection in another workspace (no assignment created)", async () => {
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-other" });

    const res = await app.inject({
      method: "POST",
      url: "/api/connections/conn-1/assignments",
      payload: { repoId: "repo-1", permission: "read" },
    });

    expect(res.statusCode).toBe(404);
    expect(mockCreateAssignment).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer", async () => {
    const viewerApp = await buildRouteTestApp(connectionRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "viewer" },
    });

    const res = await viewerApp.inject({
      method: "POST",
      url: "/api/connections/conn-1/assignments",
      payload: { repoId: "repo-1", permission: "read" },
    });

    expect(res.statusCode).toBe(403);
    expect(mockCreateAssignment).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/connection-assignments/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetAssignment.mockResolvedValue({ id: "asgn-1", connectionId: "conn-1" });
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-1" });
    app = await buildTestApp();
  });

  it("updates an assignment", async () => {
    mockUpdateAssignment.mockResolvedValue({ id: "asgn-1", permission: "write" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/connection-assignments/asgn-1",
      payload: { permission: "write" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateAssignment).toHaveBeenCalledWith("asgn-1", { permission: "write" });
  });

  it("returns 404 when the assignment does not exist (no update)", async () => {
    mockGetAssignment.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/connection-assignments/nope",
      payload: { permission: "write" },
    });

    expect(res.statusCode).toBe(404);
    expect(mockUpdateAssignment).not.toHaveBeenCalled();
  });

  it("returns 404 when the owning connection is in another workspace (no update)", async () => {
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-other" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/connection-assignments/asgn-1",
      payload: { permission: "write" },
    });

    expect(res.statusCode).toBe(404);
    expect(mockUpdateAssignment).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer", async () => {
    const viewerApp = await buildRouteTestApp(connectionRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "viewer" },
    });

    const res = await viewerApp.inject({
      method: "PATCH",
      url: "/api/connection-assignments/asgn-1",
      payload: { permission: "write" },
    });

    expect(res.statusCode).toBe(403);
    expect(mockUpdateAssignment).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/connection-assignments/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetAssignment.mockResolvedValue({ id: "asgn-1", connectionId: "conn-1" });
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-1" });
    app = await buildTestApp();
  });

  it("deletes an assignment", async () => {
    mockDeleteAssignment.mockResolvedValue(undefined);

    const res = await app.inject({ method: "DELETE", url: "/api/connection-assignments/asgn-1" });

    expect(res.statusCode).toBe(204);
  });

  it("returns 404 when the assignment does not exist (no delete)", async () => {
    mockGetAssignment.mockResolvedValue(null);

    const res = await app.inject({ method: "DELETE", url: "/api/connection-assignments/nope" });

    expect(res.statusCode).toBe(404);
    expect(mockDeleteAssignment).not.toHaveBeenCalled();
  });

  it("returns 404 when the owning connection is in another workspace (no delete)", async () => {
    mockGetConnection.mockResolvedValue({ id: "conn-1", workspaceId: "ws-other" });

    const res = await app.inject({ method: "DELETE", url: "/api/connection-assignments/asgn-1" });

    expect(res.statusCode).toBe(404);
    expect(mockDeleteAssignment).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer", async () => {
    const viewerApp = await buildRouteTestApp(connectionRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "viewer" },
    });

    const res = await viewerApp.inject({
      method: "DELETE",
      url: "/api/connection-assignments/asgn-1",
    });

    expect(res.statusCode).toBe(403);
    expect(mockDeleteAssignment).not.toHaveBeenCalled();
  });
});

// ── Repo-scoped route ──────────────────────────────────────────────────────

describe("GET /api/repos/:id/connections", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns connections for a repo", async () => {
    mockGetRepo.mockResolvedValue({ id: "repo-1", repoUrl: "https://github.com/org/repo" });
    mockGetConnectionsForTask.mockResolvedValue([
      { connectionId: "conn-1" },
      { connectionId: "conn-2" },
    ]);
    mockGetConnection
      .mockResolvedValueOnce({ id: "conn-1", name: "Notion" })
      .mockResolvedValueOnce({ id: "conn-2", name: "Postgres" });

    const res = await app.inject({ method: "GET", url: "/api/repos/repo-1/connections" });

    expect(res.statusCode).toBe(200);
    expect(res.json().connections).toHaveLength(2);
    expect(mockGetConnectionsForTask).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      "",
      "ws-1",
    );
  });

  it("returns 404 for nonexistent repo", async () => {
    mockGetRepo.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/repos/nonexistent/connections" });

    expect(res.statusCode).toBe(404);
  });
});
