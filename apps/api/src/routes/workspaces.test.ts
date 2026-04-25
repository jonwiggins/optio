import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockListUserWorkspaces = vi.fn();
const mockGetWorkspace = vi.fn();
const mockCreateWorkspace = vi.fn();
const mockUpdateWorkspace = vi.fn();
const mockDeleteWorkspace = vi.fn();
const mockSwitchWorkspace = vi.fn();
const mockGetUserRole = vi.fn();
const mockListMembers = vi.fn();
const mockAddMember = vi.fn();
const mockUpdateMemberRole = vi.fn();
const mockRemoveMember = vi.fn();

vi.mock("../services/workspace-service.js", () => ({
  listUserWorkspaces: (...args: unknown[]) => mockListUserWorkspaces(...args),
  getWorkspace: (...args: unknown[]) => mockGetWorkspace(...args),
  createWorkspace: (...args: unknown[]) => mockCreateWorkspace(...args),
  updateWorkspace: (...args: unknown[]) => mockUpdateWorkspace(...args),
  deleteWorkspace: (...args: unknown[]) => mockDeleteWorkspace(...args),
  switchWorkspace: (...args: unknown[]) => mockSwitchWorkspace(...args),
  getUserRole: (...args: unknown[]) => mockGetUserRole(...args),
  listMembers: (...args: unknown[]) => mockListMembers(...args),
  addMember: (...args: unknown[]) => mockAddMember(...args),
  updateMemberRole: (...args: unknown[]) => mockUpdateMemberRole(...args),
  removeMember: (...args: unknown[]) => mockRemoveMember(...args),
}));

import { workspaceRoutes } from "./workspaces.js";

// ─── Helpers ───

async function buildTestApp(withUser = true): Promise<FastifyInstance> {
  return buildRouteTestApp(workspaceRoutes, {
    user: withUser ? { id: "user-1", workspaceId: "ws-1", workspaceRole: "admin" } : null,
  });
}

describe("GET /api/workspaces", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists user workspaces", async () => {
    mockListUserWorkspaces.mockResolvedValue([{ id: "ws-1", name: "Default" }]);

    const res = await app.inject({ method: "GET", url: "/api/workspaces" });

    expect(res.statusCode).toBe(200);
    expect(res.json().workspaces).toHaveLength(1);
    expect(mockListUserWorkspaces).toHaveBeenCalledWith("user-1");
  });

  it("returns 401 without auth", async () => {
    const unauthApp = await buildTestApp(false);

    const res = await unauthApp.inject({ method: "GET", url: "/api/workspaces" });

    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/workspaces/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns workspace with role", async () => {
    mockGetWorkspace.mockResolvedValue({ id: "ws-1", name: "Default" });
    mockGetUserRole.mockResolvedValue("admin");

    const res = await app.inject({ method: "GET", url: "/api/workspaces/ws-1" });

    expect(res.statusCode).toBe(200);
    expect(res.json().workspace.name).toBe("Default");
    expect(res.json().role).toBe("admin");
  });

  it("returns 404 for nonexistent workspace", async () => {
    mockGetWorkspace.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/workspaces/nonexistent" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for non-member", async () => {
    mockGetWorkspace.mockResolvedValue({ id: "ws-2" });
    mockGetUserRole.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/workspaces/ws-2" });

    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/workspaces", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a workspace", async () => {
    mockCreateWorkspace.mockResolvedValue({ id: "ws-new", name: "New WS", slug: "new-ws" });

    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "New WS", slug: "new-ws" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "New WS", slug: "new-ws" }),
      "user-1",
    );
  });

  it("rejects invalid slug (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "New WS", slug: "Invalid Slug!" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/workspaces/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates workspace when admin", async () => {
    mockGetUserRole.mockResolvedValue("admin");
    mockUpdateWorkspace.mockResolvedValue({ id: "ws-1", name: "Updated" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/workspaces/ws-1",
      payload: { name: "Updated" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("returns 403 for non-admin", async () => {
    mockGetUserRole.mockResolvedValue("member");

    const res = await app.inject({
      method: "PATCH",
      url: "/api/workspaces/ws-1",
      payload: { name: "Updated" },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/workspaces/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes workspace when admin", async () => {
    mockGetUserRole.mockResolvedValue("admin");
    mockDeleteWorkspace.mockResolvedValue(undefined);

    const res = await app.inject({ method: "DELETE", url: "/api/workspaces/ws-1" });

    expect(res.statusCode).toBe(204);
  });

  it("returns 403 for non-admin", async () => {
    mockGetUserRole.mockResolvedValue("viewer");

    const res = await app.inject({ method: "DELETE", url: "/api/workspaces/ws-1" });

    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/workspaces/:id/switch", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("switches active workspace", async () => {
    mockSwitchWorkspace.mockResolvedValue(undefined);

    const res = await app.inject({ method: "POST", url: "/api/workspaces/ws-2/switch" });

    expect(res.statusCode).toBe(200);
    expect(mockSwitchWorkspace).toHaveBeenCalledWith("user-1", "ws-2");
  });
});

describe("workspace members", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("GET /api/workspaces/:id/members lists members", async () => {
    mockGetUserRole.mockResolvedValue("member");
    mockListMembers.mockResolvedValue([{ userId: "user-1", role: "admin" }]);

    const res = await app.inject({ method: "GET", url: "/api/workspaces/ws-1/members" });

    expect(res.statusCode).toBe(200);
    expect(res.json().members).toHaveLength(1);
  });

  it("POST /api/workspaces/:id/members adds member (admin only)", async () => {
    mockGetUserRole.mockResolvedValue("admin");
    mockAddMember.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces/ws-1/members",
      payload: { userId: "00000000-0000-0000-0000-000000000002", role: "member" },
    });

    expect(res.statusCode).toBe(201);
  });

  it("POST /api/workspaces/:id/members returns 403 for non-admin", async () => {
    mockGetUserRole.mockResolvedValue("member");

    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces/ws-1/members",
      payload: { userId: "00000000-0000-0000-0000-000000000002" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("POST /api/workspaces/:id/members returns 404 for unknown user", async () => {
    mockGetUserRole.mockResolvedValue("admin");
    mockAddMember.mockRejectedValue(new Error("User not found"));

    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces/ws-1/members",
      payload: { userId: "00000000-0000-0000-0000-000000000099" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("POST /api/workspaces/:id/members returns 409 when user is already a member", async () => {
    mockGetUserRole.mockResolvedValue("admin");
    mockAddMember.mockRejectedValue(new Error("User is already a member of this workspace"));

    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces/ws-1/members",
      payload: { userId: "00000000-0000-0000-0000-000000000002", role: "member" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already a member/i);
  });
});
