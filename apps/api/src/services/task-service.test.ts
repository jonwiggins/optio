import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskState } from "@optio/shared";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../db/schema.js", () => ({
  tasks: {
    id: "id",
    state: "state",
    createdAt: "createdAt",
    taskId: "taskId",
    activitySubstate: "activitySubstate",
    repoUrl: "repoUrl",
  },
  taskEvents: { taskId: "taskId", createdAt: "createdAt", userId: "userId" },
  taskLogs: { taskId: "taskId", timestamp: "timestamp", logType: "logType", content: "content" },
  users: { id: "id", displayName: "display_name", avatarUrl: "avatar_url" },
  repos: { repoUrl: "repoUrl" },
}));

vi.mock("./event-bus.js", () => ({ publishEvent: vi.fn() }));
vi.mock("./task-cancellation-service.js", () => ({
  terminateTaskExecution: vi.fn().mockResolvedValue({ streamAborted: true, agentKilled: true }),
}));
vi.mock("../workers/webhook-worker.js", () => ({
  enqueueWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { db } from "../db/client.js";
import { publishEvent } from "./event-bus.js";
import { terminateTaskExecution } from "./task-cancellation-service.js";
import {
  StateRaceError,
  createTask,
  transitionTask,
  tryTransitionTask,
  updateTaskPr,
  searchTasks,
  updateTaskActivity,
  getStallThresholdForRepo,
} from "./task-service.js";

describe("StateRaceError", () => {
  it("has correct name", () => {
    const err = new StateRaceError(TaskState.QUEUED, TaskState.PROVISIONING, TaskState.RUNNING);
    expect(err.name).toBe("StateRaceError");
  });

  it("includes from/to/actual in message", () => {
    const err = new StateRaceError(TaskState.QUEUED, TaskState.PROVISIONING, TaskState.RUNNING);
    expect(err.message).toContain("queued");
    expect(err.message).toContain("provisioning");
    expect(err.message).toContain("running");
  });

  it("stores properties", () => {
    const err = new StateRaceError(TaskState.QUEUED, TaskState.PROVISIONING, TaskState.RUNNING);
    expect(err.attemptedFrom).toBe(TaskState.QUEUED);
    expect(err.attemptedTo).toBe(TaskState.PROVISIONING);
    expect(err.actualState).toBe(TaskState.RUNNING);
  });

  it("is an instance of Error", () => {
    const err = new StateRaceError(TaskState.QUEUED, TaskState.PROVISIONING, undefined);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("unknown");
  });
});

describe("createTask", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts a task and publishes event", async () => {
    const mockTask = { id: "task-1", title: "Test", state: "pending" };
    vi.mocked(db.insert(undefined as any).values(undefined as any).returning).mockResolvedValueOnce(
      [mockTask] as any,
    );
    const result = await createTask({
      title: "Test",
      prompt: "Do",
      repoUrl: "https://github.com/o/r",
      agentType: "claude-code",
    });
    expect(result.id).toBe("task-1");
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task:created", taskId: "task-1" }),
    );
  });
});

describe("transitionTask", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws when task not found", async () => {
    vi.mocked(db.select().from(undefined as any).where).mockResolvedValueOnce([]);
    await expect(transitionTask("x", TaskState.QUEUED, "t")).rejects.toThrow("Task not found");
  });

  it("throws on invalid transition", async () => {
    vi.mocked(db.select().from(undefined as any).where).mockResolvedValueOnce([
      { id: "t1", state: "completed" },
    ]);
    await expect(transitionTask("t1", TaskState.RUNNING, "t")).rejects.toThrow(
      /Invalid state transition/,
    );
  });

  it("succeeds on valid transition", async () => {
    const task = { id: "t1", state: "pending", startedAt: null, ticketSource: null };
    vi.mocked(db.select().from(undefined as any).where).mockResolvedValueOnce([task]);
    vi.mocked(db as any).returning.mockResolvedValueOnce([{ ...task, state: "queued" }]);
    vi.mocked(db.insert(undefined as any).values).mockResolvedValueOnce(undefined as any);
    const result = await transitionTask("t1", TaskState.QUEUED, "trigger");
    expect(result.state).toBe("queued");
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task:state_changed",
        fromState: "pending",
        toState: "queued",
      }),
    );
  });

  it("clears stale errorMessage and resultSummary when a PR is detected (pr_opened)", async () => {
    // Regression: the agent can exit non-zero after opening a valid PR.
    // updateTaskResult persists e.g. "Exit code: 1" before PR detection runs,
    // so the pr_opened transition must wipe those stale fields — a task with
    // an open PR must not look like a failed task.
    const task = {
      id: "t1",
      state: "running",
      startedAt: new Date(),
      ticketSource: null,
      errorMessage: "Exit code: 1",
      resultSummary: "Agent exited with code 1",
    };
    vi.mocked(db.select().from(undefined as any).where).mockResolvedValueOnce([task]);
    vi.mocked(db as any).returning.mockResolvedValueOnce([
      { ...task, state: "pr_opened", errorMessage: null, resultSummary: null },
    ]);
    vi.mocked(db.insert(undefined as any).values).mockResolvedValueOnce(undefined as any);
    await transitionTask("t1", TaskState.PR_OPENED, "pr_detected", "https://github.com/o/r/pull/1");
    expect(db.update(undefined as any).set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: TaskState.PR_OPENED,
        errorMessage: null,
        resultSummary: null,
      }),
    );
  });

  it("throws StateRaceError when atomic update returns 0 rows", async () => {
    const task = { id: "t1", state: "queued", startedAt: null };
    vi.mocked(db.select().from(undefined as any).where)
      .mockResolvedValueOnce([task])
      .mockReturnValueOnce(db as any)
      .mockResolvedValueOnce([{ ...task, state: "provisioning" }]);
    vi.mocked(db as any).returning.mockResolvedValueOnce([]);
    await expect(transitionTask("t1", TaskState.PROVISIONING, "w")).rejects.toBeInstanceOf(
      StateRaceError,
    );
  });
});

describe("tryTransitionTask", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null on StateRaceError", async () => {
    const task = { id: "t1", state: "queued", startedAt: null };
    vi.mocked(db.select().from(undefined as any).where)
      .mockResolvedValueOnce([task])
      .mockReturnValueOnce(db as any)
      .mockResolvedValueOnce([{ ...task, state: "provisioning" }]);
    vi.mocked(db as any).returning.mockResolvedValueOnce([]);
    const result = await tryTransitionTask("t1", TaskState.PROVISIONING, "w");
    expect(result).toBeNull();
  });
});

describe("updateTaskPr", () => {
  beforeEach(() => vi.clearAllMocks());

  it("extracts PR number from URL", async () => {
    // getTask state check → running, then update chain
    vi.mocked(db.select().from(undefined as any).where).mockResolvedValueOnce([
      { id: "t1", state: "running" },
    ]);
    await updateTaskPr("t1", "https://github.com/o/r/pull/42");
    expect(db.update(undefined as any).set).toHaveBeenCalledWith(
      expect.objectContaining({ prUrl: "https://github.com/o/r/pull/42", prNumber: 42 }),
    );
  });

  it("handles URL without PR number", async () => {
    vi.mocked(db.select().from(undefined as any).where).mockResolvedValueOnce([
      { id: "t1", state: "running" },
    ]);
    await updateTaskPr("t1", "https://github.com/o/r");
    expect(db.update(undefined as any).set).toHaveBeenCalledWith(
      expect.objectContaining({ prUrl: "https://github.com/o/r" }),
    );
  });

  it("refuses to attach a PR to a cancelled task", async () => {
    vi.mocked(db.select().from(undefined as any).where).mockResolvedValueOnce([
      { id: "t1", state: "cancelled" },
    ]);
    await updateTaskPr("t1", "https://github.com/o/r/pull/42");
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("transitionTask → cancelled kills the running agent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("terminates execution when a running task is cancelled", async () => {
    const task = { id: "t1", state: "running", startedAt: new Date(), ticketSource: null };
    vi.mocked(db.select().from(undefined as any).where).mockResolvedValueOnce([task]);
    vi.mocked(db as any).returning.mockResolvedValueOnce([{ ...task, state: "cancelled" }]);
    vi.mocked(db.insert(undefined as any).values).mockResolvedValueOnce(undefined as any);

    await transitionTask("t1", TaskState.CANCELLED, "user_cancel");

    // terminateTaskExecution fires via dynamic import (fire-and-forget)
    await vi.waitFor(() => expect(terminateTaskExecution).toHaveBeenCalledWith("t1"));
  });

  it("does not terminate execution when a queued task is cancelled", async () => {
    const task = { id: "t2", state: "queued", startedAt: null, ticketSource: null };
    vi.mocked(db.select().from(undefined as any).where).mockResolvedValueOnce([task]);
    vi.mocked(db as any).returning.mockResolvedValueOnce([{ ...task, state: "cancelled" }]);
    vi.mocked(db.insert(undefined as any).values).mockResolvedValueOnce(undefined as any);

    await transitionTask("t2", TaskState.CANCELLED, "user_cancel");

    // Give any stray dynamic import a tick to land, then assert nothing fired
    await new Promise((resolve) => setImmediate(resolve));
    expect(terminateTaskExecution).not.toHaveBeenCalled();
  });
});

describe("searchTasks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns tasks with cursor when more results exist", async () => {
    const now = new Date();
    // Create limit+1 tasks to trigger hasMore
    const mockTasks = Array.from({ length: 3 }, (_, i) => ({
      id: `task-${i}`,
      title: `Task ${i}`,
      state: "running",
      createdAt: new Date(now.getTime() - i * 1000),
    }));
    const mockDb = db as any;
    // No filters, so chain is: select().from().orderBy().limit() → await resolves via limit
    mockDb.limit.mockResolvedValueOnce(mockTasks);

    const result = await searchTasks({ limit: 2 });
    // 3 results returned for limit=2 means hasMore=true, items trimmed to 2
    expect(result.hasMore).toBe(true);
    expect(result.tasks).toHaveLength(2);
    expect(result.nextCursor).toBeTruthy();
  });

  it("returns no cursor when all results fit", async () => {
    const mockDb = db as any;
    mockDb.limit.mockResolvedValueOnce([
      { id: "t1", title: "Task", state: "running", createdAt: new Date() },
    ]);

    const result = await searchTasks({ limit: 50 });
    expect(result.hasMore).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it("accepts empty params and returns results", async () => {
    const mockDb = db as any;
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await searchTasks({});
    expect(result.hasMore).toBe(false);
    expect(result.tasks).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("applies filters when params are provided", async () => {
    const mockDb = db as any;
    // With filters, chain ends with .where() — mock that to resolve
    mockDb.where.mockResolvedValueOnce([
      { id: "t1", title: "Fix bug", state: "completed", createdAt: new Date() },
    ]);

    const result = await searchTasks({ q: "Fix", state: "completed" });
    expect(result.tasks).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("defaults limit to 50", async () => {
    const mockDb = db as any;
    mockDb.limit.mockResolvedValueOnce([]);

    await searchTasks({});
    // limit(51) = default 50 + 1
    expect(mockDb.limit).toHaveBeenCalledWith(51);
  });
});

describe("getStallThresholdForRepo", () => {
  const originalEnv = process.env.OPTIO_STALL_THRESHOLD_MS;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OPTIO_STALL_THRESHOLD_MS = originalEnv;
    } else {
      delete process.env.OPTIO_STALL_THRESHOLD_MS;
    }
  });

  it("returns per-repo override when set", () => {
    expect(getStallThresholdForRepo({ stallThresholdMs: 900000 })).toBe(900000);
  });

  it("returns env var when repo has no override", () => {
    process.env.OPTIO_STALL_THRESHOLD_MS = "60000";
    expect(getStallThresholdForRepo({ stallThresholdMs: null })).toBe(60000);
    expect(getStallThresholdForRepo(null)).toBe(60000);
  });

  it("returns default when no env var or repo override", () => {
    delete process.env.OPTIO_STALL_THRESHOLD_MS;
    expect(getStallThresholdForRepo(null)).toBe(300000);
    expect(getStallThresholdForRepo({ stallThresholdMs: null })).toBe(300000);
  });
});

describe("updateTaskActivity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates lastActivityAt and checks for recovery", async () => {
    const mockDb = db as any;
    // Chain: update().set().where().returning()
    mockDb.returning.mockResolvedValueOnce([
      { activitySubstate: "active", lastActivityAt: new Date() },
    ]);
    // No recovery event expected for "active" substate
    await updateTaskActivity("t1", new Date());
    expect(db.update).toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "task:recovered" }),
    );
  });

  it("publishes task:recovered event when transitioning from stalled", async () => {
    const at = new Date("2026-04-07T12:00:00Z");
    const mockDb = db as any;
    // update().set().where().returning() → recovered
    mockDb.returning.mockResolvedValueOnce([{ activitySubstate: "recovered", lastActivityAt: at }]);
    // getTask() → select().from().where() — use returning mock for second where chain
    // We need where() to return db for the update chain, then resolve for getTask.
    // Use returning mock for the first chain, and a fresh where mock for the second.
    const origWhere = mockDb.where;
    let whereCallCount = 0;
    mockDb.where = vi.fn().mockImplementation((...args: unknown[]) => {
      whereCallCount++;
      if (whereCallCount <= 1) {
        // First where() — part of update chain, return db so .returning() works
        return mockDb;
      }
      // Second where() — getTask select, return task data
      return Promise.resolve([{ id: "t1", lastActivityAt: new Date("2026-04-07T11:50:00Z") }]);
    });
    await updateTaskActivity("t1", at);
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task:recovered", taskId: "t1" }),
    );
    // Restore original where mock
    mockDb.where = origWhere;
  });
});
