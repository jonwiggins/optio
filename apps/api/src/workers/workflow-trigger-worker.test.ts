import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock BullMQ before importing the worker
vi.mock("bullmq", () => {
  const addMock = vi.fn();
  return {
    Queue: vi.fn().mockImplementation(() => ({ add: addMock })),
    Worker: vi.fn().mockImplementation((_name: string, processor: any) => {
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
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockGetDueScheduleTriggersAll = vi.fn();
const mockGetWorkflow = vi.fn();
const mockCreateWorkflowRun = vi.fn();
const mockMarkTriggerFired = vi.fn();
const mockGetTaskConfig = vi.fn();
const mockInstantiateTask = vi.fn();

// The worker finds due schedules through the trigger service and fires them
// through the dispatcher, which reaches the per-kind services mocked here.
vi.mock("../services/trigger-service.js", () => ({
  listDueScheduleTriggers: (...args: unknown[]) => mockGetDueScheduleTriggersAll(...args),
  advanceSchedule: (...args: unknown[]) => mockMarkTriggerFired(...args),
  markTriggerFired: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/workflow-service.js", () => ({
  getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
  createWorkflowRun: (...args: unknown[]) => mockCreateWorkflowRun(...args),
}));

vi.mock("../services/task-config-service.js", () => ({
  getTaskConfig: (...args: unknown[]) => mockGetTaskConfig(...args),
  instantiateTask: (...args: unknown[]) => mockInstantiateTask(...args),
}));

import { Worker } from "bullmq";
import { startWorkflowTriggerWorker } from "./workflow-trigger-worker.js";
import { logger } from "../logger.js";

function jobTrigger(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "t-1",
    targetType: "job",
    targetId: "w-1",
    type: "schedule",
    config: { cronExpression: "0 0 * * *" },
    paramMapping: null,
    ...overrides,
  };
}

function taskConfigTrigger(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "t-tc-1",
    targetType: "task_config",
    targetId: "tc-1",
    type: "schedule",
    config: { cronExpression: "0 0 * * *" },
    paramMapping: null,
    ...overrides,
  };
}

describe("workflow-trigger-worker", () => {
  let processor: () => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    const worker = startWorkflowTriggerWorker();
    processor = (Worker as any).mock.calls[0][1];
  });

  it("does nothing when no triggers are due", async () => {
    mockGetDueScheduleTriggersAll.mockResolvedValue([]);
    await processor();
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
    expect(mockInstantiateTask).not.toHaveBeenCalled();
  });

  it("dispatches job targets to createWorkflowRun and marks fired", async () => {
    mockGetDueScheduleTriggersAll.mockResolvedValue([
      jobTrigger({ paramMapping: { env: "production" } }),
    ]);
    mockGetWorkflow.mockResolvedValue({ id: "w-1", name: "Deploy", enabled: true });
    mockCreateWorkflowRun.mockResolvedValue({ id: "run-1" });

    await processor();

    expect(mockCreateWorkflowRun).toHaveBeenCalledWith("w-1", {
      triggerId: "t-1",
      params: { env: "production" },
    });
    expect(mockMarkTriggerFired).toHaveBeenCalledWith("t-1", "0 0 * * *");
  });

  it("skips disabled workflow targets but still marks fired", async () => {
    mockGetDueScheduleTriggersAll.mockResolvedValue([jobTrigger()]);
    mockGetWorkflow.mockResolvedValue({ id: "w-1", name: "Off", enabled: false });

    await processor();

    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
    expect(mockMarkTriggerFired).toHaveBeenCalledWith("t-1", "0 0 * * *");
  });

  it("dispatches task_config targets to instantiateTask", async () => {
    mockGetDueScheduleTriggersAll.mockResolvedValue([taskConfigTrigger()]);
    mockGetTaskConfig.mockResolvedValue({ id: "tc-1", name: "CVE patch", enabled: true });
    mockInstantiateTask.mockResolvedValue({ id: "task-9" });

    await processor();

    expect(mockInstantiateTask).toHaveBeenCalledWith("tc-1", {
      triggerId: "t-tc-1",
      params: undefined,
      ticket: undefined,
    });
    expect(mockMarkTriggerFired).toHaveBeenCalledWith("t-tc-1", "0 0 * * *");
  });

  it("skips disabled task_config targets but still marks fired", async () => {
    mockGetDueScheduleTriggersAll.mockResolvedValue([taskConfigTrigger()]);
    mockGetTaskConfig.mockResolvedValue({ id: "tc-1", name: "Off", enabled: false });

    await processor();

    expect(mockInstantiateTask).not.toHaveBeenCalled();
    expect(mockMarkTriggerFired).toHaveBeenCalledWith("t-tc-1", "0 0 * * *");
  });

  it("skips triggers missing cronExpression in config", async () => {
    mockGetDueScheduleTriggersAll.mockResolvedValue([jobTrigger({ config: {} })]);

    await processor();

    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
    expect(mockMarkTriggerFired).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: "t-1" }),
      expect.stringContaining("missing cronExpression"),
    );
  });

  it("still advances nextFireAt on dispatch failure", async () => {
    mockGetDueScheduleTriggersAll.mockResolvedValue([
      jobTrigger({ config: { cronExpression: "*/5 * * * *" } }),
    ]);
    mockGetWorkflow.mockResolvedValue({ id: "w-1", enabled: true });
    mockCreateWorkflowRun.mockRejectedValue(new Error("DB error"));

    await processor();

    expect(mockMarkTriggerFired).toHaveBeenCalledWith("t-1", "*/5 * * * *");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: "t-1" }),
      "Failed to fire schedule trigger",
    );
  });

  it("processes a mix of job and task_config triggers in one tick", async () => {
    mockGetDueScheduleTriggersAll.mockResolvedValue([
      jobTrigger({ id: "t-a", targetId: "w-a" }),
      taskConfigTrigger({ id: "t-b", targetId: "tc-b" }),
    ]);
    mockGetWorkflow.mockResolvedValue({ id: "w-a", name: "A", enabled: true });
    mockGetTaskConfig.mockResolvedValue({ id: "tc-b", name: "B", enabled: true });
    mockCreateWorkflowRun.mockResolvedValue({ id: "run-a" });
    mockInstantiateTask.mockResolvedValue({ id: "task-b" });

    await processor();

    expect(mockCreateWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockInstantiateTask).toHaveBeenCalledTimes(1);
    expect(mockMarkTriggerFired).toHaveBeenCalledTimes(2);
  });
});
