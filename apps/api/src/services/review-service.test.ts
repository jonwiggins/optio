import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for review-service:
 * - launchReview: validates parent task, parses PR number, creates review subtask
 */

// Mock BullMQ
vi.mock("bullmq", () => ({
  Worker: vi.fn(),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
    getJobs: vi.fn().mockResolvedValue([]),
  })),
}));

// DB mock — needs select (repos query), update (subtask fields), insert (createTask)
vi.mock("../db/client.js", () => {
  const mockWhere = vi.fn().mockResolvedValue([]);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

  const mockSetWhere = vi.fn().mockResolvedValue(undefined);
  const mockSet = vi.fn().mockReturnValue({ where: mockSetWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

  const mockReturning = vi
    .fn()
    .mockResolvedValue([{ id: "review-task-id", priority: 50, maxRetries: 3 }]);
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

  return {
    db: {
      select: mockSelect,
      update: mockUpdate,
      insert: mockInsert,
      delete: mockDelete,
      _mockWhere: mockWhere,
    },
  };
});

vi.mock("../db/schema.js", () => ({
  repos: { repoUrl: "repoUrl" },
  tasks: {
    id: "id",
    parentTaskId: "parentTaskId",
    subtaskOrder: "subtaskOrder",
    blocksParent: "blocksParent",
    state: "state",
    taskType: "taskType",
  },
}));

const mockGetTask = vi.fn();
const mockTransitionTask = vi.fn();

vi.mock("./task-service.js", () => ({
  getTask: (...args: any[]) => mockGetTask(...args),
  createTask: vi.fn().mockResolvedValue({
    id: "review-task-id",
    title: "Review: Fix bug",
    priority: 50,
    maxRetries: 3,
  }),
  transitionTask: (...args: any[]) => mockTransitionTask(...args),
}));

const mockTaskQueueAdd = vi.fn();
vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: (...args: any[]) => mockTaskQueueAdd(...args),
    getJobs: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { launchReview } from "./review-service.js";

describe("launchReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when parent task is not found", async () => {
    mockGetTask.mockResolvedValue(null);

    await expect(launchReview("nonexistent")).rejects.toThrow("Parent task not found");
  });

  it("throws when parent task has no PR URL", async () => {
    mockGetTask.mockResolvedValue({
      id: "task-1",
      title: "Fix bug",
      prUrl: null,
      repoUrl: "https://github.com/org/repo",
    });

    await expect(launchReview("task-1")).rejects.toThrow("Parent task has no PR");
  });

  it("throws when PR number cannot be parsed from URL", async () => {
    mockGetTask.mockResolvedValue({
      id: "task-1",
      title: "Fix bug",
      prUrl: "https://github.com/org/repo/issues/42",
      repoUrl: "https://github.com/org/repo",
    });

    await expect(launchReview("task-1")).rejects.toThrow("Cannot parse PR number");
  });

  it("creates review subtask and queues it", async () => {
    mockGetTask.mockResolvedValue({
      id: "task-1",
      title: "Fix bug",
      prompt: "Fix the authentication bug",
      prUrl: "https://github.com/org/repo/pull/42",
      repoUrl: "https://github.com/org/repo.git",
      agentType: "claude-code",
      priority: 50,
    });
    mockTransitionTask.mockResolvedValue(undefined);
    mockTaskQueueAdd.mockResolvedValue(undefined);

    // The DB mock for repos query returns no config (uses defaults)
    const { db } = await import("../db/client.js");
    (db as any)._mockWhere.mockResolvedValue([]);

    const reviewTaskId = await launchReview("task-1");

    expect(reviewTaskId).toBe("review-task-id");
    // Verify queue was called with review override
    expect(mockTaskQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        taskId: "review-task-id",
        reviewOverride: expect.objectContaining({
          taskFilePath: expect.stringContaining("review"),
          claudeModel: "sonnet", // default when no repo config
        }),
      }),
      expect.objectContaining({
        priority: 10, // reviews are high priority
      }),
    );
  });

  it("uses repo review model when configured", async () => {
    mockGetTask.mockResolvedValue({
      id: "task-1",
      title: "Fix bug",
      prompt: "Fix it",
      prUrl: "https://github.com/org/repo/pull/99",
      repoUrl: "https://github.com/org/repo",
      agentType: "claude-code",
      priority: 50,
    });
    mockTransitionTask.mockResolvedValue(undefined);
    mockTaskQueueAdd.mockResolvedValue(undefined);

    // DB returns repo config with custom review model
    const { db } = await import("../db/client.js");
    (db as any)._mockWhere.mockResolvedValue([
      {
        repoUrl: "https://github.com/org/repo",
        reviewModel: "haiku",
        reviewPromptTemplate: null,
        testCommand: "npm test",
      },
    ]);

    await launchReview("task-1");

    expect(mockTaskQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        reviewOverride: expect.objectContaining({
          claudeModel: "haiku",
        }),
      }),
      expect.anything(),
    );
  });

  it("transitions review task to queued state", async () => {
    mockGetTask.mockResolvedValue({
      id: "task-1",
      title: "Fix bug",
      prompt: "Fix it",
      prUrl: "https://github.com/org/repo/pull/7",
      repoUrl: "https://github.com/org/repo",
      agentType: "claude-code",
      priority: 50,
    });
    mockTransitionTask.mockResolvedValue(undefined);
    mockTaskQueueAdd.mockResolvedValue(undefined);

    const { db } = await import("../db/client.js");
    (db as any)._mockWhere.mockResolvedValue([]);

    await launchReview("task-1");

    expect(mockTransitionTask).toHaveBeenCalledWith("review-task-id", "queued", "review_requested");
  });

  it("includes review context with PR info in task file", async () => {
    mockGetTask.mockResolvedValue({
      id: "task-1",
      title: "Add feature X",
      prompt: "Implement feature X with tests",
      prUrl: "https://github.com/acme/project/pull/123",
      repoUrl: "https://github.com/acme/project.git",
      agentType: "claude-code",
      priority: 50,
    });
    mockTransitionTask.mockResolvedValue(undefined);
    mockTaskQueueAdd.mockResolvedValue(undefined);

    const { db } = await import("../db/client.js");
    (db as any)._mockWhere.mockResolvedValue([]);

    await launchReview("task-1");

    const addCall = mockTaskQueueAdd.mock.calls[0];
    const reviewOverride = addCall[1].reviewOverride;

    // Review context should contain PR info
    expect(reviewOverride.taskFileContent).toContain("# Review Context");
    expect(reviewOverride.taskFileContent).toContain("Add feature X");
    expect(reviewOverride.taskFileContent).toContain("#123");
    expect(reviewOverride.taskFileContent).toContain("https://github.com/acme/project/pull/123");
  });
});
