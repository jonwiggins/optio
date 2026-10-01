import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
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

vi.mock("./container-service.js", () => ({
  getRuntime: () => ({
    create: mockRuntimeCreate,
    exec: mockRuntimeExec,
    status: mockRuntimeStatus,
    destroy: mockRuntimeDestroy,
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

vi.mock("./k8s-workload-service.js", () => ({
  isStatefulSetEnabled: () => false,
  getWorkloadManager: vi.fn(),
}));

vi.mock("./repo-pool-service.js", () => ({
  resolveImage: () => "optio-agent:latest",
}));

import {
  getOrCreateWorkflowPod,
  execRunInPod,
  releaseRun,
  cleanupIdleWorkflowPods,
  listWorkflowPods,
  type WorkflowPod,
} from "./workflow-pool-service.js";

/** An `agent_pods` row in the standalone (Job) pool. */
function workflowPod(overrides: Partial<WorkflowPod> = {}): WorkflowPod {
  return {
    id: "pod-1",
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

// ── releaseRun ──────────────────────────────────────────────────────

describe("releaseRun", () => {
  it("decrements the active run count by releasing the pod's slot", async () => {
    await releaseRun("pod-1");

    expect(podPool.releaseSlot).toHaveBeenCalledTimes(1);
    expect(podPool.releaseSlot).toHaveBeenCalledWith("pod-1");
  });
});

// ── cleanupIdleWorkflowPods ─────────────────────────────────────────

describe("cleanupIdleWorkflowPods", () => {
  it("returns 0 when no idle pods exist", async () => {
    podPool.idlePods.mockResolvedValueOnce([]);

    const cleaned = await cleanupIdleWorkflowPods();
    expect(cleaned).toBe(0);
    expect(podPool.idlePods).toHaveBeenCalledWith("standalone", expect.any(Date));
    expect(podPool.deletePod).not.toHaveBeenCalled();
  });

  it("destroys idle pods and removes their records", async () => {
    const idlePod = workflowPod({
      id: "pod-1",
      poolKey: "wf-1",
      instanceIndex: 0,
      podName: "optio-wf-wf1-0-abcd",
      podId: "k8s-pod-id-1",
      state: "ready",
      activeCount: 0,
    });

    podPool.idlePods.mockResolvedValueOnce([idlePod]);
    mockRuntimeDestroy.mockResolvedValueOnce(undefined);

    const cleaned = await cleanupIdleWorkflowPods();
    expect(cleaned).toBe(1);
    expect(mockRuntimeDestroy).toHaveBeenCalledWith({
      id: idlePod.podId,
      name: idlePod.podName,
    });
    expect(podPool.deletePod).toHaveBeenCalledWith("pod-1");
  });

  it("scales down LIFO — higher instance indices first", async () => {
    const pods = [
      workflowPod({ id: "pod-0", instanceIndex: 0, podName: "pod-a", podId: "id-a" }),
      workflowPod({ id: "pod-2", instanceIndex: 2, podName: "pod-c", podId: "id-c" }),
      workflowPod({ id: "pod-1", instanceIndex: 1, podName: "pod-b", podId: "id-b" }),
    ];

    podPool.idlePods.mockResolvedValueOnce(pods);
    mockRuntimeDestroy.mockResolvedValue(undefined);

    await cleanupIdleWorkflowPods();

    const destroyOrder = mockRuntimeDestroy.mock.calls.map((c) => c[0].name);
    expect(destroyOrder).toEqual(["pod-c", "pod-b", "pod-a"]);
    expect(podPool.deletePod.mock.calls.map((c) => c[0])).toEqual(["pod-2", "pod-1", "pod-0"]);
  });

  it("continues cleanup even if one pod fails to destroy", async () => {
    const pods = [
      workflowPod({ id: "pod-1", poolKey: "wf-1", podName: "pod-a", podId: "id-a" }),
      workflowPod({ id: "pod-2", poolKey: "wf-2", podName: "pod-b", podId: "id-b" }),
    ];

    podPool.idlePods.mockResolvedValueOnce(pods);

    mockRuntimeDestroy
      .mockRejectedValueOnce(new Error("Failed to destroy"))
      .mockResolvedValueOnce(undefined);

    const cleaned = await cleanupIdleWorkflowPods();
    // First pod fails, second succeeds
    expect(cleaned).toBe(1);
    // The pod that couldn't be destroyed keeps its record
    expect(podPool.deletePod).toHaveBeenCalledTimes(1);
    expect(podPool.deletePod).toHaveBeenCalledWith("pod-2");
  });

  it("skips destroy if pod has no podName", async () => {
    const pod = workflowPod({ id: "pod-1", podName: null, podId: null });

    podPool.idlePods.mockResolvedValueOnce([pod]);

    const cleaned = await cleanupIdleWorkflowPods();
    expect(cleaned).toBe(1);
    expect(mockRuntimeDestroy).not.toHaveBeenCalled();
    expect(podPool.deletePod).toHaveBeenCalledWith("pod-1");
  });
});

// ── listWorkflowPods ────────────────────────────────────────────────

describe("listWorkflowPods", () => {
  it("returns all pods in the standalone (Job) pool", async () => {
    const mockPods = [
      workflowPod({ id: "pod-1", instanceIndex: 0, podName: "p1", state: "ready" }),
      workflowPod({ id: "pod-2", instanceIndex: 1, podName: "p2", state: "provisioning" }),
    ];

    podPool.listPods.mockResolvedValueOnce(mockPods);

    const result = await listWorkflowPods();
    expect(result).toEqual(mockPods);
    expect(podPool.listPods).toHaveBeenCalledWith("standalone");
  });
});

// ── getOrCreateWorkflowPod ──────────────────────────────────────────
//
// Which pod a run lands on (retry affinity, least-loaded, removing gone /
// errored / stale rows, scaling out) is agent-pod-pool's pickPod — see
// agent-pod-pool.int.test.ts. The Job pool hands it the Job's pool and
// limits, and a create callback that provisions a Job pod.

describe("getOrCreateWorkflowPod", () => {
  it("returns an existing ready pod with capacity (least-loaded)", async () => {
    const existingPod = workflowPod({ id: "pod-1", state: "ready", activeCount: 0 });
    podPool.pickPod.mockResolvedValueOnce(existingPod);

    const pod = await getOrCreateWorkflowPod("wf-1", {
      preferredPodId: "pod-prev",
      maxAgentsPerPod: 2,
      maxPodInstances: 1,
    });
    expect(pod.id).toBe("pod-1");
    expect(pod.state).toBe("ready");
    expect(podPool.pickPod).toHaveBeenCalledWith("standalone", "wf-1", {
      preferredPodId: "pod-prev",
      maxAgentsPerPod: 2,
      maxPodInstances: 1,
      create: expect.any(Function),
    });
    expect(podPool.insertPod).not.toHaveBeenCalled();
    expect(mockRuntimeCreate).not.toHaveBeenCalled();
  });

  it("defaults to 2 agents per pod and a single pod instance", async () => {
    podPool.pickPod.mockResolvedValueOnce(workflowPod());

    await getOrCreateWorkflowPod("wf-1");

    expect(podPool.pickPod).toHaveBeenCalledWith(
      "standalone",
      "wf-1",
      expect.objectContaining({ maxAgentsPerPod: 2, maxPodInstances: 1 }),
    );
  });

  it("creates a new pod when none exists and under instance limit", async () => {
    provisionNewPod(1);
    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-wf-wf1-1-abcd" });

    const pod = await getOrCreateWorkflowPod("wf-1", {
      maxAgentsPerPod: 2,
      maxPodInstances: 2,
      workspaceId: "ws-1",
    });
    expect(pod.state).toBe("ready");
    expect(mockRuntimeCreate).toHaveBeenCalled();

    expect(podPool.insertPod).toHaveBeenCalledWith({
      pool: "standalone",
      poolKey: "wf-1",
      instanceIndex: 1,
      workspaceId: "ws-1",
    });
    const spec = mockRuntimeCreate.mock.calls[0][0];
    expect(spec.env).toEqual({ OPTIO_WORKFLOW_ID: "wf-1", OPTIO_POD_INSTANCE_INDEX: "1" });
    expect(spec.labels["optio.type"]).toBe("workflow-pod");
    expect(podPool.markPodReady).toHaveBeenCalledWith("pod-new", {
      podName: "optio-wf-wf1-1-abcd",
      podId: "k8s-id",
    });
  });

  it("marks the row errored and cleans up the pod when creation fails", async () => {
    provisionNewPod(0);
    const failure = new Error("ErrImageNeverPull");
    mockRuntimeCreate.mockRejectedValueOnce(failure);
    mockRuntimeDestroy.mockResolvedValueOnce(undefined);

    await expect(
      getOrCreateWorkflowPod("wf-1", { maxAgentsPerPod: 2, maxPodInstances: 1 }),
    ).rejects.toThrow("ErrImageNeverPull");

    expect(podPool.markPodError).toHaveBeenCalledWith("pod-new", failure);
    expect(podPool.markPodReady).not.toHaveBeenCalled();
    const podName = mockRuntimeCreate.mock.calls[0][0].name;
    expect(mockRuntimeDestroy).toHaveBeenCalledWith({ id: podName, name: podName });
  });
});

// ── execRunInPod ────────────────────────────────────────────────────

describe("execRunInPod", () => {
  function makeExecSession(output: string) {
    return {
      stdout: {
        [Symbol.asyncIterator]: async function* () {
          if (output) yield Buffer.from(output);
        },
      },
      stdin: { write: vi.fn(), end: vi.fn() },
      stderr: {
        [Symbol.asyncIterator]: async function* () {},
      },
      resize: vi.fn(),
      close: vi.fn(),
    };
  }

  it("increments active run count and returns exec session", async () => {
    const pod = workflowPod({ id: "pod-1", podName: "optio-wf-wf1-0-abcd", podId: "k8s-id" });

    const mockSession = makeExecSession("output");
    mockRuntimeExec.mockResolvedValueOnce(mockSession);

    const session = await execRunInPod(pod, "run-1", ["echo", "hello"], { KEY: "val" });
    expect(session).toBe(mockSession);
    expect(podPool.acquireSlot).toHaveBeenCalledWith("pod-1");
    expect(mockRuntimeExec).toHaveBeenCalledWith(
      { id: "k8s-id", name: "optio-wf-wf1-0-abcd" },
      ["bash", "-c", expect.any(String)],
      { tty: false },
    );
  });

  it("passes env vars and per-run working dir in the exec script", async () => {
    const pod = workflowPod({ id: "pod-1", podName: "optio-wf-wf1-0-abcd", podId: "k8s-id" });

    const mockSession = makeExecSession("");
    mockRuntimeExec.mockResolvedValueOnce(mockSession);

    await execRunInPod(pod, "run-1", ["echo", "test"], { MY_VAR: "hello" });

    const execCall = mockRuntimeExec.mock.calls[0];
    expect(execCall[1][0]).toBe("bash");
    expect(execCall[1][1]).toBe("-c");
    // Env vars are embedded as inert single-quoted exports (no eval/word-splitting)
    expect(execCall[1][2]).toContain("export MY_VAR='hello'");
    expect(execCall[1][2]).toContain("export OPTIO_WORKFLOW_RUN_ID='run-1'");
    expect(execCall[1][2]).not.toContain("eval $(");
    // And cd into per-run working directory
    expect(execCall[1][2]).toContain("/workspace/runs/run-1");
  });
});
