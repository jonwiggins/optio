import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock BullMQ before importing the worker
vi.mock("bullmq", () => {
  const addMock = vi.fn();
  return {
    Queue: vi.fn().mockImplementation(() => ({ add: addMock })),
    Worker: vi.fn().mockImplementation((_name: string, processor: any) => {
      // Expose the processor so tests can call it
      return { processor, on: vi.fn(), close: vi.fn() };
    }),
  };
});

vi.mock("../services/redis-config.js", () => ({
  getBullMQConnectionOptions: vi.fn().mockReturnValue({}),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockGetDueScheduleTriggers = vi.fn();
const mockCreateWorkflowRun = vi.fn();
const mockMarkTriggerFired = vi.fn();

vi.mock("../services/workflow-service.js", () => ({
  getDueScheduleTriggers: (...args: unknown[]) => mockGetDueScheduleTriggers(...args),
  createWorkflowRun: (...args: unknown[]) => mockCreateWorkflowRun(...args),
  markTriggerFired: (...args: unknown[]) => mockMarkTriggerFired(...args),
}));

import { Worker } from "bullmq";
import { startWorkflowTriggerWorker } from "./workflow-trigger-worker.js";
import { logger } from "../logger.js";

describe("workflow-trigger-worker", () => {
  let processor: () => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    const worker = startWorkflowTriggerWorker();
    // Extract the processor function from the Worker constructor call
    processor = (Worker as any).mock.calls[0][1];
  });

  it("does nothing when no triggers are due", async () => {
    mockGetDueScheduleTriggers.mockResolvedValue([]);

    await processor();

    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
    expect(mockMarkTriggerFired).not.toHaveBeenCalled();
  });

  it("creates a workflow run and marks trigger fired for due triggers", async () => {
    mockGetDueScheduleTriggers.mockResolvedValue([
      {
        trigger: {
          id: "t-1",
          type: "schedule",
          config: { cronExpression: "0 0 * * *" },
          paramMapping: { env: "production" },
        },
        workflow: { id: "w-1", name: "Deploy" },
      },
    ]);
    mockCreateWorkflowRun.mockResolvedValue({ id: "run-1" });
    mockMarkTriggerFired.mockResolvedValue(undefined);

    await processor();

    expect(mockCreateWorkflowRun).toHaveBeenCalledWith("w-1", {
      triggerId: "t-1",
      params: { env: "production" },
    });
    expect(mockMarkTriggerFired).toHaveBeenCalledWith("t-1", "0 0 * * *");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: "t-1", workflowId: "w-1", workflowRunId: "run-1" }),
      "Workflow schedule trigger fired",
    );
  });

  it("skips triggers missing cronExpression in config", async () => {
    mockGetDueScheduleTriggers.mockResolvedValue([
      {
        trigger: { id: "t-2", type: "schedule", config: {}, paramMapping: null },
        workflow: { id: "w-2", name: "Bad Trigger" },
      },
    ]);

    await processor();

    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: "t-2" }),
      expect.stringContaining("missing cronExpression"),
    );
  });

  it("still advances nextFireAt on createWorkflowRun failure", async () => {
    mockGetDueScheduleTriggers.mockResolvedValue([
      {
        trigger: {
          id: "t-3",
          type: "schedule",
          config: { cronExpression: "*/5 * * * *" },
          paramMapping: null,
        },
        workflow: { id: "w-3", name: "Failing" },
      },
    ]);
    mockCreateWorkflowRun.mockRejectedValue(new Error("DB error"));
    mockMarkTriggerFired.mockResolvedValue(undefined);

    await processor();

    // Should still mark fired to prevent re-fire loop
    expect(mockMarkTriggerFired).toHaveBeenCalledWith("t-3", "*/5 * * * *");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: "t-3" }),
      "Failed to fire workflow schedule trigger",
    );
  });

  it("processes multiple due triggers", async () => {
    mockGetDueScheduleTriggers.mockResolvedValue([
      {
        trigger: {
          id: "t-a",
          type: "schedule",
          config: { cronExpression: "0 0 * * *" },
          paramMapping: null,
        },
        workflow: { id: "w-a", name: "A" },
      },
      {
        trigger: {
          id: "t-b",
          type: "schedule",
          config: { cronExpression: "0 12 * * *" },
          paramMapping: null,
        },
        workflow: { id: "w-b", name: "B" },
      },
    ]);
    mockCreateWorkflowRun
      .mockResolvedValueOnce({ id: "run-a" })
      .mockResolvedValueOnce({ id: "run-b" });
    mockMarkTriggerFired.mockResolvedValue(undefined);

    await processor();

    expect(mockCreateWorkflowRun).toHaveBeenCalledTimes(2);
    expect(mockMarkTriggerFired).toHaveBeenCalledTimes(2);
  });
});
