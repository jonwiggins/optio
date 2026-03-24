import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for subtask-service logic:
 * - checkBlockingSubtasks: counts subtask states and determines completion
 * - createSubtask: order calculation, priority inheritance, field defaults
 * - onSubtaskComplete: parent advancement and auto-merge decision
 */

// Mock BullMQ (imported transitively via task-worker)
vi.mock("bullmq", () => ({
  Worker: vi.fn(),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
    getJobs: vi.fn().mockResolvedValue([]),
  })),
}));

// Track DB calls for assertions
let dbSelectResults: any[] = [];
let dbSelectCallCount = 0;

vi.mock("../db/client.js", () => {
  const mockOrderBy = vi.fn().mockImplementation(() => Promise.resolve(dbSelectResults));
  const mockWhere = vi.fn().mockImplementation(() => ({
    orderBy: mockOrderBy,
    then: (resolve: any) => Promise.resolve(dbSelectResults).then(resolve),
  }));
  // Make the where mock thenable so it works as a promise
  Object.defineProperty(mockWhere, "then", {
    value: undefined,
    writable: true,
  });
  const actualMockWhere = vi.fn().mockImplementation(() => {
    dbSelectCallCount++;
    const result = Promise.resolve(dbSelectResults);
    (result as any).orderBy = vi.fn().mockImplementation(() => Promise.resolve(dbSelectResults));
    return result;
  });

  const mockFrom = vi.fn().mockReturnValue({ where: actualMockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

  const mockSetWhere = vi.fn().mockResolvedValue(undefined);
  const mockSet = vi.fn().mockReturnValue({ where: mockSetWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

  const mockReturning = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve([{ id: "new-subtask-id", priority: 50, maxRetries: 3 }]),
    );
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

  return {
    db: {
      select: mockSelect,
      insert: mockInsert,
      update: mockUpdate,
      _mockWhere: actualMockWhere,
      _mockFrom: mockFrom,
      _mockSelect: mockSelect,
    },
  };
});

vi.mock("../db/schema.js", () => ({
  tasks: {
    id: "id",
    parentTaskId: "parentTaskId",
    blocksParent: "blocksParent",
    subtaskOrder: "subtaskOrder",
    state: "state",
    taskType: "taskType",
    repoUrl: "repoUrl",
  },
  repos: {
    repoUrl: "repoUrl",
  },
}));

const mockGetTask = vi.fn();
const mockCreateTask = vi.fn();
const mockTransitionTask = vi.fn();

vi.mock("./task-service.js", () => ({
  getTask: (...args: any[]) => mockGetTask(...args),
  createTask: (...args: any[]) => mockCreateTask(...args),
  transitionTask: (...args: any[]) => mockTransitionTask(...args),
}));

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: vi.fn(),
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { checkBlockingSubtasks } from "./subtask-service.js";

describe("checkBlockingSubtasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectResults = [];
    dbSelectCallCount = 0;
  });

  it("returns allComplete=true when there are no blocking subtasks", async () => {
    dbSelectResults = [];

    const result = await checkBlockingSubtasks("parent-1");

    expect(result).toEqual({
      allComplete: true,
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
    });
  });

  it("returns allComplete=true when all blocking subtasks are completed", async () => {
    dbSelectResults = [
      { id: "sub-1", state: "completed", blocksParent: true },
      { id: "sub-2", state: "completed", blocksParent: true },
    ];

    const result = await checkBlockingSubtasks("parent-1");

    expect(result).toEqual({
      allComplete: true,
      total: 2,
      pending: 0,
      running: 0,
      completed: 2,
      failed: 0,
    });
  });

  it("returns allComplete=false when some subtasks are still running", async () => {
    dbSelectResults = [
      { id: "sub-1", state: "completed", blocksParent: true },
      { id: "sub-2", state: "running", blocksParent: true },
    ];

    const result = await checkBlockingSubtasks("parent-1");

    expect(result).toEqual({
      allComplete: false,
      total: 2,
      pending: 0,
      running: 1,
      completed: 1,
      failed: 0,
    });
  });

  it("returns allComplete=false when some subtasks failed", async () => {
    dbSelectResults = [
      { id: "sub-1", state: "completed", blocksParent: true },
      { id: "sub-2", state: "failed", blocksParent: true },
    ];

    const result = await checkBlockingSubtasks("parent-1");

    expect(result).toEqual({
      allComplete: false,
      total: 2,
      pending: 0,
      running: 0,
      completed: 1,
      failed: 1,
    });
  });

  it("counts queued and provisioning as running", async () => {
    dbSelectResults = [
      { id: "sub-1", state: "queued", blocksParent: true },
      { id: "sub-2", state: "provisioning", blocksParent: true },
      { id: "sub-3", state: "running", blocksParent: true },
    ];

    const result = await checkBlockingSubtasks("parent-1");

    expect(result.running).toBe(3);
    expect(result.allComplete).toBe(false);
  });

  it("counts pending subtasks correctly", async () => {
    dbSelectResults = [
      { id: "sub-1", state: "pending", blocksParent: true },
      { id: "sub-2", state: "completed", blocksParent: true },
    ];

    const result = await checkBlockingSubtasks("parent-1");

    expect(result.pending).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.allComplete).toBe(false);
  });

  it("handles mixed states correctly", async () => {
    dbSelectResults = [
      { id: "sub-1", state: "completed", blocksParent: true },
      { id: "sub-2", state: "failed", blocksParent: true },
      { id: "sub-3", state: "running", blocksParent: true },
      { id: "sub-4", state: "pending", blocksParent: true },
      { id: "sub-5", state: "queued", blocksParent: true },
    ];

    const result = await checkBlockingSubtasks("parent-1");

    expect(result).toEqual({
      allComplete: false,
      total: 5,
      pending: 1,
      running: 2, // running + queued
      completed: 1,
      failed: 1,
    });
  });
});
