import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    groupBy: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../db/schema.js", () => ({
  agentPods: {
    id: "id",
    pool: "pool",
    poolKey: "poolKey",
    instanceIndex: "instanceIndex",
    workspaceId: "workspaceId",
    state: "state",
    activeCount: "activeCount",
    updatedAt: "updatedAt",
    podName: "podName",
    podId: "podId",
    lastUsedAt: "lastUsedAt",
    errorMessage: "errorMessage",
    managedBy: "managedBy",
    jobName: "jobName",
  },
  interactiveSessions: { id: "id", podId: "podId", state: "state" },
  sessionChatTurns: { id: "id", sessionId: "sessionId", state: "state" },
  workflowRuns: {
    id: "id",
    state: "state",
    podId: "podId",
  },
}));

// Picking a pod, the row's lifecycle, slots, and count repair are
// agent-pod-pool's (exercised against a real database in
// agent-pod-pool.int.test.ts). Here we check what the Job pool asks of it and
// what it builds around it. podHandle stays real: it's how the pool addresses
// a pod in the runtime.
const podPool = vi.hoisted(() => ({
  pickPod: vi.fn(),
  insertPod: vi.fn(),
  markPodReady: vi.fn(),
  markPodError: vi.fn(),
  getPod: vi.fn(),
  listPods: vi.fn(),
  deletePod: vi.fn(),
  acquireSlot: vi.fn(),
  releaseSlot: vi.fn(),
  idlePods: vi.fn(),
  reconcileActiveCounts: vi.fn(),
}));
vi.mock("./agent-pod-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-pod-pool.js")>();
  return { ...podPool, podHandle: actual.podHandle };
});

const mockRuntimeCreate = vi.fn();
const mockRuntimeExec = vi.fn();
const mockRuntimeStatus = vi.fn();
const mockRuntimeDestroy = vi.fn();
const mockRuntimeStartRun = vi.fn();

vi.mock("./container-service.js", () => ({
  getRuntime: () => ({
    create: mockRuntimeCreate,
    exec: mockRuntimeExec,
    status: mockRuntimeStatus,
    destroy: mockRuntimeDestroy,
    startRun: mockRuntimeStartRun,
  }),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  lt: vi.fn(),
  sql: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const workloadManager = vi.hoisted(() => ({ createJob: vi.fn(), deleteJob: vi.fn() }));

vi.mock("./k8s-workload-service.js", () => ({
  isStatefulSetEnabled: vi.fn(() => false),
  getWorkloadManager: () => workloadManager,
}));

vi.mock("./repo-pool-service.js", () => ({
  resolveImage: () => "optio-agent:latest",
}));

import { getOrCreateWorkflowPod, type WorkflowPod } from "./workflow-pool-service.js";
import { AGENT_OFFLINE_ENV } from "./agent-offline-env.js";

/** An `agent_pods` row in the standalone (Job) pool. */
function workflowPod(overrides: Partial<WorkflowPod> = {}): WorkflowPod {
  return {
    id: "pod-1",
    isolationKey: null,
    pool: "standalone",
    poolKey: "wf-1",
    instanceIndex: 0,
    workspaceId: null,
    repoBranch: null,
    podName: "optio-wf-wf1-0-abcd",
    podId: "k8s-id",
    state: "ready",
    activeCount: 0,
    lastUsedAt: null,
    keepWarmUntil: null,
    errorMessage: null,
    managedBy: "bare-pod",
    statefulSetName: null,
    jobName: null,
    cachePvcName: null,
    cachePvcState: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * pickPod finds nothing to share and scales up: it calls the Job pool's create
 * callback for `instanceIndex`, whose row is recorded as "pod-new" and then
 * marked ready.
 */
function provisionNewPod(instanceIndex = 0) {
  podPool.pickPod.mockImplementation((_pool, _key, pickOpts) => pickOpts.create(instanceIndex));
  podPool.insertPod.mockImplementation(async (values) =>
    workflowPod({ ...values, id: "pod-new", podName: null, podId: null, state: "provisioning" }),
  );
  podPool.markPodReady.mockImplementation(async (id, where) =>
    workflowPod({ ...where, id, state: "ready" }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(podPool)) fn.mockReset();
});

describe("getOrCreateWorkflowPod — offline baseline (OPTIO_AGENT_OFFLINE)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("adds the baseline to a workflow pod when on", async () => {
    vi.stubEnv("OPTIO_AGENT_OFFLINE", "true");
    provisionNewPod(0);
    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-wf-wf1-0-abcd" });

    await getOrCreateWorkflowPod("wf-1", { maxAgentsPerPod: 2, maxPodInstances: 1 });
    expect(mockRuntimeCreate.mock.calls[0][0].env).toEqual({
      ...AGENT_OFFLINE_ENV,
      OPTIO_WORKFLOW_ID: "wf-1",
      OPTIO_POD_INSTANCE_INDEX: "0",
    });
  });
});
