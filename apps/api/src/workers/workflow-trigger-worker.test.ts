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
const mockCreateWorkflowRun = vi.fn();
const mockMarkTriggerFired = vi.fn();
const mockInstantiateTask = vi.fn();

/** Work definitions the dispatcher can find, by id (each row carries its `kind`). */
const definitionRows = new Map<string, { id: string; kind: string; enabled: boolean }>();
function seedDefinition(row: { id: string; kind: string; enabled: boolean; name?: string }) {
  definitionRows.set(row.id, row);
}

// The worker finds due schedules through the trigger service and fires them
// through the dispatcher, which looks the target up as a work definition and
// starts it through the per-kind services mocked here.
vi.mock("../services/trigger-service.js", () => ({
  listDueScheduleTriggers: (...args: unknown[]) => mockGetDueScheduleTriggersAll(...args),
  advanceSchedule: (...args: unknown[]) => mockMarkTriggerFired(...args),
  markTriggerFired: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/work-definition-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/work-definition-service.js")>();
  return {
    definitionKindOf: actual.definitionKindOf,
    getDefinition: async (id: string, kind?: string) => {
      const row = definitionRows.get(id);
      return row && (!kind || row.kind === kind) ? row : null;
    },
  };
});

vi.mock("../services/workflow-service.js", () => ({
  createWorkflowRun: (...args: unknown[]) => mockCreateWorkflowRun(...args),
}));

vi.mock("../services/task-config-service.js", () => ({
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
    definitionRows.clear();
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
    seedDefinition({ id: "w-1", kind: "standalone", name: "Deploy", enabled: true });
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
    seedDefinition({ id: "w-1", kind: "standalone", name: "Off", enabled: false });

    await processor();

    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
    expect(mockMarkTriggerFired).toHaveBeenCalledWith("t-1", "0 0 * * *");
  });

  it("dispatches task_config targets to instantiateTask", async () => {
    mockGetDueScheduleTriggersAll.mockResolvedValue([taskConfigTrigger()]);
    seedDefinition({ id: "tc-1", kind: "repo-blueprint", name: "CVE patch", enabled: true });
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
    seedDefinition({ id: "tc-1", kind: "repo-blueprint", name: "Off", enabled: false });

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
    seedDefinition({ id: "w-1", kind: "standalone", enabled: true });
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
    seedDefinition({ id: "w-a", kind: "standalone", name: "A", enabled: true });
    seedDefinition({ id: "tc-b", kind: "repo-blueprint", name: "B", enabled: true });
    mockCreateWorkflowRun.mockResolvedValue({ id: "run-a" });
    mockInstantiateTask.mockResolvedValue({ id: "task-b" });

    await processor();

    expect(mockCreateWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockInstantiateTask).toHaveBeenCalledTimes(1);
    expect(mockMarkTriggerFired).toHaveBeenCalledTimes(2);
  });
});
