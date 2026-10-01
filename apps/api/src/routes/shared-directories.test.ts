import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockListSharedDirectories = vi.fn();
const mockGetSharedDirectory = vi.fn();
const mockCreateSharedDirectory = vi.fn();
const mockUpdateSharedDirectory = vi.fn();
const mockDeleteSharedDirectory = vi.fn();
const mockClearSharedDirectory = vi.fn();
const mockGetSharedDirectoryUsage = vi.fn();
const mockValidateSharedDirectoryInput = vi.fn();

vi.mock("../services/shared-directory-service.js", () => ({
  listSharedDirectories: (...args: unknown[]) => mockListSharedDirectories(...args),
  getSharedDirectory: (...args: unknown[]) => mockGetSharedDirectory(...args),
  createSharedDirectory: (...args: unknown[]) => mockCreateSharedDirectory(...args),
  updateSharedDirectory: (...args: unknown[]) => mockUpdateSharedDirectory(...args),
  deleteSharedDirectory: (...args: unknown[]) => mockDeleteSharedDirectory(...args),
  clearSharedDirectory: (...args: unknown[]) => mockClearSharedDirectory(...args),
  getSharedDirectoryUsage: (...args: unknown[]) => mockGetSharedDirectoryUsage(...args),
  validateSharedDirectoryInput: (...args: unknown[]) => mockValidateSharedDirectoryInput(...args),
}));

const mockGetRepo = vi.fn();
vi.mock("../services/repo-service.js", () => ({
  getRepo: (...args: unknown[]) => mockGetRepo(...args),
}));

const mockListRepoPodsForRepo = vi.fn();
const mockDeleteNetworkPolicy = vi.fn();
const mockDeleteEnvoyConfigMap = vi.fn();
vi.mock("../services/repo-pool-service.js", () => ({
  listRepoPodsForRepo: (...args: unknown[]) => mockListRepoPodsForRepo(...args),
  deleteNetworkPolicy: (...args: unknown[]) => mockDeleteNetworkPolicy(...args),
  deleteEnvoyConfigMap: (...args: unknown[]) => mockDeleteEnvoyConfigMap(...args),
}));

const mockDestroy = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/container-service.js", () => ({
  getRuntime: vi.fn().mockReturnValue({
    destroy: (...args: unknown[]) => mockDestroy(...args),
  }),
}));

// A recycled pod's row is removed through agent-pod-pool.
const mockDeletePod = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/agent-pod-pool.js", () => ({
  deletePod: (...args: unknown[]) => mockDeletePod(...args),
}));

vi.mock("../db/client.js", () => ({
  db: {
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock("../db/schema.js", () => ({
  agentPods: { id: "agent_pods.id" },
}));

import { sharedDirectoryRoutes } from "./shared-directories.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(sharedDirectoryRoutes);
}

const mockRepoData = {
  id: "repo-1",
  repoUrl: "https://github.com/org/repo",
  fullName: "org/repo",
  workspaceId: "ws-1",
};

const mockDirData = {
  id: "dir-1",
  repoId: "repo-1",
  name: "npm-cache",
  mountLocation: "home",
  mountSubPath: ".npm",
  sizeGi: 10,
  scope: "per-pod",
};

describe("GET /api/repos/:id/shared-directories", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists shared directories for a repo", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockListSharedDirectories.mockResolvedValue([mockDirData]);

    const res = await app.inject({
      method: "GET",
      url: "/api/repos/repo-1/shared-directories",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().directories).toHaveLength(1);
    expect(mockListSharedDirectories).toHaveBeenCalledWith("repo-1");
  });

  it("returns 404 when repo not found", async () => {
    mockGetRepo.mockResolvedValue(null);

    const res = await app.inject({
      method: "GET",
      url: "/api/repos/nonexistent/shared-directories",
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when workspace mismatch", async () => {
    mockGetRepo.mockResolvedValue({ ...mockRepoData, workspaceId: "other-ws" });

    const res = await app.inject({
      method: "GET",
      url: "/api/repos/repo-1/shared-directories",
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/repos/:id/shared-directories", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a shared directory", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockValidateSharedDirectoryInput.mockReturnValue(null);
    mockCreateSharedDirectory.mockResolvedValue(mockDirData);

    const res = await app.inject({
      method: "POST",
      url: "/api/repos/repo-1/shared-directories",
      payload: {
        name: "npm-cache",
        mountLocation: "home",
        mountSubPath: ".npm",
        sizeGi: 10,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().directory.name).toBe("npm-cache");
  });

  it("returns 400 for validation error", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockValidateSharedDirectoryInput.mockReturnValue("Invalid name");

    const res = await app.inject({
      method: "POST",
      url: "/api/repos/repo-1/shared-directories",
      payload: {
        name: "npm-cache",
        mountLocation: "home",
        mountSubPath: ".npm",
        sizeGi: 10,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid name");
  });

  it("returns 409 for duplicate name", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockValidateSharedDirectoryInput.mockReturnValue(null);
    mockCreateSharedDirectory.mockRejectedValue(
      Object.assign(new Error("unique constraint"), { code: "23505" }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/repos/repo-1/shared-directories",
      payload: {
        name: "npm-cache",
        mountLocation: "home",
        mountSubPath: ".npm",
        sizeGi: 10,
      },
    });

    expect(res.statusCode).toBe(409);
  });
});

describe("PATCH /api/repos/:id/shared-directories/:dirId", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates a shared directory", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockGetSharedDirectory.mockResolvedValue(mockDirData);
    mockUpdateSharedDirectory.mockResolvedValue({
      ...mockDirData,
      description: "Updated",
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1/shared-directories/dir-1",
      payload: { description: "Updated" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().directory.description).toBe("Updated");
  });

  it("returns 404 when directory not found", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockGetSharedDirectory.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1/shared-directories/nonexistent",
      payload: { description: "Updated" },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/repos/:id/shared-directories/:dirId", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a shared directory", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockGetSharedDirectory.mockResolvedValue(mockDirData);
    mockDeleteSharedDirectory.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/repos/repo-1/shared-directories/dir-1",
    });

    expect(res.statusCode).toBe(204);
  });
});

describe("POST /api/repos/:id/shared-directories/:dirId/clear", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("clears a shared directory", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockGetSharedDirectory.mockResolvedValue(mockDirData);
    mockClearSharedDirectory.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/repos/repo-1/shared-directories/dir-1/clear",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

describe("POST /api/repos/:id/shared-directories/:dirId/usage", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns usage info", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockGetSharedDirectory.mockResolvedValue(mockDirData);
    mockGetSharedDirectoryUsage.mockResolvedValue("1.5G");

    const res = await app.inject({
      method: "POST",
      url: "/api/repos/repo-1/shared-directories/dir-1/usage",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().usage).toBe("1.5G");
  });
});

describe("POST /api/repos/:id/pods/recycle", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("recycles idle pods", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockDeleteNetworkPolicy.mockResolvedValue(undefined);
    mockDeleteEnvoyConfigMap.mockResolvedValue(undefined);
    mockListRepoPodsForRepo.mockResolvedValue([
      { id: "pod-1", podName: "test-pod", podId: "pod-1", state: "ready", activeCount: 0 },
      // Busy pods are left alone
      { id: "pod-2", podName: "busy-pod", podId: "pod-2", state: "ready", activeCount: 1 },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/repos/repo-1/pods/recycle",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, recycled: 1 });
    expect(mockListRepoPodsForRepo).toHaveBeenCalledWith("https://github.com/org/repo");
    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(mockDestroy).toHaveBeenCalledWith({ id: "pod-1", name: "test-pod" });
    expect(mockDeletePod).toHaveBeenCalledTimes(1);
    expect(mockDeletePod).toHaveBeenCalledWith("pod-1");
  });
});
