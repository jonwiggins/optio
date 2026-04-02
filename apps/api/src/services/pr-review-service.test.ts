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
    delete: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../db/schema.js", () => ({
  repos: { id: "id", repoUrl: "repoUrl", workspaceId: "workspaceId" },
  tasks: { id: "id", taskType: "taskType", prUrl: "prUrl", prNumber: "prNumber" },
  taskLogs: { taskId: "taskId", content: "content", logType: "logType" },
  reviewDrafts: {
    id: "id",
    taskId: "taskId",
    prUrl: "prUrl",
    prNumber: "prNumber",
    repoOwner: "repoOwner",
    repoName: "repoName",
    headSha: "headSha",
    state: "state",
  },
}));

const mockCreateTask = vi.fn();
const mockTransitionTask = vi.fn();
const mockGetTask = vi.fn();

vi.mock("./task-service.js", () => ({
  createTask: (...args: any[]) => mockCreateTask(...args),
  transitionTask: (...args: any[]) => mockTransitionTask(...args),
  getTask: (...args: any[]) => mockGetTask(...args),
}));

const mockPlatform = {
  type: "github",
  getPullRequest: vi.fn(),
  listOpenPullRequests: vi.fn(),
  getCIChecks: vi.fn(),
  getReviews: vi.fn(),
  getInlineComments: vi.fn(),
  getIssueComments: vi.fn(),
  mergePullRequest: vi.fn(),
  submitReview: vi.fn(),
  listIssues: vi.fn(),
  createLabel: vi.fn(),
  addLabelsToIssue: vi.fn(),
  createIssueComment: vi.fn(),
  closeIssue: vi.fn(),
  getRepoMetadata: vi.fn(),
  listRepoContents: vi.fn(),
};

const mockGetGitPlatformForRepo = vi.fn().mockResolvedValue({
  platform: mockPlatform,
  ri: {
    platform: "github",
    host: "github.com",
    owner: "acme",
    repo: "widgets",
    apiBaseUrl: "https://api.github.com",
  },
});

vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: (...args: any[]) => mockGetGitPlatformForRepo(...args),
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: { add: (...args: any[]) => mockQueueAdd(...args) },
}));

const mockPublishEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("./event-bus.js", () => ({
  publishEvent: (...args: any[]) => mockPublishEvent(...args),
}));

const mockGetRepoByUrl = vi.fn();

vi.mock("./repo-service.js", () => ({
  getRepoByUrl: (...args: any[]) => mockGetRepoByUrl(...args),
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { db } from "../db/client.js";
import {
  launchPrReview,
  parseReviewOutput,
  getReviewDraft,
  updateReviewDraft,
  submitReviewToGitHub,
  getPrStatus,
  listOpenPrs,
  mergePr,
  reReview,
  markDraftStale,
} from "./pr-review-service.js";

// ── Helpers ─────────────────────────────────────────────────────────

function mockJsonResponse(data: any, status = 200, ok = true) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

const sampleDraft = {
  id: "draft-1",
  taskId: "task-1",
  prUrl: "https://github.com/acme/widgets/pull/42",
  prNumber: 42,
  repoOwner: "acme",
  repoName: "widgets",
  headSha: "abc123",
  state: "ready",
  verdict: "approve",
  summary: "Looks good!",
  fileComments: [{ path: "src/index.ts", line: 10, body: "Nit: rename this" }],
  submittedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const sampleRepoConfig = {
  id: "repo-1",
  repoUrl: "https://github.com/acme/widgets",
  fullName: "acme/widgets",
  defaultBranch: "main",
  workspaceId: "ws-1",
  reviewPromptTemplate: null,
  reviewModel: null,
  testCommand: "npm test",
};

// ── launchPrReview ──────────────────────────────────────────────────

function setupPlatformMocks(
  prData = {
    title: "Add feature X",
    body: "Implements feature X",
    headSha: "abc123",
    number: 42,
    state: "open" as const,
    merged: false,
    mergeable: true,
    draft: false,
    baseBranch: "main",
    url: "",
    author: "",
    assignees: [] as string[],
    labels: [] as string[],
    createdAt: "",
    updatedAt: "",
  },
) {
  mockPlatform.getPullRequest.mockResolvedValue(prData);
  mockPlatform.getReviews.mockResolvedValue([]);
  mockPlatform.getIssueComments.mockResolvedValue([]);
  mockPlatform.getInlineComments.mockResolvedValue([]);
}

describe("launchPrReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitPlatformForRepo.mockResolvedValue({
      platform: mockPlatform,
      ri: {
        platform: "github",
        host: "github.com",
        owner: "acme",
        repo: "widgets",
        apiBaseUrl: "https://api.github.com",
      },
    });
  });

  it("throws for an invalid PR URL format", async () => {
    await expect(launchPrReview({ prUrl: "https://github.com/acme/widgets" })).rejects.toThrow(
      "Invalid PR URL",
    );
  });

  it("throws for a malformed URL without a PR number", async () => {
    await expect(
      launchPrReview({ prUrl: "https://github.com/acme/widgets/pull/" }),
    ).rejects.toThrow("Invalid PR URL");
  });

  it("throws when the repo is not configured in Optio", async () => {
    mockGetRepoByUrl.mockResolvedValueOnce(null);

    await expect(
      launchPrReview({ prUrl: "https://github.com/acme/widgets/pull/42" }),
    ).rejects.toThrow("not configured in Optio");
  });

  it("creates a task and review draft for a valid PR URL", async () => {
    mockGetRepoByUrl.mockResolvedValueOnce(sampleRepoConfig);
    setupPlatformMocks();

    const createdTask = { id: "task-new", title: "Review: PR #42 - Add feature X" };
    mockCreateTask.mockResolvedValueOnce(createdTask);

    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const draftRow = { id: "draft-new", taskId: "task-new", state: "drafting" };
    vi.mocked(db.insert as any).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([draftRow]),
      }),
    });

    mockTransitionTask.mockResolvedValueOnce(undefined);

    const result = await launchPrReview({
      prUrl: "https://github.com/acme/widgets/pull/42",
      workspaceId: "ws-1",
    });

    expect(result.task.id).toBe("task-new");
    expect(result.task.taskType).toBe("pr_review");
    expect(result.task.prNumber).toBe(42);
    expect(result.draft.id).toBe("draft-new");

    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Review: PR #42 - Add feature X",
        repoUrl: "https://github.com/acme/widgets",
        agentType: "claude-code",
      }),
    );

    expect(mockTransitionTask).toHaveBeenCalledWith("task-new", "queued", "pr_review_requested");
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        taskId: "task-new",
        reviewOverride: expect.objectContaining({
          renderedPrompt: expect.any(String),
          taskFileContent: expect.stringContaining("PR #42"),
          claudeModel: "sonnet",
        }),
      }),
      expect.objectContaining({ jobId: "task-new", priority: 10 }),
    );
  });

  it("renders the prompt with template variables", async () => {
    mockGetRepoByUrl.mockResolvedValueOnce({
      ...sampleRepoConfig,
      reviewPromptTemplate: "Review PR #{{PR_NUMBER}} in {{REPO_NAME}}. Run: {{TEST_COMMAND}}",
      reviewModel: "haiku",
    });
    setupPlatformMocks({
      title: "Fix bug",
      body: "Fixes bug",
      headSha: "def456",
      number: 10,
      state: "open",
      merged: false,
      mergeable: true,
      draft: false,
      baseBranch: "main",
      url: "",
      author: "",
      assignees: [],
      labels: [],
      createdAt: "",
      updatedAt: "",
    });

    mockCreateTask.mockResolvedValueOnce({ id: "task-tpl" });

    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    vi.mocked(db.insert as any).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "draft-tpl", taskId: "task-tpl" }]),
      }),
    });
    mockTransitionTask.mockResolvedValueOnce(undefined);

    await launchPrReview({ prUrl: "https://github.com/acme/widgets/pull/10" });

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        reviewOverride: expect.objectContaining({
          renderedPrompt: "Review PR #10 in acme/widgets. Run: npm test",
          claudeModel: "haiku",
        }),
      }),
      expect.any(Object),
    );
  });

  it("falls back to default review prompt when repo has no reviewPromptTemplate", async () => {
    mockGetRepoByUrl.mockResolvedValueOnce({ ...sampleRepoConfig, reviewPromptTemplate: null });
    setupPlatformMocks({
      title: "Chore",
      body: "",
      headSha: "sha1",
      number: 5,
      state: "open",
      merged: false,
      mergeable: true,
      draft: false,
      baseBranch: "main",
      url: "",
      author: "",
      assignees: [],
      labels: [],
      createdAt: "",
      updatedAt: "",
    });

    mockCreateTask.mockResolvedValueOnce({ id: "task-def" });
    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    vi.mocked(db.insert as any).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "draft-def", taskId: "task-def" }]),
      }),
    });
    mockTransitionTask.mockResolvedValueOnce(undefined);

    await launchPrReview({ prUrl: "https://github.com/acme/widgets/pull/5" });

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        reviewOverride: expect.objectContaining({
          renderedPrompt: expect.stringContaining("code review assistant"),
        }),
      }),
      expect.any(Object),
    );
  });

  it("throws when PR head SHA is empty", async () => {
    mockGetRepoByUrl.mockResolvedValueOnce(sampleRepoConfig);
    setupPlatformMocks({
      title: "PR",
      body: "",
      headSha: "",
      number: 99,
      state: "open",
      merged: false,
      mergeable: true,
      draft: false,
      baseBranch: "main",
      url: "",
      author: "",
      assignees: [],
      labels: [],
      createdAt: "",
      updatedAt: "",
    });

    await expect(
      launchPrReview({ prUrl: "https://github.com/acme/widgets/pull/99" }),
    ).rejects.toThrow("Could not determine PR head SHA");
  });
});

// ── parseReviewOutput ───────────────────────────────────────────────

describe("parseReviewOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips if no review draft found for the task", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await parseReviewOutput("task-no-draft");

    // Should not call update
    expect(db.update).not.toHaveBeenCalled();
  });

  it("parses JSON verdict from a markdown code block in task logs", async () => {
    const selectMock = vi.fn();
    const fromMock = vi.fn();
    const whereMock = vi.fn();

    // First call: select reviewDrafts → return draft
    // Second call: select taskLogs → return logs
    let callCount = 0;
    selectMock.mockImplementation(() => {
      callCount++;
      return { from: fromMock };
    });
    fromMock.mockImplementation(() => ({ where: whereMock }));
    whereMock.mockImplementation(() => {
      if (callCount === 1) {
        return Promise.resolve([{ id: "draft-1", taskId: "task-1" }]);
      }
      return Promise.resolve([
        {
          content: '```json\n{"verdict": "approve", "summary": "LGTM", "fileComments": []}\n```',
          logType: "tool_result",
        },
      ]);
    });

    vi.mocked(db.select as any).mockImplementation(selectMock);

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    await parseReviewOutput("task-1");

    expect(db.update).toHaveBeenCalled();
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "ready",
        verdict: "approve",
        summary: "LGTM",
      }),
    );
  });

  it("parses raw JSON verdict from logs", async () => {
    let callCount = 0;
    vi.mocked(db.select as any).mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            if (callCount === 1) return Promise.resolve([{ id: "draft-2", taskId: "task-2" }]);
            return Promise.resolve([
              {
                content: '{"verdict": "request_changes", "summary": "Needs work"}',
                logType: "text",
              },
            ]);
          }),
        }),
      };
    });

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    await parseReviewOutput("task-2");

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        verdict: "request_changes",
        summary: "Needs work",
      }),
    );
  });

  it("handles JSON with trailing commas", async () => {
    let callCount = 0;
    vi.mocked(db.select as any).mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            if (callCount === 1) return Promise.resolve([{ id: "draft-3", taskId: "task-3" }]);
            return Promise.resolve([
              {
                content: '```json\n{"verdict": "comment", "summary": "Minor nits",}\n```',
                logType: "tool_result",
              },
            ]);
          }),
        }),
      };
    });

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    await parseReviewOutput("task-3");

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        verdict: "comment",
        summary: "Minor nits",
      }),
    );
  });

  it("falls back to task resultSummary when no structured output exists", async () => {
    let callCount = 0;
    vi.mocked(db.select as any).mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            if (callCount === 1) return Promise.resolve([{ id: "draft-4", taskId: "task-4" }]);
            return Promise.resolve([
              { content: "Some plain text log with no JSON", logType: "text" },
            ]);
          }),
        }),
      };
    });

    mockGetTask.mockResolvedValueOnce({ id: "task-4", resultSummary: "Task completed well" });

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    await parseReviewOutput("task-4");

    expect(mockGetTask).toHaveBeenCalledWith("task-4");
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "ready",
        summary: "Task completed well",
      }),
    );
  });

  it("ignores invalid verdict values", async () => {
    let callCount = 0;
    vi.mocked(db.select as any).mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            if (callCount === 1) return Promise.resolve([{ id: "draft-5", taskId: "task-5" }]);
            return Promise.resolve([
              {
                content: '{"verdict": "reject", "summary": "Bad"}',
                logType: "text",
              },
            ]);
          }),
        }),
      };
    });

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    await parseReviewOutput("task-5");

    // "reject" is not in the allowed set; verdict should not be set
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ state: "ready" }));
    const setArg = updateSetMock.mock.calls[0][0];
    expect(setArg.verdict).toBeUndefined();
  });

  it("stores fileComments when present in parsed output", async () => {
    const comments = [
      { path: "src/app.ts", line: 5, body: "Use const here" },
      { path: "src/lib.ts", body: "Missing docs" },
    ];
    let callCount = 0;
    vi.mocked(db.select as any).mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            if (callCount === 1) return Promise.resolve([{ id: "draft-6", taskId: "task-6" }]);
            return Promise.resolve([
              {
                content: JSON.stringify({
                  verdict: "comment",
                  summary: "Some issues",
                  fileComments: comments,
                }),
                logType: "tool_result",
              },
            ]);
          }),
        }),
      };
    });

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    await parseReviewOutput("task-6");

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fileComments: comments,
      }),
    );
  });
});

// ── getReviewDraft ──────────────────────────────────────────────────

describe("getReviewDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the draft for an existing task", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([sampleDraft]),
      }),
    });

    const result = await getReviewDraft("task-1");

    expect(result).toEqual(sampleDraft);
  });

  it("returns null when no draft exists", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await getReviewDraft("task-no-draft");

    expect(result).toBeNull();
  });
});

// ── updateReviewDraft ───────────────────────────────────────────────

describe("updateReviewDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when draft not found", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(updateReviewDraft("no-draft", { summary: "updated" })).rejects.toThrow(
      "Review draft not found",
    );
  });

  it("throws when draft is in drafting state", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "drafting" }]),
      }),
    });

    await expect(updateReviewDraft("draft-1", { summary: "x" })).rejects.toThrow(
      "Cannot edit draft in drafting state",
    );
  });

  it("throws when draft is in submitted state", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "submitted" }]),
      }),
    });

    await expect(updateReviewDraft("draft-1", { verdict: "approve" })).rejects.toThrow(
      "Cannot edit draft in submitted state",
    );
  });

  it("updates summary, verdict, and fileComments", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "ready" }]),
      }),
    });

    const updatedDraft = { ...sampleDraft, summary: "Updated summary", verdict: "comment" };
    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([updatedDraft]),
      }),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    const result = await updateReviewDraft("draft-1", {
      summary: "Updated summary",
      verdict: "comment",
      fileComments: [{ path: "a.ts", body: "nit" }],
    });

    expect(result).toEqual(updatedDraft);
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "Updated summary",
        verdict: "comment",
        fileComments: [{ path: "a.ts", body: "nit" }],
      }),
    );
  });

  it("allows editing a stale draft", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "stale" }]),
      }),
    });

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "stale", summary: "new" }]),
      }),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    const result = await updateReviewDraft("draft-1", { summary: "new" });

    expect(result.summary).toBe("new");
  });
});

// ── submitReviewToGitHub ────────────────────────────────────────────

describe("submitReviewToGitHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitPlatformForRepo.mockResolvedValue({
      platform: mockPlatform,
      ri: {
        platform: "github",
        host: "github.com",
        owner: "acme",
        repo: "widgets",
        apiBaseUrl: "https://api.github.com",
      },
    });
    mockPlatform.submitReview.mockResolvedValue({
      url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
    });
  });

  it("throws when draft not found", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(submitReviewToGitHub("no-draft")).rejects.toThrow("Review draft not found");
  });

  it("throws when draft is in drafting state", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "drafting" }]),
      }),
    });

    await expect(submitReviewToGitHub("draft-1")).rejects.toThrow(
      "Cannot submit draft in drafting state",
    );
  });

  it("submits review with APPROVE event", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, verdict: "approve" }]),
      }),
    });

    const updatedDraft = { ...sampleDraft, state: "submitted", submittedAt: new Date() };
    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedDraft]),
        }),
      }),
    });

    const result = await submitReviewToGitHub("draft-1");

    expect(result.draft.state).toBe("submitted");
    expect(result.githubReviewUrl).toContain("pullrequestreview");
    expect(mockPlatform.submitReview).toHaveBeenCalledWith(
      expect.any(Object),
      42,
      expect.objectContaining({ event: "APPROVE" }),
    );
  });

  it("submits review with REQUEST_CHANGES event", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([
            { ...sampleDraft, verdict: "request_changes", summary: "Fix the bugs" },
          ]),
      }),
    });

    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "submitted" }]),
        }),
      }),
    });

    await submitReviewToGitHub("draft-1");

    expect(mockPlatform.submitReview).toHaveBeenCalledWith(
      expect.any(Object),
      42,
      expect.objectContaining({ event: "REQUEST_CHANGES" }),
    );
  });

  it("defaults to COMMENT event when verdict is null", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([{ ...sampleDraft, verdict: null, summary: "Some notes" }]),
      }),
    });

    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "submitted" }]),
        }),
      }),
    });

    await submitReviewToGitHub("draft-1");

    expect(mockPlatform.submitReview).toHaveBeenCalledWith(
      expect.any(Object),
      42,
      expect.objectContaining({ event: "COMMENT" }),
    );
  });

  it("includes file comments in the submission", async () => {
    const fileComments = [
      { path: "src/index.ts", line: 10, body: "Rename this variable" },
      { path: "src/utils.ts", body: "Add docs" },
    ];
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, verdict: "comment", fileComments }]),
      }),
    });

    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "submitted" }]),
        }),
      }),
    });

    await submitReviewToGitHub("draft-1");

    const call = mockPlatform.submitReview.mock.calls[0];
    expect(call[2].comments).toHaveLength(2);
    expect(call[2].comments[0]).toEqual(
      expect.objectContaining({ path: "src/index.ts", line: 10, body: "Rename this variable" }),
    );
  });

  it("throws for platform API errors", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, verdict: "approve" }]),
      }),
    });

    mockPlatform.submitReview.mockRejectedValueOnce(
      new Error("GitHub API error 422: Validation failed"),
    );

    await expect(submitReviewToGitHub("draft-1")).rejects.toThrow("GitHub API error 422");
  });

  it("marks draft as submitted after success", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, verdict: "approve" }]),
      }),
    });

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "submitted" }]),
      }),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    const result = await submitReviewToGitHub("draft-1");

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "submitted",
      }),
    );
    expect(result.draft.state).toBe("submitted");
  });

  it("uses user context when userId is provided", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, verdict: "approve" }]),
      }),
    });

    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "submitted" }]),
        }),
      }),
    });

    await submitReviewToGitHub("draft-1", "user-123");

    expect(mockGetGitPlatformForRepo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ userId: "user-123" }),
    );
  });
});

// ── getPrStatus ─────────────────────────────────────────────────────

describe("getPrStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitPlatformForRepo.mockResolvedValue({
      platform: mockPlatform,
      ri: {
        platform: "github",
        host: "github.com",
        owner: "acme",
        repo: "widgets",
        apiBaseUrl: "https://api.github.com",
      },
    });
  });

  it("throws for an invalid PR URL", async () => {
    await expect(getPrStatus("https://github.com/acme/widgets")).rejects.toThrow("Invalid PR URL");
  });

  it("returns checks/review/mergeable status", async () => {
    mockPlatform.getPullRequest.mockResolvedValue({
      number: 42,
      state: "open",
      merged: false,
      mergeable: true,
      headSha: "sha1",
      title: "",
      body: "",
      draft: false,
      baseBranch: "main",
      url: "",
      author: "",
      assignees: [],
      labels: [],
      createdAt: "",
      updatedAt: "",
    });
    mockPlatform.getCIChecks.mockResolvedValue([
      { name: "build", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "skipped" },
    ]);
    mockPlatform.getReviews.mockResolvedValue([{ author: "bob", state: "APPROVED", body: "LGTM" }]);

    const result = await getPrStatus("https://github.com/acme/widgets/pull/42");

    expect(result).toEqual({
      checksStatus: "passing",
      reviewStatus: "approved",
      mergeable: true,
      prState: "open",
      headSha: "sha1",
    });
  });

  it("maps check run conclusions to overall status - pending", async () => {
    mockPlatform.getPullRequest.mockResolvedValue({
      number: 43,
      state: "open",
      merged: false,
      mergeable: true,
      headSha: "sha2",
      title: "",
      body: "",
      draft: false,
      baseBranch: "main",
      url: "",
      author: "",
      assignees: [],
      labels: [],
      createdAt: "",
      updatedAt: "",
    });
    mockPlatform.getCIChecks.mockResolvedValue([
      { name: "build", status: "in_progress", conclusion: null },
      { name: "lint", status: "completed", conclusion: "success" },
    ]);
    mockPlatform.getReviews.mockResolvedValue([]);

    const result = await getPrStatus("https://github.com/acme/widgets/pull/43");

    expect(result.checksStatus).toBe("pending");
  });

  it("maps check run conclusions to overall status - failing", async () => {
    mockPlatform.getPullRequest.mockResolvedValue({
      number: 44,
      state: "open",
      merged: false,
      mergeable: null,
      headSha: "sha3",
      title: "",
      body: "",
      draft: false,
      baseBranch: "main",
      url: "",
      author: "",
      assignees: [],
      labels: [],
      createdAt: "",
      updatedAt: "",
    });
    mockPlatform.getCIChecks.mockResolvedValue([
      { name: "build", status: "completed", conclusion: "failure" },
      { name: "lint", status: "completed", conclusion: "success" },
    ]);
    mockPlatform.getReviews.mockResolvedValue([]);

    const result = await getPrStatus("https://github.com/acme/widgets/pull/44");

    expect(result.checksStatus).toBe("failing");
  });

  it("returns 'none' when there are no check runs", async () => {
    mockPlatform.getPullRequest.mockResolvedValue({
      number: 45,
      state: "open",
      merged: false,
      mergeable: true,
      headSha: "sha4",
      title: "",
      body: "",
      draft: false,
      baseBranch: "main",
      url: "",
      author: "",
      assignees: [],
      labels: [],
      createdAt: "",
      updatedAt: "",
    });
    mockPlatform.getCIChecks.mockResolvedValue([]);
    mockPlatform.getReviews.mockResolvedValue([]);

    const result = await getPrStatus("https://github.com/acme/widgets/pull/45");

    expect(result.checksStatus).toBe("none");
    expect(result.reviewStatus).toBe("none");
  });

  it("detects merged PRs", async () => {
    mockPlatform.getPullRequest.mockResolvedValue({
      number: 46,
      state: "closed",
      merged: true,
      mergeable: false,
      headSha: "sha5",
      title: "",
      body: "",
      draft: false,
      baseBranch: "main",
      url: "",
      author: "",
      assignees: [],
      labels: [],
      createdAt: "",
      updatedAt: "",
    });
    mockPlatform.getCIChecks.mockResolvedValue([]);
    mockPlatform.getReviews.mockResolvedValue([]);

    const result = await getPrStatus("https://github.com/acme/widgets/pull/46");

    expect(result.prState).toBe("merged");
  });

  it("detects changes_requested review status", async () => {
    mockPlatform.getPullRequest.mockResolvedValue({
      number: 47,
      state: "open",
      merged: false,
      mergeable: true,
      headSha: "sha6",
      title: "",
      body: "",
      draft: false,
      baseBranch: "main",
      url: "",
      author: "",
      assignees: [],
      labels: [],
      createdAt: "",
      updatedAt: "",
    });
    mockPlatform.getCIChecks.mockResolvedValue([]);
    mockPlatform.getReviews.mockResolvedValue([
      { author: "alice", state: "COMMENTED", body: "nice" },
      { author: "bob", state: "CHANGES_REQUESTED", body: "Fix this" },
    ]);

    const result = await getPrStatus("https://github.com/acme/widgets/pull/47");

    expect(result.reviewStatus).toBe("changes_requested");
  });
});

// ── listOpenPrs ─────────────────────────────────────────────────────

describe("listOpenPrs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitPlatformForRepo.mockResolvedValue({
      platform: mockPlatform,
      ri: {
        platform: "github",
        host: "github.com",
        owner: "acme",
        repo: "widgets",
        apiBaseUrl: "https://api.github.com",
      },
    });
  });

  it("returns empty array when no repos are configured", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await listOpenPrs("ws-1");

    expect(result).toEqual([]);
  });

  it("returns empty array when GitHub token is not available", async () => {
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([sampleRepoConfig]),
      }),
    });
    // Drafts query
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([]),
    });

    mockGetGitPlatformForRepo.mockRejectedValue(new Error("No token"));

    const result = await listOpenPrs("ws-1");

    expect(result).toEqual([]);
  });

  it("lists PRs across configured repos", async () => {
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([sampleRepoConfig]),
      }),
    });
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([]),
    });

    mockPlatform.listOpenPullRequests.mockResolvedValue([
      {
        number: 42,
        title: "Feature X",
        body: "Adds X",
        state: "open",
        merged: false,
        mergeable: true,
        draft: false,
        headSha: "abc",
        baseBranch: "main",
        url: "https://github.com/acme/widgets/pull/42",
        author: "alice",
        assignees: [],
        labels: ["enhancement"],
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-29T00:00:00Z",
      },
    ]);

    const result = await listOpenPrs("ws-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        number: 42,
        title: "Feature X",
        repo: expect.objectContaining({ id: "repo-1", fullName: "acme/widgets" }),
        reviewDraft: null,
      }),
    );
  });

  it("cross-references existing drafts with PRs", async () => {
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([sampleRepoConfig]),
      }),
    });
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([
        {
          id: "draft-existing",
          taskId: "task-existing",
          state: "ready",
          verdict: "approve",
          repoOwner: "acme",
          repoName: "widgets",
          prNumber: 42,
        },
      ]),
    });

    mockPlatform.listOpenPullRequests.mockResolvedValue([
      {
        number: 42,
        title: "Feature X",
        body: "",
        state: "open",
        merged: false,
        mergeable: true,
        draft: false,
        headSha: "abc",
        baseBranch: "main",
        url: "https://github.com/acme/widgets/pull/42",
        author: "alice",
        assignees: [],
        labels: [],
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-29T00:00:00Z",
      },
    ]);

    const result = await listOpenPrs("ws-1");

    expect(result[0].reviewDraft).toEqual(
      expect.objectContaining({
        id: "draft-existing",
        taskId: "task-existing",
        state: "ready",
        verdict: "approve",
      }),
    );
  });

  it("sorts unreviewed PRs first", async () => {
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([sampleRepoConfig]),
      }),
    });
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([
        {
          id: "draft-x",
          taskId: "task-x",
          state: "ready",
          verdict: "comment",
          repoOwner: "acme",
          repoName: "widgets",
          prNumber: 10,
        },
      ]),
    });

    mockPlatform.listOpenPullRequests.mockResolvedValue([
      {
        number: 10,
        title: "Already reviewed",
        body: "",
        state: "open",
        merged: false,
        mergeable: true,
        draft: false,
        headSha: "a",
        baseBranch: "main",
        url: "https://github.com/acme/widgets/pull/10",
        author: "bob",
        assignees: [],
        labels: [],
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-30T00:00:00Z",
      },
      {
        number: 11,
        title: "Not reviewed",
        body: "",
        state: "open",
        merged: false,
        mergeable: true,
        draft: false,
        headSha: "b",
        baseBranch: "main",
        url: "https://github.com/acme/widgets/pull/11",
        author: "carol",
        assignees: [],
        labels: [],
        createdAt: "2026-03-02T00:00:00Z",
        updatedAt: "2026-03-28T00:00:00Z",
      },
    ]);

    const result = await listOpenPrs("ws-1");

    expect(result).toHaveLength(2);
    expect(result[0].number).toBe(11);
    expect(result[0].reviewDraft).toBeNull();
    expect(result[1].number).toBe(10);
    expect(result[1].reviewDraft).not.toBeNull();
  });

  it("filters by repo when repoId is provided", async () => {
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([sampleRepoConfig]),
      }),
    });
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([]),
    });

    mockPlatform.listOpenPullRequests.mockResolvedValue([
      {
        number: 1,
        title: "PR 1",
        body: "",
        state: "open",
        merged: false,
        mergeable: true,
        draft: false,
        headSha: "x",
        baseBranch: "main",
        url: "https://github.com/acme/widgets/pull/1",
        author: "dev",
        assignees: [],
        labels: [],
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-29T00:00:00Z",
      },
    ]);

    const result = await listOpenPrs("ws-1", "repo-1");

    expect(result).toHaveLength(1);
    expect(result[0].repo.id).toBe("repo-1");
  });
});

// ── mergePr ─────────────────────────────────────────────────────────

describe("mergePr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitPlatformForRepo.mockResolvedValue({
      platform: mockPlatform,
      ri: {
        platform: "github",
        host: "github.com",
        owner: "acme",
        repo: "widgets",
        apiBaseUrl: "https://api.github.com",
      },
    });
  });

  it("throws for an invalid PR URL", async () => {
    await expect(mergePr({ prUrl: "not-a-url", mergeMethod: "squash" })).rejects.toThrow(
      "Invalid PR URL",
    );
  });

  it("merges a PR with the specified method", async () => {
    mockPlatform.mergePullRequest.mockResolvedValue(undefined);

    const result = await mergePr({
      prUrl: "https://github.com/acme/widgets/pull/42",
      mergeMethod: "squash",
    });

    expect(result).toEqual({ merged: true });
    expect(mockPlatform.mergePullRequest).toHaveBeenCalledWith(expect.any(Object), 42, "squash");
  });

  it("throws when merge fails", async () => {
    mockPlatform.mergePullRequest.mockRejectedValueOnce(
      new Error("GitHub API error 405: Pull request is not mergeable"),
    );

    await expect(
      mergePr({
        prUrl: "https://github.com/acme/widgets/pull/42",
        mergeMethod: "merge",
      }),
    ).rejects.toThrow("GitHub API error 405");
  });
});

// ── reReview ────────────────────────────────────────────────────────

describe("reReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitPlatformForRepo.mockResolvedValue({
      platform: mockPlatform,
      ri: {
        platform: "github",
        host: "github.com",
        owner: "acme",
        repo: "widgets",
        apiBaseUrl: "https://api.github.com",
      },
    });
  });

  it("throws when no review draft found for task", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(reReview("task-no-draft")).rejects.toThrow("No review draft found for task");
  });
});

// ── markDraftStale ──────────────────────────────────────────────────

describe("markDraftStale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a ready draft as stale and publishes event", async () => {
    const staleDraft = { ...sampleDraft, state: "stale" };
    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([staleDraft]),
      }),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    const result = await markDraftStale("draft-1");

    expect(result).toEqual(staleDraft);
    expect(mockPublishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "review_draft:stale",
        taskId: "task-1",
      }),
    );
  });

  it("returns null when draft is not in ready state", async () => {
    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const result = await markDraftStale("draft-1");

    expect(result).toBeNull();
    expect(mockPublishEvent).not.toHaveBeenCalled();
  });
});
