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
  transitionWorkflowRunCas: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { db } from "../db/client.js";
import { getRuntime } from "./container-service.js";
import { transitionWorkflowRunCas } from "./workflow-service.js";
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
    podId: null as string | null,
    retryCount: 0,
    updatedAt: OLD_DATE,
    startedAt: OLD_DATE,
    finishedAt: null,
    errorMessage: null,
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

const transition = transitionWorkflowRunCas as ReturnType<typeof vi.fn>;

describe("cleanupZombieWorkflowRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateChain();
    transition.mockResolvedValue({ id: "run-1", state: "failed" });
  });

  // Scoped to the attempt that was seen dead, so a retry that claimed the run since survives.
  const expectFailed = (id = "run-1") =>
    expect(transition).toHaveBeenCalledWith(
      id,
      "running",
      "failed",
      {
        errorMessage: expect.stringContaining("Zombie run detected"),
        finishedAt: expect.any(Date),
      },
      { startedAt: OLD_DATE },
    );

  it("skips runs that are recent (within threshold)", async () => {
    mockSelectChain([makeRun({ updatedAt: RECENT_DATE })]);
    const statusFn = mockRuntimeStatus("running");

    expect(await cleanupZombieWorkflowRuns()).toBe(0);
    expect(statusFn).not.toHaveBeenCalled();
  });

  it("skips runs whose pod is still running", async () => {
    mockSelectChain([makeRun()]);
    mockRuntimeStatus("running");

    expect(await cleanupZombieWorkflowRuns()).toBe(0);
    expect(transition).not.toHaveBeenCalled();
  });

  it("never checks a local run: its agent lives on the owner's machine, not in a pod", async () => {
    mockSelectChain([makeRun({ podName: null, localTerminalId: "term-1" })]);

    expect(await cleanupZombieWorkflowRuns()).toBe(0);
    expect(transition).not.toHaveBeenCalled();
  });

  it("fails a run whose pod is in failed state, through the one Job-run transition", async () => {
    mockSelectChain([makeRun()]);
    mockRuntimeStatus("failed", "OOMKilled");

    expect(await cleanupZombieWorkflowRuns()).toBe(1);
    expectFailed();
  });

  it("fails a run whose pod is not found (throws)", async () => {
    mockSelectChain([makeRun()]);
    const statusFn = vi.fn().mockRejectedValue(new Error("pod not found"));
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue({ status: statusFn });

    expect(await cleanupZombieWorkflowRuns()).toBe(1);
    expectFailed();
  });

  it("fails a cluster run with no podName that is stale", async () => {
    mockSelectChain([makeRun({ podName: null })]);

    expect(await cleanupZombieWorkflowRuns()).toBe(1);
    expectFailed();
  });

  it("does not count a run someone else moved first", async () => {
    mockSelectChain([makeRun({ podId: "pod-1" })]);
    mockRuntimeStatus("failed", "OOMKilled");
    transition.mockResolvedValue(null);

    expect(await cleanupZombieWorkflowRuns()).toBe(0);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("lets go of the run's pod, leaving its slot to the worker and the count repair", async () => {
    // Runs carry their pod assignment directly on the row (podId column).
    mockSelectChain([makeRun({ podId: "pod-1" })]);
    mockRuntimeStatus("failed", "Terminated");

    await cleanupZombieWorkflowRuns();

    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("handles empty running runs list", async () => {
    mockSelectChain([]);
    expect(await cleanupZombieWorkflowRuns()).toBe(0);
  });

  it("continues with the other runs when one throws", async () => {
    mockSelectChain([makeRun({ id: "run-1" }), makeRun({ id: "run-2" })]);
    mockRuntimeStatus("failed", "OOM");
    transition
      .mockRejectedValueOnce(new Error("db hiccup"))
      .mockResolvedValueOnce({ id: "run-2", state: "failed" });

    expect(await cleanupZombieWorkflowRuns()).toBe(1);
    expectFailed("run-2");
  });

  it("does not fail a run whose pod is in unknown state but recently updated", async () => {
    mockSelectChain([makeRun({ updatedAt: RECENT_DATE })]);
    mockRuntimeStatus("unknown");

    expect(await cleanupZombieWorkflowRuns()).toBe(0);
  });
});
