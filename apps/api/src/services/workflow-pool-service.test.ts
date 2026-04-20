import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────
//
// Drizzle queries look like `db.select().from().where().orderBy().limit()`,
// where every step is a thenable. The helper below returns a Promise that also
// carries `.orderBy()` / `.limit()` methods so the exact call shape the
// production code uses (which varies by branch) resolves without surprise.

function thenableRows(rows: unknown): any {
  const promise: any = Promise.resolve(rows);
  promise.orderBy = () => thenableRows(rows);
  promise.limit = () => thenableRows(rows);
  return promise;
}

// Created inside the mock factory (which is hoisted). We export-capture the
// same object via a getter so the test body can manipulate mock behavior.
vi.mock("../db/client.js", () => {
  const m = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockReturnThis(),
  };
  return { db: m };
});

vi.mock("../db/schema.js", () => ({
  workflowPods: {
    id: "id",
    workflowId: "workflowId",
    instanceIndex: "instanceIndex",
    workspaceId: "workspaceId",
    state: "state",
    activeRunCount: "activeRunCount",
    updatedAt: "updatedAt",
    podName: "podName",
    podId: "podId",
    lastRunAt: "lastRunAt",
    errorMessage: "errorMessage",
  },
  workflowRuns: {
    id: "id",
    state: "state",
    podId: "podId",
  },
}));

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

import { db } from "../db/client.js";
import {
  getOrCreateWorkflowPod,
  execRunInPod,
  releaseRun,
  cleanupIdleWorkflowPods,
  listWorkflowPods,
} from "./workflow-pool-service.js";

const dbMock = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function resetDbMock() {
  dbMock.select.mockReset().mockReturnThis();
  dbMock.from.mockReset().mockReturnThis();
  dbMock.where.mockReset();
  dbMock.orderBy.mockReset();
  dbMock.limit.mockReset();
  dbMock.update.mockReset().mockReturnThis();
  dbMock.set.mockReset().mockReturnThis();
  dbMock.insert.mockReset().mockReturnThis();
  dbMock.values.mockReset().mockReturnThis();
  dbMock.returning.mockReset().mockResolvedValue([]);
  dbMock.delete.mockReset().mockReturnThis();
}

// ── releaseRun ──────────────────────────────────────────────────────

describe("releaseRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMock();
    dbMock.where.mockResolvedValue([]);
  });

  it("decrements the active run count via DB update", async () => {
    await releaseRun("pod-1");

    expect(dbMock.update).toHaveBeenCalled();
    expect(dbMock.set).toHaveBeenCalledWith(
      expect.objectContaining({
        updatedAt: expect.any(Date),
      }),
    );
  });
});

// ── cleanupIdleWorkflowPods ─────────────────────────────────────────

describe("cleanupIdleWorkflowPods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMock();
  });

  it("returns 0 when no idle pods exist", async () => {
    dbMock.where.mockReturnValueOnce(thenableRows([]));

    const cleaned = await cleanupIdleWorkflowPods();
    expect(cleaned).toBe(0);
  });

  it("destroys idle pods and removes their records", async () => {
    const idlePod = {
      id: "pod-1",
      workflowId: "wf-1",
      instanceIndex: 0,
      podName: "optio-wf-wf1-0-abcd",
      podId: "k8s-pod-id-1",
      state: "ready",
      activeRunCount: 0,
    };

    dbMock.where.mockReturnValueOnce(thenableRows([idlePod]));
    dbMock.where.mockResolvedValue([]); // later delete() calls

    mockRuntimeDestroy.mockResolvedValueOnce(undefined);

    const cleaned = await cleanupIdleWorkflowPods();
    expect(cleaned).toBe(1);
    expect(mockRuntimeDestroy).toHaveBeenCalledWith({
      id: idlePod.podId,
      name: idlePod.podName,
    });
  });

  it("scales down LIFO — higher instance indices first", async () => {
    const pods = [
      {
        id: "pod-0",
        workflowId: "wf-1",
        instanceIndex: 0,
        podName: "pod-a",
        podId: "id-a",
        state: "ready",
        activeRunCount: 0,
      },
      {
        id: "pod-2",
        workflowId: "wf-1",
        instanceIndex: 2,
        podName: "pod-c",
        podId: "id-c",
        state: "ready",
        activeRunCount: 0,
      },
      {
        id: "pod-1",
        workflowId: "wf-1",
        instanceIndex: 1,
        podName: "pod-b",
        podId: "id-b",
        state: "ready",
        activeRunCount: 0,
      },
    ];

    dbMock.where.mockReturnValueOnce(thenableRows(pods));
    dbMock.where.mockResolvedValue([]);
    mockRuntimeDestroy.mockResolvedValue(undefined);

    await cleanupIdleWorkflowPods();

    const destroyOrder = mockRuntimeDestroy.mock.calls.map((c) => c[0].name);
    expect(destroyOrder).toEqual(["pod-c", "pod-b", "pod-a"]);
  });

  it("continues cleanup even if one pod fails to destroy", async () => {
    const pods = [
      {
        id: "pod-1",
        workflowId: "wf-1",
        instanceIndex: 0,
        podName: "pod-a",
        podId: "id-a",
        state: "ready",
        activeRunCount: 0,
      },
      {
        id: "pod-2",
        workflowId: "wf-2",
        instanceIndex: 0,
        podName: "pod-b",
        podId: "id-b",
        state: "ready",
        activeRunCount: 0,
      },
    ];

    dbMock.where.mockReturnValueOnce(thenableRows(pods));
    dbMock.where.mockResolvedValue([]);

    mockRuntimeDestroy
      .mockRejectedValueOnce(new Error("Failed to destroy"))
      .mockResolvedValueOnce(undefined);

    const cleaned = await cleanupIdleWorkflowPods();
    // First pod fails, second succeeds
    expect(cleaned).toBe(1);
  });

  it("skips destroy if pod has no podName", async () => {
    const pod = {
      id: "pod-1",
      workflowId: "wf-1",
      instanceIndex: 0,
      podName: null,
      podId: null,
      state: "ready",
      activeRunCount: 0,
    };

    dbMock.where.mockReturnValueOnce(thenableRows([pod]));
    dbMock.where.mockResolvedValue([]);

    const cleaned = await cleanupIdleWorkflowPods();
    expect(cleaned).toBe(1);
    expect(mockRuntimeDestroy).not.toHaveBeenCalled();
  });
});

// ── listWorkflowPods ────────────────────────────────────────────────

describe("listWorkflowPods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMock();
  });

  it("returns all workflow pods from the database", async () => {
    const mockPods = [
      { id: "pod-1", workflowId: "wf-1", instanceIndex: 0, podName: "p1", state: "ready" },
      { id: "pod-2", workflowId: "wf-1", instanceIndex: 1, podName: "p2", state: "provisioning" },
    ];

    dbMock.from.mockResolvedValueOnce(mockPods);

    const result = await listWorkflowPods();
    expect(result).toEqual(mockPods);
  });
});

// ── getOrCreateWorkflowPod ──────────────────────────────────────────

describe("getOrCreateWorkflowPod", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMock();
  });

  it("returns an existing ready pod with capacity (least-loaded)", async () => {
    const existingPod = {
      id: "pod-1",
      workflowId: "wf-1",
      instanceIndex: 0,
      podName: "optio-wf-wf1-0-abcd",
      podId: "k8s-id",
      state: "ready",
      activeRunCount: 0,
    };

    // First `.where(...).orderBy(...)` returns the existing pod list.
    dbMock.where.mockReturnValueOnce(thenableRows([existingPod]));
    mockRuntimeStatus.mockResolvedValueOnce({ state: "running" });

    const pod = await getOrCreateWorkflowPod("wf-1", { maxAgentsPerPod: 2, maxPodInstances: 1 });
    expect(pod.id).toBe("pod-1");
    expect(pod.state).toBe("ready");
  });

  it("creates a new pod when none exists and under instance limit", async () => {
    const insertedPod = {
      id: "pod-new",
      workflowId: "wf-1",
      instanceIndex: 0,
      state: "provisioning",
    };

    // 1. Existing pods (empty)
    dbMock.where.mockReturnValueOnce(thenableRows([]));
    // 2. Count query — under maxPodInstances
    dbMock.where.mockReturnValueOnce(thenableRows([{ count: 0 }]));
    // 3. pickNextInstanceIndex — no current pods
    dbMock.where.mockReturnValueOnce(thenableRows([]));
    // 4. Update after create (and any subsequent update)
    dbMock.where.mockResolvedValue([]);

    dbMock.returning.mockResolvedValueOnce([insertedPod]);

    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-wf-wf1-0-abcd" });

    const pod = await getOrCreateWorkflowPod("wf-1", { maxAgentsPerPod: 2, maxPodInstances: 1 });
    expect(pod.state).toBe("ready");
    expect(mockRuntimeCreate).toHaveBeenCalled();
  });

  it("cleans up error pods and creates a new one", async () => {
    const errorPod = {
      id: "pod-err",
      workflowId: "wf-1",
      instanceIndex: 0,
      podName: "optio-wf-err",
      podId: "k8s-err",
      state: "error",
      activeRunCount: 0,
    };
    const insertedPod = {
      id: "pod-new",
      workflowId: "wf-1",
      instanceIndex: 0,
      state: "provisioning",
    };

    // 1. Existing pods (one in error state)
    dbMock.where.mockReturnValueOnce(thenableRows([errorPod]));
    // 2. Delete result for error pod
    dbMock.where.mockResolvedValueOnce(undefined);
    // 3. Count query — under maxPodInstances
    dbMock.where.mockReturnValueOnce(thenableRows([{ count: 0 }]));
    // 4. pickNextInstanceIndex
    dbMock.where.mockReturnValueOnce(thenableRows([]));
    // 5+. Remaining updates
    dbMock.where.mockResolvedValue([]);

    dbMock.returning.mockResolvedValueOnce([insertedPod]);

    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-wf-new-abcd" });

    const pod = await getOrCreateWorkflowPod("wf-1", { maxAgentsPerPod: 2, maxPodInstances: 1 });
    expect(pod.state).toBe("ready");
    expect(dbMock.delete).toHaveBeenCalled(); // error pod record deleted
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

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMock();
    dbMock.where.mockResolvedValue([]);
  });

  it("increments active run count and returns exec session", async () => {
    const pod = {
      id: "pod-1",
      workflowId: "wf-1",
      instanceIndex: 0,
      podName: "optio-wf-wf1-0-abcd",
      podId: "k8s-id",
      state: "ready",
      activeRunCount: 0,
    };

    const mockSession = makeExecSession("output");
    mockRuntimeExec.mockResolvedValueOnce(mockSession);

    const session = await execRunInPod(pod, "run-1", ["echo", "hello"], { KEY: "val" });
    expect(session).toBeDefined();
    expect(dbMock.update).toHaveBeenCalled();
    expect(mockRuntimeExec).toHaveBeenCalled();
  });

  it("passes env vars and per-run working dir in the exec script", async () => {
    const pod = {
      id: "pod-1",
      workflowId: "wf-1",
      instanceIndex: 0,
      podName: "optio-wf-wf1-0-abcd",
      podId: "k8s-id",
      state: "ready",
      activeRunCount: 0,
    };

    const mockSession = makeExecSession("");
    mockRuntimeExec.mockResolvedValueOnce(mockSession);

    await execRunInPod(pod, "run-1", ["echo", "test"], { MY_VAR: "hello" });

    const execCall = mockRuntimeExec.mock.calls[0];
    expect(execCall[1][0]).toBe("bash");
    expect(execCall[1][1]).toBe("-c");
    // The script should contain the base64-encoded env
    expect(execCall[1][2]).toContain("base64");
    // And cd into per-run working directory
    expect(execCall[1][2]).toContain("/workspace/runs/run-1");
  });
});
