/**
 * The task controls, retry above all: a retry of a task already queued is
 * not a transition (queued → queued is invalid, and used to come back as
 * 409 "queued -> queued"); it leaves a queued job alone and re-adds a lost
 * one. A task that never started is told so instead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetTask = vi.fn();
const mockTransitionTask = vi.fn();
const mockForceRedoTask = vi.fn();
vi.mock("./task-service.js", () => ({
  getTask: (...args: unknown[]) => mockGetTask(...args),
  transitionTask: (...args: unknown[]) => mockTransitionTask(...args),
  forceRedoTask: (...args: unknown[]) => mockForceRedoTask(...args),
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
const mockQueueGetJobs = vi.fn().mockResolvedValue([]);
vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
    getJobs: (...args: unknown[]) => mockQueueGetJobs(...args),
  },
}));

const mockDbWhere = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/client.js", () => ({
  db: { update: () => ({ set: () => ({ where: (...args: unknown[]) => mockDbWhere(...args) }) }) },
}));
vi.mock("../db/schema.js", () => ({ tasks: { id: "id" } }));

import { controlTask, TaskControlError } from "./task-control-service.js";

const task = (over: Record<string, unknown> = {}) => ({
  id: "task-1",
  state: "failed",
  prUrl: null,
  sessionId: null,
  priority: 100,
  ...over,
});

describe("controlTask retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueGetJobs.mockResolvedValue([]);
    mockQueueAdd.mockResolvedValue(undefined);
  });

  it("re-queues a failed task through the state machine and enqueues its job", async () => {
    const queued = task({ state: "queued" });
    mockTransitionTask.mockResolvedValue(queued);

    const result = await controlTask("task-1", "retry", {
      userId: "user-1",
      task: task({ prUrl: "https://gitlab.example/acme/app/-/merge_requests/3" }) as never,
    });

    expect(result).toBe(queued);
    expect(mockTransitionTask).toHaveBeenCalledWith(
      "task-1",
      "queued",
      "user_retry",
      undefined,
      "user-1",
    );
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      { taskId: "task-1", restartFromBranch: true },
      expect.objectContaining({ attempts: 1 }),
    );
  });

  it("returns a queued task as is when its job is still in the queue", async () => {
    const queued = task({ state: "queued" });
    mockQueueGetJobs.mockResolvedValue([
      { data: { taskId: "other" } },
      { data: { taskId: "task-1" } },
    ]);

    const result = await controlTask("task-1", "retry", { task: queued as never });

    expect(result).toBe(queued);
    expect(mockQueueGetJobs).toHaveBeenCalledWith(["waiting", "delayed", "prioritized", "active"]);
    expect(mockTransitionTask).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("re-adds the job of a queued task the queue lost, with no state write", async () => {
    const queued = task({ state: "queued", prUrl: "https://github.com/acme/app/pull/7" });
    mockQueueGetJobs.mockResolvedValue([{ data: { taskId: "other" } }]);
    mockGetTask.mockResolvedValue(queued);

    const result = await controlTask("task-1", "retry", { task: queued as never });

    expect(result).toBe(queued);
    expect(mockTransitionTask).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      { taskId: "task-1", restartFromBranch: true },
      expect.objectContaining({ attempts: 1 }),
    );
  });

  it("names the re-added job after the queued row, so racing retries add one job", async () => {
    const queued = task({ state: "queued", updatedAt: new Date("2026-10-20T10:00:00Z") });
    mockGetTask.mockResolvedValue(queued);

    await Promise.all([
      controlTask("task-1", "retry", { task: queued as never }),
      controlTask("task-1", "retry", { task: queued as never }),
    ]);

    const ids = mockQueueAdd.mock.calls.map((call) => (call[2] as { jobId: string }).jobId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(`task-1-requeue-${Date.parse("2026-10-20T10:00:00Z")}`);
  });

  it("tells a task that has not started yet to be started instead", async () => {
    for (const state of ["pending", "waiting_on_deps"]) {
      await expect(
        controlTask("task-1", "retry", { task: task({ state }) as never }),
      ).rejects.toThrow(TaskControlError);
      await expect(
        controlTask("task-1", "retry", { task: task({ state }) as never }),
      ).rejects.toThrow(/has not started yet/);
    }
    expect(mockTransitionTask).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
