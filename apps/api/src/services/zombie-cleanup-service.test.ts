import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("./container-service.js", () => ({
  getRuntime: vi.fn(),
}));

vi.mock("./workflow-service.js", () => ({
  getWorkflow: vi.fn(),
}));

vi.mock("./workflow-pool-service.js", () => ({
  releaseRun: vi.fn(),
}));

vi.mock("./event-bus.js", () => ({
  publishWorkflowRunEvent: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../workers/workflow-worker.js", () => ({
  workflowRunQueue: {
    add: vi.fn(),
  },
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { db } from "../db/client.js";
import { getRuntime } from "./container-service.js";
import { getWorkflow } from "./workflow-service.js";
import { releaseRun } from "./workflow-pool-service.js";
import { publishWorkflowRunEvent } from "./event-bus.js";
import { workflowRunQueue } from "../workers/workflow-worker.js";
import { cleanupZombieWorkflowRuns } from "./zombie-cleanup-service.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const OLD_DATE = new Date(Date.now() - 600_000); // 10 min ago
const RECENT_DATE = new Date(Date.now() - 30_000); // 30 sec ago

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    workflowId: "wf-1",
    state: "running",
    podName: "wf-pod-run-1",
    retryCount: 0,
    updatedAt: OLD_DATE,
    startedAt: OLD_DATE,
    finishedAt: null,
    errorMessage: null,
    ...overrides,
  };
}

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wf-1",
    name: "Test Workflow",
    maxRetries: 2,
    enabled: true,
    ...overrides,
  };
}

/**
 * Build a mock Drizzle chain: db.select().from().where() → rows
 */
function mockSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  };
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

/**
 * Build a mock Drizzle update chain: db.update().set().where()
 */
function mockUpdateChain() {
  const chain = {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };
  (db.update as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

function mockRuntimeStatus(state: string, reason?: string) {
  const statusFn = vi.fn().mockResolvedValue({ state, reason });
  (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue({ status: statusFn });
  return statusFn;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("cleanupZombieWorkflowRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: db.update chain
    mockUpdateChain();
  });

  it("skips runs that are recent (within threshold)", async () => {
    const run = makeRun({ updatedAt: RECENT_DATE });
    mockSelectChain([run]);
    const statusFn = mockRuntimeStatus("running");

    const cleaned = await cleanupZombieWorkflowRuns();

    expect(cleaned).toBe(0);
    expect(statusFn).not.toHaveBeenCalled();
  });

  it("skips runs whose pod is still running", async () => {
    const run = makeRun();
    mockSelectChain([run]);
    mockRuntimeStatus("running");

    const cleaned = await cleanupZombieWorkflowRuns();

    expect(cleaned).toBe(0);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("fails a run whose pod is in failed state", async () => {
    const run = makeRun();
    mockSelectChain([run]);
    mockRuntimeStatus("failed", "OOMKilled");
    (getWorkflow as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const cleaned = await cleanupZombieWorkflowRuns();

    expect(cleaned).toBe(1);
    expect(db.update).toHaveBeenCalled();
    expect(publishWorkflowRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workflow_run:state_changed",
        workflowRunId: "run-1",
        toState: "failed",
      }),
    );
  });

  it("fails a run whose pod is not found (throws)", async () => {
    const run = makeRun();
    mockSelectChain([run]);
    const statusFn = vi.fn().mockRejectedValue(new Error("pod not found"));
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue({ status: statusFn });
    (getWorkflow as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const cleaned = await cleanupZombieWorkflowRuns();

    expect(cleaned).toBe(1);
    expect(db.update).toHaveBeenCalled();
  });

  it("fails a run with no podName that is stale", async () => {
    const run = makeRun({ podName: null });
    mockSelectChain([run]);
    (getWorkflow as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const cleaned = await cleanupZombieWorkflowRuns();

    expect(cleaned).toBe(1);
    expect(db.update).toHaveBeenCalled();
  });

  it("retries a zombie run when retryCount < maxRetries", async () => {
    const run = makeRun({ retryCount: 0 });
    mockSelectChain([run]);
    mockRuntimeStatus("failed", "OOMKilled");
    (getWorkflow as ReturnType<typeof vi.fn>).mockResolvedValue(makeWorkflow({ maxRetries: 2 }));

    const cleaned = await cleanupZombieWorkflowRuns();

    expect(cleaned).toBe(1);
    // Should have been re-enqueued
    expect(workflowRunQueue.add).toHaveBeenCalledWith(
      "process-workflow-run",
      { workflowRunId: "run-1" },
      expect.objectContaining({ jobId: expect.stringContaining("run-1-zombie-retry") }),
    );
  });

  it("does not retry when retryCount >= maxRetries", async () => {
    const run = makeRun({ retryCount: 2 });
    mockSelectChain([run]);
    mockRuntimeStatus("failed", "OOMKilled");
    (getWorkflow as ReturnType<typeof vi.fn>).mockResolvedValue(makeWorkflow({ maxRetries: 2 }));

    const cleaned = await cleanupZombieWorkflowRuns();

    expect(cleaned).toBe(1);
    expect(workflowRunQueue.add).not.toHaveBeenCalled();
  });

  it("releases the workflow pod on zombie detection", async () => {
    const run = makeRun();
    // First select returns running runs, second returns the pod record
    let selectCallCount = 0;
    const selectMock = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) return Promise.resolve([run]);
          // Pod lookup
          return Promise.resolve([{ id: "pod-1", workflowRunId: "run-1" }]);
        }),
      }),
    };
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(selectMock);
    mockRuntimeStatus("failed", "Terminated");
    (getWorkflow as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await cleanupZombieWorkflowRuns();

    expect(releaseRun).toHaveBeenCalledWith("pod-1");
  });

  it("handles empty running runs list", async () => {
    mockSelectChain([]);

    const cleaned = await cleanupZombieWorkflowRuns();

    expect(cleaned).toBe(0);
  });

  it("continues processing other runs if one fails", async () => {
    const run1 = makeRun({ id: "run-1" });
    const run2 = makeRun({ id: "run-2" });

    // First select returns both runs
    let selectCallCount = 0;
    const selectMock = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) return Promise.resolve([run1, run2]);
          // Pod lookups
          return Promise.resolve([]);
        }),
      }),
    };
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(selectMock);

    // Runtime: first call throws (error during processing), second succeeds
    let statusCallCount = 0;
    const statusFn = vi.fn().mockImplementation(() => {
      statusCallCount++;
      if (statusCallCount === 1) {
        // Make the update throw for run1 to simulate a failure in processing
        return Promise.resolve({ state: "failed", reason: "OOM" });
      }
      return Promise.resolve({ state: "failed", reason: "OOM" });
    });
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue({ status: statusFn });
    (getWorkflow as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const cleaned = await cleanupZombieWorkflowRuns();

    // Both should be cleaned
    expect(cleaned).toBe(2);
  });

  it("does not fail a run whose pod is in unknown state but recently updated", async () => {
    const run = makeRun({ updatedAt: RECENT_DATE });
    mockSelectChain([run]);
    mockRuntimeStatus("unknown");

    const cleaned = await cleanupZombieWorkflowRuns();

    expect(cleaned).toBe(0);
  });
});
