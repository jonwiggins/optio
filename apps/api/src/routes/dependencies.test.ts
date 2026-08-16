import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockGetDependencies = vi.fn();
const mockGetDependents = vi.fn();
const mockAddDependencies = vi.fn();
const mockRemoveDependency = vi.fn();

vi.mock("../services/dependency-service.js", () => ({
  getDependencies: (...args: unknown[]) => mockGetDependencies(...args),
  getDependents: (...args: unknown[]) => mockGetDependents(...args),
  addDependencies: (...args: unknown[]) => mockAddDependencies(...args),
  removeDependency: (...args: unknown[]) => mockRemoveDependency(...args),
}));

const mockGetTask = vi.fn();
vi.mock("../services/task-service.js", () => ({
  getTask: (...args: unknown[]) => mockGetTask(...args),
}));

import { dependencyRoutes } from "./dependencies.js";

// ─── Helpers ───

async function buildTestApp(user?: { id: string; workspaceId: string }): Promise<FastifyInstance> {
  // Default user has no workspace so workspace-scope checks stay inert, but
  // carries a role so the requireRole("member") preHandlers pass.
  return buildRouteTestApp(dependencyRoutes, {
    user: user
      ? { id: user.id, workspaceId: user.workspaceId, workspaceRole: "admin" }
      : { id: "user-1", workspaceId: null, workspaceRole: "member" },
  });
}

const mockDependency = {
  id: "task-dep-1",
  title: "Dependency task",
  state: "completed" as const,
  dependencyId: "edge-1",
};

describe("GET /api/tasks/:id/dependencies", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists dependencies", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1" });
    mockGetDependencies.mockResolvedValue([mockDependency]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/dependencies" });

    expect(res.statusCode).toBe(200);
    expect(res.json().dependencies).toHaveLength(1);
  });

  it("returns 404 for nonexistent task", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/tasks/nonexistent/dependencies" });

    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/tasks/:id/dependents", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists dependents", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1" });
    mockGetDependents.mockResolvedValue([mockDependency]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/dependents" });

    expect(res.statusCode).toBe(200);
    expect(res.json().dependents).toHaveLength(1);
  });
});

describe("POST /api/tasks/:id/dependencies", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("adds dependencies", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1" });
    mockAddDependencies.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/dependencies",
      payload: { dependsOnIds: ["00000000-0000-0000-0000-000000000001"] },
    });

    expect(res.statusCode).toBe(201);
    expect(mockAddDependencies).toHaveBeenCalledWith("task-1", [
      "00000000-0000-0000-0000-000000000001",
    ]);
  });

  it("returns 400 when addDependencies throws", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1" });
    mockAddDependencies.mockRejectedValue(new Error("Circular dependency"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/dependencies",
      payload: { dependsOnIds: ["00000000-0000-0000-0000-000000000001"] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Circular dependency");
  });

  it("rejects empty dependsOnIds (400 from Zod body schema)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/dependencies",
      payload: { dependsOnIds: [] },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/tasks/:id/dependencies/:depTaskId", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("removes a dependency", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1" });
    mockRemoveDependency.mockResolvedValue(true);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/task-1/dependencies/task-2",
    });

    expect(res.statusCode).toBe(204);
  });

  it("returns 404 for nonexistent dependency", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1" });
    mockRemoveDependency.mockResolvedValue(false);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/task-1/dependencies/nonexistent",
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("workspace scoping", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp({ id: "user-1", workspaceId: "ws-1" });
  });

  it("returns 404 for task in different workspace (GET dependencies)", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/dependencies" });

    expect(res.statusCode).toBe(404);
    expect(mockGetDependencies).not.toHaveBeenCalled();
  });

  it("returns 404 for task in different workspace (GET dependents)", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/dependents" });

    expect(res.statusCode).toBe(404);
    expect(mockGetDependents).not.toHaveBeenCalled();
  });

  it("returns 404 for task in different workspace (POST dependencies)", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-other" });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/dependencies",
      payload: { dependsOnIds: ["00000000-0000-0000-0000-000000000001"] },
    });

    expect(res.statusCode).toBe(404);
    expect(mockAddDependencies).not.toHaveBeenCalled();
  });

  it("returns 404 for task in different workspace (DELETE dependency)", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-other" });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/task-1/dependencies/task-2",
    });

    expect(res.statusCode).toBe(404);
    expect(mockRemoveDependency).not.toHaveBeenCalled();
  });

  it("allows access for task in same workspace", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockGetDependencies.mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/dependencies" });

    expect(res.statusCode).toBe(200);
  });
});
