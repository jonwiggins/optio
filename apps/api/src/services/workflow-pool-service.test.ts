import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../db/schema.js", () => ({
  workflowPods: {
    id: "id",
    workflowRunId: "workflowRunId",
    workspaceId: "workspaceId",
    state: "state",
    activeRunCount: "activeRunCount",
    updatedAt: "updatedAt",
    podName: "podName",
    podId: "podId",
    lastRunAt: "lastRunAt",
    errorMessage: "errorMessage",
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

import { db } from "../db/client.js";
import {
  getOrCreateWorkflowPod,
  createWorkflowPod,
  execRunInPod,
  releaseRun,
  cleanupIdleWorkflowPods,
  listWorkflowPods,
} from "./workflow-pool-service.js";

// ── releaseRun ──────────────────────────────────────────────────────

describe("releaseRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("decrements the active run count via DB update", async () => {
    vi.mocked(db.update(undefined as any).set(undefined as any).where as any).mockResolvedValueOnce(
      [],
    );

    await releaseRun("pod-1");

    expect(db.update).toHaveBeenCalled();
    expect(db.update(undefined as any).set).toHaveBeenCalledWith(
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
  });

  it("returns 0 when no idle pods exist", async () => {
    vi.mocked(db.select().from(undefined as any).where as any).mockResolvedValueOnce([]);

    const cleaned = await cleanupIdleWorkflowPods();
    expect(cleaned).toBe(0);
  });

  it("destroys idle pods and removes their records", async () => {
    const idlePod = {
      id: "pod-1",
      workflowRunId: "wf-run-1",
      podName: "optio-wf-abc123-def4",
      podId: "k8s-pod-id-1",
      state: "ready",
      activeRunCount: 0,
    };

    vi.mocked(db.select().from(undefined as any).where as any).mockResolvedValueOnce([idlePod]);

    mockRuntimeDestroy.mockResolvedValueOnce(undefined);
    vi.mocked(db.delete(undefined as any).where as any).mockResolvedValueOnce(undefined);

    const cleaned = await cleanupIdleWorkflowPods();
    expect(cleaned).toBe(1);
    expect(mockRuntimeDestroy).toHaveBeenCalledWith({
      id: idlePod.podId,
      name: idlePod.podName,
    });
  });

  it("continues cleanup even if one pod fails to destroy", async () => {
    const pods = [
      {
        id: "pod-1",
        workflowRunId: "wf-run-1",
        podName: "pod-a",
        podId: "id-a",
        state: "ready",
        activeRunCount: 0,
      },
      {
        id: "pod-2",
        workflowRunId: "wf-run-2",
        podName: "pod-b",
        podId: "id-b",
        state: "ready",
        activeRunCount: 0,
      },
    ];

    vi.mocked(db.select().from(undefined as any).where as any).mockResolvedValueOnce(pods);

    mockRuntimeDestroy
      .mockRejectedValueOnce(new Error("Failed to destroy"))
      .mockResolvedValueOnce(undefined);

    vi.mocked(db.delete(undefined as any).where as any).mockResolvedValue(undefined);

    const cleaned = await cleanupIdleWorkflowPods();
    // First pod fails, second succeeds
    expect(cleaned).toBe(1);
  });

  it("skips destroy if pod has no podName", async () => {
    const pod = {
      id: "pod-1",
      workflowRunId: "wf-run-1",
      podName: null,
      podId: null,
      state: "ready",
      activeRunCount: 0,
    };

    vi.mocked(db.select().from(undefined as any).where as any).mockResolvedValueOnce([pod]);
    vi.mocked(db.delete(undefined as any).where as any).mockResolvedValue(undefined);

    const cleaned = await cleanupIdleWorkflowPods();
    expect(cleaned).toBe(1);
    expect(mockRuntimeDestroy).not.toHaveBeenCalled();
  });
});

// ── listWorkflowPods ────────────────────────────────────────────────

describe("listWorkflowPods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all workflow pods from the database", async () => {
    const mockPods = [
      { id: "pod-1", workflowRunId: "wf-1", podName: "p1", state: "ready" },
      { id: "pod-2", workflowRunId: "wf-2", podName: "p2", state: "provisioning" },
    ];

    vi.mocked(db.select().from as any).mockResolvedValueOnce(mockPods);

    const result = await listWorkflowPods();
    expect(result).toEqual(mockPods);
  });
});

// ── getOrCreateWorkflowPod ──────────────────────────────────────────

describe("getOrCreateWorkflowPod", () => {
  function mockGetOrCreateFlow(opts: { existingPods?: any[]; insertedPod?: any }) {
    const dbMock = db as any;

    let whereCallCount = 0;
    dbMock.where.mockImplementation(() => {
      whereCallCount++;
      if (whereCallCount === 1) {
        // existing pods query
        return Promise.resolve(opts.existingPods ?? []);
      }
      // Remaining calls: update queries
      return Promise.resolve([]);
    });

    if (opts.insertedPod) {
      dbMock.returning.mockResolvedValueOnce([opts.insertedPod]);
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (db as any).where.mockReset().mockReturnThis();
  });

  it("returns existing ready pod when available", async () => {
    const existingPod = {
      id: "pod-1",
      workflowRunId: "wf-run-1",
      podName: "optio-wf-abc-1234",
      podId: "k8s-id",
      state: "ready",
      activeRunCount: 0,
    };

    mockGetOrCreateFlow({ existingPods: [existingPod] });
    mockRuntimeStatus.mockResolvedValueOnce({ state: "running" });

    const pod = await getOrCreateWorkflowPod("wf-run-1", {});
    expect(pod.id).toBe("pod-1");
    expect(pod.state).toBe("ready");
  });

  it("creates a new pod when none exists", async () => {
    const insertedPod = {
      id: "pod-new",
      workflowRunId: "wf-run-1",
      state: "provisioning",
    };

    mockGetOrCreateFlow({
      existingPods: [],
      insertedPod,
    });

    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-wf-abc-def4" });

    const pod = await getOrCreateWorkflowPod("wf-run-1", {});
    expect(pod.state).toBe("ready");
    expect(mockRuntimeCreate).toHaveBeenCalled();
  });

  it("cleans up error pods and creates a new one", async () => {
    const errorPod = {
      id: "pod-err",
      workflowRunId: "wf-run-1",
      podName: "optio-wf-err",
      podId: "k8s-err",
      state: "error",
      activeRunCount: 0,
    };
    const insertedPod = {
      id: "pod-new",
      workflowRunId: "wf-run-1",
      state: "provisioning",
    };

    mockGetOrCreateFlow({
      existingPods: [errorPod],
      insertedPod,
    });

    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-wf-new-abc1" });

    const pod = await getOrCreateWorkflowPod("wf-run-1", {});
    expect(pod.state).toBe("ready");
    expect(db.delete).toHaveBeenCalled(); // error pod record deleted
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
  });

  it("increments active run count and returns exec session", async () => {
    const pod = {
      id: "pod-1",
      workflowRunId: "wf-run-1",
      podName: "optio-wf-abc-def4",
      podId: "k8s-id",
      state: "ready",
      activeRunCount: 0,
    };

    const mockSession = makeExecSession("output");
    mockRuntimeExec.mockResolvedValueOnce(mockSession);
    vi.mocked(db.update(undefined as any).set(undefined as any).where as any).mockResolvedValue([]);

    const session = await execRunInPod(pod, "step-1", ["echo", "hello"], { KEY: "val" });
    expect(session).toBeDefined();
    expect(db.update).toHaveBeenCalled();
    expect(mockRuntimeExec).toHaveBeenCalled();
  });

  it("passes env vars in the exec script", async () => {
    const pod = {
      id: "pod-1",
      workflowRunId: "wf-run-1",
      podName: "optio-wf-abc-def4",
      podId: "k8s-id",
      state: "ready",
      activeRunCount: 0,
    };

    const mockSession = makeExecSession("");
    mockRuntimeExec.mockResolvedValueOnce(mockSession);
    vi.mocked(db.update(undefined as any).set(undefined as any).where as any).mockResolvedValue([]);

    await execRunInPod(pod, "step-1", ["echo", "test"], { MY_VAR: "hello" });

    // Verify exec was called with bash -c and the script includes env setup
    const execCall = mockRuntimeExec.mock.calls[0];
    expect(execCall[1][0]).toBe("bash");
    expect(execCall[1][1]).toBe("-c");
    // The script should contain the base64-encoded env
    expect(execCall[1][2]).toContain("base64");
  });
});
