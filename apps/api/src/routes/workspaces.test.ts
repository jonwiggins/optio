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

// The test user is also a deployment admin (global secrets, new workspaces and
// access groups are theirs); the gates themselves: deployment-admin-gates.test.ts.
vi.mock("../services/sign-in-config-service.js", () => ({ isDeploymentAdmin: async () => true }));

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
  WorkspaceSettingsError: class WorkspaceSettingsError extends Error {},
}));

const mockListDiscoverable = vi.fn();
const mockJoinDiscoverable = vi.fn();
vi.mock("../services/workspace-groups.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/workspace-groups.js")>()),
  listDiscoverableWorkspaces: (...args: unknown[]) => mockListDiscoverable(...args),
  joinDiscoverableWorkspace: (...args: unknown[]) => mockJoinDiscoverable(...args),
}));

import { workspaceRoutes } from "./workspaces.js";
import { WorkspaceGroupError } from "../services/workspace-groups.js";

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

describe("workspaces by group", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("POST /api/workspaces passes the access groups and their role on", async () => {
    mockCreateWorkspace.mockResolvedValue({ id: "ws-2", name: "Platform" });
    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: {
        name: "Platform",
        slug: "platform",
        accessGroups: ["Eng-Platform"],
        accessGroupsRole: "viewer",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      {
        name: "Platform",
        slug: "platform",
        accessGroups: ["Eng-Platform"],
        accessGroupsRole: "viewer",
      },
      "user-1",
    );
  });

  it("refuses admin as the role people join by group with", async () => {
    mockGetUserRole.mockResolvedValue("admin");
    const res = await app.inject({
      method: "PATCH",
      url: "/api/workspaces/ws-1",
      payload: { accessGroupsRole: "admin" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockUpdateWorkspace).not.toHaveBeenCalled();
  });

  it("PATCH sets the work-visibility mode (admins only)", async () => {
    mockGetUserRole.mockResolvedValue("admin");
    mockUpdateWorkspace.mockResolvedValue({ id: "ws-1", workVisibility: "teams" });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/workspaces/ws-1",
      payload: { workVisibility: "teams" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockUpdateWorkspace).toHaveBeenCalledWith("ws-1", { workVisibility: "teams" });

    mockGetUserRole.mockResolvedValue("member");
    const denied = await app.inject({
      method: "PATCH",
      url: "/api/workspaces/ws-1",
      payload: { workVisibility: "organization" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("GET /api/workspaces/discoverable lists what the caller's groups open", async () => {
    mockListDiscoverable.mockResolvedValue([
      { id: "ws-9", name: "Data", slug: "data", description: null, role: "member" },
    ]);
    const res = await app.inject({ method: "GET", url: "/api/workspaces/discoverable" });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspaces).toHaveLength(1);
    expect(mockListDiscoverable).toHaveBeenCalledWith("user-1");
    // A static route: never mistaken for GET /api/workspaces/:id.
    expect(mockGetWorkspace).not.toHaveBeenCalled();
  });

  it("POST /api/workspaces/:id/join joins, or 403s when the groups don't open it", async () => {
    mockJoinDiscoverable.mockResolvedValueOnce({ role: "viewer" });
    const ok = await app.inject({ method: "POST", url: "/api/workspaces/ws-9/join" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, role: "viewer" });
    expect(mockJoinDiscoverable).toHaveBeenCalledWith("user-1", "ws-9");

    mockJoinDiscoverable.mockRejectedValueOnce(
      new WorkspaceGroupError("Your groups don't give access to this workspace", 403),
    );
    const denied = await app.inject({ method: "POST", url: "/api/workspaces/ws-8/join" });
    expect(denied.statusCode).toBe(403);

    mockJoinDiscoverable.mockRejectedValueOnce(
      new WorkspaceGroupError("You're already a member of this workspace", 409),
    );
    const again = await app.inject({ method: "POST", url: "/api/workspaces/ws-9/join" });
    expect(again.statusCode).toBe(409);
  });

  it("join needs a signed-in user", async () => {
    const anon = await buildTestApp(false);
    const res = await anon.inject({ method: "POST", url: "/api/workspaces/ws-9/join" });
    expect(res.statusCode).toBe(401);
  });
});
