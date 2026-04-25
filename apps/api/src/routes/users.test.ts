import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockGetUserRole = vi.fn();

vi.mock("../services/workspace-service.js", () => ({
  getUserRole: (...args: unknown[]) => mockGetUserRole(...args),
}));

const mockDbSelect = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => mockDbSelect(...args),
      }),
    }),
  },
}));

vi.mock("../db/schema.js", () => ({
  users: {
    id: "users.id",
    email: "users.email",
    displayName: "users.display_name",
    avatarUrl: "users.avatar_url",
  },
}));

import { userRoutes } from "./users.js";

// ─── Helpers ───

async function buildTestApp(
  user: {
    id: string;
    workspaceId: string | null;
    workspaceRole: "admin" | "member" | "viewer";
  } | null = {
    id: "user-1",
    workspaceId: "ws-1",
    workspaceRole: "admin",
  },
): Promise<FastifyInstance> {
  return buildRouteTestApp(userRoutes, { user });
}

describe("GET /api/users/lookup", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns 200 with the user when admin and email matches", async () => {
    mockGetUserRole.mockResolvedValue("admin");
    mockDbSelect.mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000099",
        email: "found@example.com",
        displayName: "Found User",
        avatarUrl: null,
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/api/users/lookup?email=found@example.com",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({
      id: "00000000-0000-0000-0000-000000000099",
      email: "found@example.com",
      displayName: "Found User",
      avatarUrl: null,
    });
    expect(mockGetUserRole).toHaveBeenCalledWith("ws-1", "user-1");
  });

  it("returns 401 when unauthenticated", async () => {
    const unauthApp = await buildTestApp(null);

    const res = await unauthApp.inject({
      method: "GET",
      url: "/api/users/lookup?email=anyone@example.com",
    });

    expect(res.statusCode).toBe(401);
    expect(mockGetUserRole).not.toHaveBeenCalled();
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("returns 400 when the session has no workspaceId", async () => {
    const noWsApp = await buildTestApp({
      id: "user-1",
      workspaceId: null,
      workspaceRole: "admin",
    });

    const res = await noWsApp.inject({
      method: "GET",
      url: "/api/users/lookup?email=anyone@example.com",
    });

    expect(res.statusCode).toBe(400);
    expect(mockGetUserRole).not.toHaveBeenCalled();
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is a member (not admin)", async () => {
    mockGetUserRole.mockResolvedValue("member");

    const res = await app.inject({
      method: "GET",
      url: "/api/users/lookup?email=anyone@example.com",
    });

    expect(res.statusCode).toBe(403);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is a viewer (not admin)", async () => {
    mockGetUserRole.mockResolvedValue("viewer");

    const res = await app.inject({
      method: "GET",
      url: "/api/users/lookup?email=anyone@example.com",
    });

    expect(res.statusCode).toBe(403);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is not a member of the workspace at all", async () => {
    mockGetUserRole.mockResolvedValue(null);

    const res = await app.inject({
      method: "GET",
      url: "/api/users/lookup?email=anyone@example.com",
    });

    expect(res.statusCode).toBe(403);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("returns 404 when no user has the given email", async () => {
    mockGetUserRole.mockResolvedValue("admin");
    mockDbSelect.mockResolvedValue([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/users/lookup?email=missing@example.com",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it("returns 400 when email querystring is missing", async () => {
    mockGetUserRole.mockResolvedValue("admin");

    const res = await app.inject({ method: "GET", url: "/api/users/lookup" });

    expect(res.statusCode).toBe(400);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("returns 400 when email querystring is malformed", async () => {
    mockGetUserRole.mockResolvedValue("admin");

    const res = await app.inject({
      method: "GET",
      url: "/api/users/lookup?email=not-an-email",
    });

    expect(res.statusCode).toBe(400);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});
