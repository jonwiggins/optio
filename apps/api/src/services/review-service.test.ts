import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../db/schema.js", () => ({
  repos: { repoUrl: "repoUrl", workspaceId: "workspaceId" },
  workspaces: { id: "id", slug: "slug" },
  tasks: {},
  taskEvents: {},
  taskLogs: {},
  optioSettings: { workspaceId: "workspaceId" },
  promptTemplates: {
    name: "name",
    template: "template",
    repoUrl: "repoUrl",
    ownerUserId: "ownerUserId",
    workspaceId: "workspaceId",
  },
}));

const mockGetTask = vi.fn();
const mockTransitionTask = vi.fn();

vi.mock("./task-service.js", () => ({
  getTask: (...args: any[]) => mockGetTask(...args),
  transitionTask: (...args: any[]) => mockTransitionTask(...args),
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: { add: (...args: any[]) => mockQueueAdd(...args) },
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock subtask-service (dynamic import in launchReview)
const mockCreateSubtask = vi.fn();
const mockQueueSubtask = vi.fn();

vi.mock("./subtask-service.js", () => ({
  createSubtask: (...args: any[]) => mockCreateSubtask(...args),
  queueSubtask: (...args: any[]) => mockQueueSubtask(...args),
}));

// The MR's description and discussion come from the platform; none here, so
// the db mocks below feed only the repo and the review-prompt lookups.
vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: vi.fn().mockRejectedValue(new Error("no platform in unit tests")),
}));

// optioSettingsService is read through the resolver to surface workspace-level
// defaults. Stub it out so the resolver only sees per-repo data in these tests.
vi.mock("./optio-settings-service.js", () => ({
  getSettings: vi.fn().mockResolvedValue({
    defaultReviewAgentType: null,
    defaultReviewModel: null,
  }),
}));

import { db } from "../db/client.js";
import * as optioSettingsService from "./optio-settings-service.js";
import { launchReview } from "./review-service.js";

// ── launchReview ────────────────────────────────────────────────────

describe("launchReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when parent task is not found", async () => {
    mockGetTask.mockResolvedValueOnce(null);

    await expect(launchReview("nonexistent")).rejects.toThrow("Parent task not found");
  });

  it("throws when parent task has no PR", async () => {
    mockGetTask.mockResolvedValueOnce({
      id: "task-1",
      title: "Test Task",
      prUrl: null,
      repoUrl: "https://github.com/org/repo",
    });

    await expect(launchReview("task-1")).rejects.toThrow("Parent task has no PR");
  });

  it("throws when PR number cannot be parsed from URL", async () => {
    mockGetTask.mockResolvedValueOnce({
      id: "task-1",
      title: "Test Task",
      prUrl: "https://github.com/org/repo",
      repoUrl: "https://github.com/org/repo",
    });

    await expect(launchReview("task-1")).rejects.toThrow("Cannot parse PR number");
  });

  it("creates a review subtask and queues it", async () => {
    const parentTask = {
      id: "task-1",
      title: "Implement feature X",
      prompt: "Add feature X",
      prUrl: "https://github.com/org/repo/pull/42",
      repoUrl: "https://github.com/org/repo.git",
    };

    mockGetTask.mockResolvedValueOnce(parentTask);

    // Repo config query (first call is getDefaultWorkspaceId, second is the repo lookup)
    vi.mocked(db.select().from(undefined as any).where as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { reviewPromptTemplate: null, testCommand: "npm test", reviewModel: "haiku" },
      ]);

    const reviewSubtask = { id: "review-1", title: "Review: Implement feature X" };
    mockCreateSubtask.mockResolvedValueOnce(reviewSubtask);
    mockTransitionTask.mockResolvedValueOnce({ id: "review-1", state: "queued" });

    const reviewId = await launchReview("task-1");

    expect(reviewId).toBe("review-1");

    // Verify subtask was created correctly
    expect(mockCreateSubtask).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: "task-1",
        title: "Review: Implement feature X",
        prompt: expect.stringContaining("PR #42"),
        taskType: "review",
        blocksParent: true,
        agentType: "claude-code",
      }),
    );

    // Verify task was transitioned to queued
    expect(mockTransitionTask).toHaveBeenCalledWith("review-1", "queued", "review_requested");

    // Verify job was added to queue with review overrides. Both `model`
    // (new agent-agnostic field) and `claudeModel` (back-compat) are set.
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        taskId: "review-1",
        reviewOverride: expect.objectContaining({
          renderedPrompt: expect.any(String),
          taskFileContent: expect.stringContaining("Implement feature X"),
          model: "haiku",
          claudeModel: "haiku",
        }),
      }),
      expect.objectContaining({
        priority: 10,
      }),
    );
  });

  it("uses default review model when repo has no reviewModel configured", async () => {
    const parentTask = {
      id: "task-2",
      title: "Fix bug",
      prompt: "Fix bug Y",
      prUrl: "https://github.com/org/repo/pull/10",
      repoUrl: "https://github.com/org/repo",
    };

    mockGetTask.mockResolvedValueOnce(parentTask);

    // No repo config (first call is getDefaultWorkspaceId, second is the repo lookup)
    vi.mocked(db.select().from(undefined as any).where as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockCreateSubtask.mockResolvedValueOnce({ id: "review-2" });
    mockTransitionTask.mockResolvedValueOnce({ id: "review-2", state: "queued" });

    await launchReview("task-2");

    // With no repo config and no global override, the resolver picks
    // claude-code's catalog default (an Anthropic model id).
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        reviewOverride: expect.objectContaining({
          model: expect.stringMatching(/claude-/),
          claudeModel: expect.stringMatching(/claude-/),
        }),
      }),
      expect.any(Object),
    );
  });

  it("creates a Gemini review subtask for a Gemini-only repo", async () => {
    const parentTask = {
      id: "task-4",
      title: "Add observability",
      prompt: "Add metrics",
      prUrl: "https://github.com/org/repo/pull/77",
      repoUrl: "https://github.com/org/repo",
    };

    mockGetTask.mockResolvedValueOnce(parentTask);

    // Repo lookup returns a Gemini-configured repo. Note: legacy reviewModel
    // value of "sonnet" is intentionally still in the row to verify the
    // resolver drops mismatched models silently.
    vi.mocked(db.select().from(undefined as any).where as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          defaultAgentType: "gemini",
          reviewAgentType: null,
          reviewModel: "sonnet", // wrong-catalog leftover, must be ignored
        },
      ]);

    mockCreateSubtask.mockResolvedValueOnce({ id: "review-4" });
    mockTransitionTask.mockResolvedValueOnce({ id: "review-4", state: "queued" });

    await launchReview("task-4");

    // Subtask should be created with the Gemini agent type, not claude-code.
    expect(mockCreateSubtask).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: "task-4",
        agentType: "gemini",
      }),
    );

    // Model should be a Gemini model id, not the bogus "sonnet" leftover.
    const queueCall = mockQueueAdd.mock.calls[0];
    expect(queueCall[1].reviewOverride.model).toMatch(/gemini-/);
    expect(queueCall[1].reviewOverride.model).not.toBe("sonnet");
  });

  it("includes review context with PR details", async () => {
    const parentTask = {
      id: "task-3",
      title: "Add tests",
      prompt: "Write unit tests for module Z",
      prUrl: "https://github.com/org/repo/pull/99",
      repoUrl: "https://github.com/org/repo",
    };

    mockGetTask.mockResolvedValueOnce(parentTask);
    vi.mocked(db.select().from(undefined as any).where as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockCreateSubtask.mockResolvedValueOnce({ id: "review-3" });
    mockTransitionTask.mockResolvedValueOnce({ id: "review-3" });

    await launchReview("task-3");

    const queueCall = mockQueueAdd.mock.calls[0];
    const taskFileContent = queueCall[1].reviewOverride.taskFileContent;

    expect(taskFileContent).toContain("Add tests");
    expect(taskFileContent).toContain("Write unit tests for module Z");
    expect(taskFileContent).toContain("#99");
    expect(taskFileContent).toContain("optio/task-task-3");
  });
});

// ── Depth, test command and prompt resolution (review-defaults.ts) ──────

describe("launchReview: depth and prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const parentTask = {
    id: "task-9",
    title: "Tidy the parser",
    prompt: "Tidy it",
    prUrl: "https://gitlab.example.com/group/app/-/merge_requests/42",
    repoUrl: "https://gitlab.example.com/group/app",
    workspaceId: "ws-1",
  };

  /** One launch: the repo row, the workspace's saved review prompt, the workspace's settings. */
  async function launch(opts: {
    repo?: Record<string, unknown> | null;
    saved?: Array<{ template: string; workspaceId: string | null }>;
    workspace?: Record<string, unknown>;
    task?: Record<string, unknown>;
  }) {
    mockGetTask.mockResolvedValueOnce({ ...parentTask, ...opts.task });
    vi.mocked(optioSettingsService.getSettings).mockResolvedValueOnce({
      defaultReviewAgentType: null,
      defaultReviewModel: null,
      ...opts.workspace,
    } as never);
    vi.mocked(db.select().from(undefined as any).where as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(opts.repo ? [opts.repo] : [])
      .mockResolvedValueOnce(opts.saved ?? []);
    mockCreateSubtask.mockResolvedValueOnce({ id: "review-9" });
    mockTransitionTask.mockResolvedValueOnce({ id: "review-9" });
    await launchReview("task-9");
    return mockQueueAdd.mock.calls[0][1].reviewOverride as {
      renderedPrompt: string;
      reviewDepth: string;
      maxTurnsReview: number;
    };
  }

  it("a light repo review reads the diff only: no test command, half the turns", async () => {
    const o = await launch({
      repo: {
        reviewEnabled: true,
        reviewDepth: "light",
        testCommand: "npm test",
        maxTurnsReview: 20,
      },
    });
    expect(o.reviewDepth).toBe("light");
    expect(o.maxTurnsReview).toBe(10);
    expect(o.renderedPrompt).toContain("LIGHT review");
    expect(o.renderedPrompt).not.toContain("npm test");
  });

  it("a thorough review runs the repo's test command with the full turn budget", async () => {
    const o = await launch({
      repo: { reviewEnabled: true, reviewDepth: "thorough", testCommand: "npm test" },
    });
    expect(o.reviewDepth).toBe("thorough");
    expect(o.maxTurnsReview).toBe(30);
    expect(o.renderedPrompt).not.toContain("LIGHT review");
    expect(o.renderedPrompt).toContain("npm test");
  });

  it("falls back to the workspace's depth and test command", async () => {
    const o = await launch({
      repo: { reviewEnabled: true, reviewDepth: null, testCommand: null },
      workspace: { reviewDepth: "thorough", reviewTestCommand: "make test" },
    });
    expect(o.reviewDepth).toBe("thorough");
    expect(o.renderedPrompt).toContain("make test");

    vi.clearAllMocks();
    const light = await launch({
      repo: { reviewEnabled: true, reviewDepth: null, testCommand: null },
      workspace: { reviewDepth: "light", reviewTestCommand: "make test" },
    });
    expect(light.reviewDepth).toBe("light");
    expect(light.renderedPrompt).not.toContain("make test");
  });

  it("work that asks for a thorough review gets one over a light repo, never the reverse", async () => {
    const thorough = await launch({
      repo: { reviewEnabled: true, reviewDepth: "light" },
      task: { settings: { review: { enabled: true, depth: "thorough" } } },
    });
    expect(thorough.reviewDepth).toBe("thorough");

    vi.clearAllMocks();
    const kept = await launch({
      repo: { reviewEnabled: true, reviewDepth: "thorough" },
      task: { settings: { review: { enabled: true, depth: "light" } } },
    });
    expect(kept.reviewDepth).toBe("thorough");
  });

  it("uses the workspace's saved review prompt when the repo has none", async () => {
    const o = await launch({
      repo: { reviewEnabled: true, reviewPromptTemplate: null },
      saved: [
        { template: "Instance prompt", workspaceId: null },
        { template: "Workspace prompt for !{{PR_NUMBER}} ({{REVIEW_DEPTH}})", workspaceId: "ws-1" },
      ],
    });
    expect(o.renderedPrompt).toBe("Workspace prompt for !42 (thorough)");
  });

  it("the repo's own prompt wins over the workspace's", async () => {
    const o = await launch({
      repo: { reviewEnabled: true, reviewPromptTemplate: "Repo prompt {{PR_NUMBER}}" },
      saved: [{ template: "Workspace prompt", workspaceId: "ws-1" }],
    });
    expect(o.renderedPrompt).toBe("Repo prompt 42");
  });
});
