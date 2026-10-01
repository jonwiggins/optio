import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListNode = vi.fn();
const mockListNamespacedPod = vi.fn();
const mockListNamespacedService = vi.fn();
const mockListNamespacedEvent = vi.fn();
const mockReadNamespacedPod = vi.fn();
const mockListClusterCustomObject = vi.fn();
const mockListNamespacedCustomObject = vi.fn();

vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: vi.fn().mockImplementation(() => ({
    loadFromDefault: vi.fn(),
    makeApiClient: vi.fn().mockReturnValue({
      listNode: mockListNode,
      listNamespacedPod: mockListNamespacedPod,
      listNamespacedService: mockListNamespacedService,
      listNamespacedEvent: mockListNamespacedEvent,
      readNamespacedPod: mockReadNamespacedPod,
      listClusterCustomObject: mockListClusterCustomObject,
      listNamespacedCustomObject: mockListNamespacedCustomObject,
    }),
  })),
  CoreV1Api: vi.fn(),
  CustomObjectsApi: vi.fn(),
}));

// Use a flexible chainable mock for all db operations
const createChainable = (resolvedValue: any = []) => {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.groupBy = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.then = vi.fn().mockImplementation((resolve: any) => resolve(resolvedValue));
  // Make it thennable (Promise-like)
  Object.defineProperty(chain, Symbol.toStringTag, { value: "Promise" });
  return chain;
};

const mockDbSelectChain = createChainable([]);
const mockDbDeleteChain = createChainable();
const mockDbInsertChain = createChainable();

vi.mock("../db/client.js", () => ({
  db: {
    select: () => mockDbSelectChain,
    delete: () => mockDbDeleteChain,
    insert: () => mockDbInsertChain,
  },
}));

vi.mock("../db/schema.js", () => ({
  agentPods: {
    id: "id",
    pool: "pool",
    poolKey: "poolKey",
    workspaceId: "workspaceId",
    activeCount: "activeCount",
  },
  tasks: {
    id: "id",
    title: "title",
    state: "state",
    agentType: "agentType",
    createdAt: "createdAt",
    repoUrl: "repoUrl",
    lastPodId: "lastPodId",
    workspaceId: "workspaceId",
  },
  podHealthEvents: { createdAt: "createdAt" },
  repos: {
    repoUrl: "repoUrl",
    maxConcurrentTasks: "maxConcurrentTasks",
    maxPodInstances: "maxPodInstances",
    maxAgentsPerPod: "maxAgentsPerPod",
  },
}));

vi.mock("../services/container-service.js", () => ({
  getRuntime: () => ({
    destroy: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Pod rows live in agent_pods behind agent-pod-pool; repo-pool-service's
// views (real) turn them back into the repo-pod shape the cluster API serves.
const mockGetPod = vi.fn();
const mockListPods = vi.fn();
const mockDeletePod = vi.fn();

vi.mock("../services/agent-pod-pool.js", () => ({
  getPod: (...args: unknown[]) => mockGetPod(...args),
  listPods: (...args: unknown[]) => mockListPods(...args),
  deletePod: (...args: unknown[]) => mockDeletePod(...args),
}));

import { clusterRoutes } from "./cluster.js";

/** An `agent_pods` row. */
function agentPod(overrides: Record<string, unknown> = {}) {
  return {
    id: "pod-1",
    pool: "repo",
    poolKey: "https://github.com/org/repo",
    instanceIndex: 0,
    workspaceId: null,
    repoBranch: "main",
    podName: "optio-repo-1",
    podId: "k8s-pod-1",
    state: "ready",
    activeCount: 1,
    lastUsedAt: null,
    keepWarmUntil: null,
    errorMessage: null,
    managedBy: "bare-pod",
    statefulSetName: null,
    jobName: null,
    cachePvcName: null,
    cachePvcState: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(clusterRoutes, {
    user: { id: "u1", workspaceId: null, workspaceRole: "admin" },
  });
}

beforeEach(() => {
  mockGetPod.mockReset().mockResolvedValue(null);
  mockListPods.mockReset().mockResolvedValue([]);
  mockDeletePod.mockReset().mockResolvedValue(undefined);
});

describe("GET /api/cluster/overview", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns 500 when namespace-scoped K8s API fails", async () => {
    mockListNode.mockResolvedValue({ items: [] });
    mockListNamespacedPod.mockRejectedValue(new Error("K8s API unavailable"));
    mockListNamespacedService.mockRejectedValue(new Error("K8s API unavailable"));
    mockListNamespacedEvent.mockRejectedValue(new Error("K8s API unavailable"));

    const res = await app.inject({ method: "GET", url: "/api/cluster/overview" });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("K8s API unavailable");
  });

  it("returns 200 with empty nodes when listNode fails (no ClusterRole)", async () => {
    mockListNode.mockRejectedValue(new Error("Forbidden: nodes is forbidden"));
    mockListNamespacedPod.mockResolvedValue({ items: [] });
    mockListNamespacedService.mockResolvedValue({ items: [] });
    mockListNamespacedEvent.mockResolvedValue({ items: [] });
    mockListClusterCustomObject.mockRejectedValue(new Error("Forbidden"));
    mockListNamespacedCustomObject.mockResolvedValue({ items: [] });

    const res = await app.inject({ method: "GET", url: "/api/cluster/overview" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toEqual([]);
    expect(body.summary.totalNodes).toBe(0);
    expect(body.summary.readyNodes).toBe(0);
    expect(body.pods).toBeDefined();
  });
});

describe("GET /api/cluster/pods", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns pods from database", async () => {
    mockListPods.mockResolvedValue([agentPod()]);
    // For the recentTasks sub-query
    mockDbSelectChain.limit.mockReturnValue({
      then: vi.fn().mockImplementation((resolve: any) => resolve([])),
      [Symbol.toStringTag]: "Promise",
    });

    const res = await app.inject({ method: "GET", url: "/api/cluster/pods" });

    expect(res.statusCode).toBe(200);
    expect(mockListPods).toHaveBeenCalledWith("repo");
    // The response keeps the repo-pod shape clients decode
    const pods = res.json().pods;
    expect(pods).toHaveLength(1);
    expect(pods[0]).toMatchObject({
      id: "pod-1",
      repoUrl: "https://github.com/org/repo",
      repoBranch: "main",
      podName: "optio-repo-1",
      state: "ready",
      activeTaskCount: 1,
      recentTasks: [],
    });
  });
});

describe("GET /api/cluster/pods/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns 404 for nonexistent pod", async () => {
    mockGetPod.mockResolvedValueOnce(null);

    const res = await app.inject({ method: "GET", url: "/api/cluster/pods/nonexistent" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Pod not found");
    expect(mockGetPod).toHaveBeenCalledWith("nonexistent");
  });
});

describe("GET /api/cluster/health-events", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns health events", async () => {
    mockDbSelectChain.limit.mockReturnValueOnce({
      then: vi
        .fn()
        .mockImplementation((resolve: any) =>
          resolve([{ id: "event-1", eventType: "crashed", message: "OOM killed" }]),
        ),
      [Symbol.toStringTag]: "Promise",
    });

    const res = await app.inject({ method: "GET", url: "/api/cluster/health-events" });

    expect(res.statusCode).toBe(200);
    expect(res.json().events).toBeDefined();
  });
});

describe("POST /api/cluster/pods/:id/restart", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns 404 for nonexistent pod", async () => {
    mockGetPod.mockResolvedValueOnce(null);

    const res = await app.inject({ method: "POST", url: "/api/cluster/pods/nonexistent/restart" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Pod not found");
    expect(mockGetPod).toHaveBeenCalledWith("nonexistent");
    expect(mockDeletePod).not.toHaveBeenCalled();
  });
});
