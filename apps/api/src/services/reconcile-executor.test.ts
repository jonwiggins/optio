import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskState, WorkflowRunState } from "@optio/shared";
import type { Action, RepoAction, StandaloneAction, WorldSnapshot, Run } from "@optio/shared";

// ─── Mocks ───

const mockDbUpdate = vi.fn();
const mockTransitionTask = vi.fn();
const mockTaskQueueAdd = vi.fn();
const mockWorkflowQueueAdd = vi.fn();
const mockLaunchReview = vi.fn();
const mockMergePR = vi.fn();
const mockGetPlatform = vi.fn();
const mockPublishWorkflowRunEvent = vi.fn();
const mockEnqueueWebhookEvent = vi.fn();
const mockGetWorkflowRun = vi.fn();
const mockGetWorkflow = vi.fn();

function chainable(returning: unknown) {
  const obj: Record<string, unknown> = {};
  for (const m of ["set", "where"]) {
    obj[m] = vi.fn().mockReturnValue(obj);
  }
  obj.returning = vi.fn().mockResolvedValue(returning);
  return obj;
}

vi.mock("../db/client.js", () => ({
  db: {
    update: (...args: unknown[]) => mockDbUpdate(...args),
  },
}));

vi.mock("../db/schema.js", () => ({
  tasks: {
    id: "id",
    updatedAt: "updated_at",
    reconcileBackoffUntil: "reconcile_backoff_until",
    reconcileAttempts: "reconcile_attempts",
    errorMessage: "error_message",
  },
  workflowRuns: { id: "id", updatedAt: "updated_at", state: "state" },
  prReviews: {
    id: "id",
    updatedAt: "updated_at",
    reconcileBackoffUntil: "reconcile_backoff_until",
    reconcileAttempts: "reconcile_attempts",
    errorMessage: "error_message",
  },
}));

vi.mock("./task-service.js", () => ({
  transitionTask: (...args: unknown[]) => mockTransitionTask(...args),
}));

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: { add: (...args: unknown[]) => mockTaskQueueAdd(...args) },
}));

vi.mock("../workers/workflow-worker.js", () => ({
  workflowRunQueue: { add: (...args: unknown[]) => mockWorkflowQueueAdd(...args) },
}));

vi.mock("./review-service.js", () => ({
  launchReview: (...args: unknown[]) => mockLaunchReview(...args),
}));

vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: (...args: unknown[]) => mockGetPlatform(...args),
}));

vi.mock("./event-bus.js", () => ({
  publishWorkflowRunEvent: (...args: unknown[]) => mockPublishWorkflowRunEvent(...args),
}));

vi.mock("../workers/webhook-worker.js", () => ({
  enqueueWebhookEvent: (...args: unknown[]) => mockEnqueueWebhookEvent(...args),
}));

vi.mock("./workflow-service.js", () => ({
  getWorkflowRun: (...args: unknown[]) => mockGetWorkflowRun(...args),
  getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
}));

const mockEnqueueReconcile = vi.fn().mockResolvedValue(undefined);

vi.mock("./reconcile-queue.js", () => ({
  enqueueReconcile: (...args: unknown[]) => mockEnqueueReconcile(...args),
}));

vi.mock("../logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    warn: vi.fn(),
  },
}));

// Import AFTER mocks
import { executeAction } from "./reconcile-executor.js";
import { GitHubApiError } from "./git-platform/github.js";

// ─── Fixtures ───

const BASE_VERSION = new Date("2026-04-17T12:00:00Z");
const NOW = new Date("2026-04-17T12:05:00Z");

function repoSnapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  const run: Run = {
    kind: "repo",
    ref: { kind: "repo", id: "task-1" },
    spec: {
      repoUrl: "https://github.com/acme/repo",
      repoBranch: "main",
      agentType: "claude-code",
      prompt: "fix",
      title: "Fix",
      taskType: "coding",
      maxRetries: 3,
      priority: 100,
      ignoreOffPeak: false,
      parentTaskId: null,
      blocksParent: false,
      workspaceId: "ws-1",
      workflowRunId: null,
    },
    status: {
      state: TaskState.QUEUED,
      prUrl: null,
      prNumber: null,
      prState: null,
      prChecksStatus: null,
      prReviewStatus: null,
      prReviewComments: null,
      containerId: null,
      sessionId: null,
      worktreeState: null,
      lastPodId: null,
      lastActivityAt: null,
      retryCount: 0,
      errorMessage: null,
      costUsd: null,
      startedAt: null,
      completedAt: null,
      controlIntent: null,
      reconcileBackoffUntil: null,
      reconcileAttempts: 0,
      updatedAt: BASE_VERSION,
    },
  };
  return {
    now: NOW,
    run,
    pod: null,
    pr: null,
    dependencies: [],
    blockingSubtasks: [],
    capacity: { global: { running: 0, max: 5 } },
    heartbeat: { lastActivityAt: null, isStale: false, silentForMs: 0 },
    settings: {
      stallThresholdMs: 300_000,
      autoMerge: false,
      cautiousMode: false,
      autoResume: false,
      reviewEnabled: false,
      reviewTrigger: null,
      offPeakOnly: false,
      offPeakActive: false,
      hasReviewSubtask: false,
      maxAutoResumes: 10,
      recentAutoResumeCount: 0,
    },
    readErrors: [],
    ...overrides,
  };
}

function standaloneSnapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  const run: Run = {
    kind: "standalone",
    ref: { kind: "standalone", id: "run-1" },
    spec: {
      workflowId: "wf-1",
      workflowEnabled: true,
      agentRuntime: "claude-code",
      promptRendered: "do",
      params: null,
      maxConcurrent: 5,
      maxRetries: 3,
      workspaceId: "ws-1",
    },
    status: {
      state: WorkflowRunState.QUEUED,
      costUsd: null,
      errorMessage: null,
      sessionId: null,
      podName: null,
      retryCount: 0,
      startedAt: null,
      finishedAt: null,
      controlIntent: null,
      reconcileBackoffUntil: null,
      reconcileAttempts: 0,
      updatedAt: BASE_VERSION,
    },
  };
  return {
    now: NOW,
    run,
    pod: null,
    pr: null,
    dependencies: [],
    blockingSubtasks: [],
    capacity: { global: { running: 0, max: 5 } },
    heartbeat: { lastActivityAt: null, isStale: false, silentForMs: 0 },
    settings: {
      stallThresholdMs: 300_000,
      autoMerge: false,
      cautiousMode: false,
      autoResume: false,
      reviewEnabled: false,
      reviewTrigger: null,
      offPeakOnly: false,
      offPeakActive: false,
      hasReviewSubtask: false,
      maxAutoResumes: 0,
      recentAutoResumeCount: 0,
    },
    readErrors: [],
    ...overrides,
  };
}

// ─── Tests ───

describe("reconcile-executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("simple actions", () => {
    it("noop → skipped", async () => {
      const outcome = await executeAction({ kind: "noop", reason: "idle" }, repoSnapshot());
      expect(outcome.status).toBe("skipped");
      expect(outcome.reason).toBe("idle");
    });

    it("requeueSoon → skipped (worker re-enqueues)", async () => {
      const action: Action = {
        kind: "requeueSoon",
        delayMs: 10_000,
        reason: "capacity",
      };
      const outcome = await executeAction(action, repoSnapshot());
      expect(outcome.status).toBe("skipped");
      expect(mockDbUpdate).not.toHaveBeenCalled();
    });
  });

  describe("deferWithBackoff", () => {
    it("writes backoff_until and increments attempts for repo runs", async () => {
      const chain = chainable([{ id: "task-1" }]);
      mockDbUpdate.mockReturnValue(chain);

      const action: Action = {
        kind: "deferWithBackoff",
        untilMs: NOW.getTime() + 60_000,
        reason: "github_timeout",
      };
      const outcome = await executeAction(action, repoSnapshot());
      expect(outcome.status).toBe("applied");
      expect(chain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          reconcileBackoffUntil: expect.any(Date),
          reconcileAttempts: 1,
        }),
      );
    });

    it("returns stale when CAS fails", async () => {
      mockDbUpdate.mockReturnValue(chainable([]));
      const action: Action = {
        kind: "deferWithBackoff",
        untilMs: NOW.getTime() + 60_000,
        reason: "x",
      };
      const outcome = await executeAction(action, repoSnapshot());
      expect(outcome.status).toBe("stale");
    });
  });

  describe("repo transition", () => {
    it("applies patch + transitionTask on success", async () => {
      const chain = chainable([{ id: "task-1" }]);
      mockDbUpdate.mockReturnValue(chain);
      mockTransitionTask.mockResolvedValue({ id: "task-1", state: "cancelled" });

      const action: RepoAction = {
        kind: "transition",
        to: TaskState.CANCELLED,
        statusPatch: { errorMessage: "Cancelled by user" },
        clearControlIntent: true,
        trigger: "user_cancel",
        reason: "control_intent=cancel",
      };
      const outcome = await executeAction(action, repoSnapshot());
      expect(outcome.status).toBe("applied");
      expect(mockTransitionTask).toHaveBeenCalledWith(
        "task-1",
        TaskState.CANCELLED,
        "user_cancel",
        expect.any(String),
      );
    });

    it("bails before transitionTask when pre-patch CAS fails", async () => {
      mockDbUpdate.mockReturnValue(chainable([]));
      const action: RepoAction = {
        kind: "transition",
        to: TaskState.FAILED,
        statusPatch: { errorMessage: "oops" },
        trigger: "pr_closed",
        reason: "pr_closed",
      };
      const outcome = await executeAction(action, repoSnapshot());
      expect(outcome.status).toBe("stale");
      expect(mockTransitionTask).not.toHaveBeenCalled();
    });

    it("maps StateRaceError from transitionTask to stale", async () => {
      mockDbUpdate.mockReturnValue(chainable([{ id: "task-1" }]));
      mockTransitionTask.mockRejectedValue(new Error("StateRaceError: queued -> running"));

      const action: RepoAction = {
        kind: "transition",
        to: TaskState.RUNNING,
        trigger: "claim",
        reason: "claim",
      };
      const outcome = await executeAction(action, repoSnapshot());
      expect(outcome.status).toBe("stale");
    });
  });

  describe("standalone transition", () => {
    it("applies state + patch + CAS and publishes event", async () => {
      const chain = chainable([{ id: "run-1" }]);
      mockDbUpdate.mockReturnValue(chain);
      mockGetWorkflowRun.mockResolvedValue({
        id: "run-1",
        state: WorkflowRunState.FAILED,
        params: null,
        output: null,
        retryCount: 0,
        startedAt: null,
        finishedAt: null,
      });
      mockGetWorkflow.mockResolvedValue({ id: "wf-1", name: "Test workflow" });

      const action: StandaloneAction = {
        kind: "transition",
        to: WorkflowRunState.FAILED,
        statusPatch: { errorMessage: "Cancelled by user" },
        clearControlIntent: true,
        trigger: "user_cancel",
        reason: "cancel",
      };
      const outcome = await executeAction(action, standaloneSnapshot());
      expect(outcome.status).toBe("applied");
      expect(mockPublishWorkflowRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "workflow_run:state_changed",
          workflowRunId: "run-1",
          fromState: WorkflowRunState.QUEUED,
          toState: WorkflowRunState.FAILED,
        }),
      );
      expect(mockEnqueueWebhookEvent).toHaveBeenCalledWith(
        "workflow_run.failed",
        expect.objectContaining({ runId: "run-1", workflowId: "wf-1" }),
      );
    });

    it("returns stale when CAS finds newer row", async () => {
      mockDbUpdate.mockReturnValue(chainable([]));
      const action: StandaloneAction = {
        kind: "transition",
        to: WorkflowRunState.RUNNING,
        trigger: "claim",
        reason: "claim",
      };
      const outcome = await executeAction(action, standaloneSnapshot());
      expect(outcome.status).toBe("stale");
      expect(mockPublishWorkflowRunEvent).not.toHaveBeenCalled();
    });

    it("schedules a delayed reconcile when statusPatch carries a future backoff", async () => {
      mockDbUpdate.mockReturnValue(chainable([{ id: "run-1" }]));
      mockGetWorkflowRun.mockResolvedValue({
        id: "run-1",
        state: WorkflowRunState.QUEUED,
        params: null,
        output: null,
        retryCount: 1,
        startedAt: null,
        finishedAt: null,
      });
      mockGetWorkflow.mockResolvedValue({ id: "wf-1", name: "wf" });

      // scheduleBackoffReconcile uses Date.now(), not the snapshot's NOW,
      // so the backoff must be in the real wall-clock future.
      const futureBackoff = new Date(Date.now() + 30_000);
      const action: StandaloneAction = {
        kind: "transition",
        to: WorkflowRunState.QUEUED,
        statusPatch: {
          retryCount: 1,
          errorMessage: null,
          reconcileBackoffUntil: futureBackoff,
        },
        trigger: "auto_retry",
        reason: "auto_retry_1/3",
      };
      await executeAction(action, standaloneSnapshot());
      expect(mockEnqueueReconcile).toHaveBeenCalledWith(
        { kind: "standalone", id: "run-1" },
        expect.objectContaining({
          reason: "backoff_expired",
          delayMs: expect.any(Number),
        }),
      );
    });
  });

  describe("requeueForAgent", () => {
    it("enqueues to taskQueue without state change", async () => {
      const action: RepoAction = {
        kind: "requeueForAgent",
        trigger: "reconcile_queued",
        reason: "queued_capacity_available",
      };
      const outcome = await executeAction(action, repoSnapshot());
      expect(outcome.status).toBe("applied");
      expect(mockTaskQueueAdd).toHaveBeenCalledWith(
        "process-task",
        { taskId: "task-1" },
        expect.objectContaining({ priority: 100 }),
      );
      expect(mockTransitionTask).not.toHaveBeenCalled();
    });

    it("applies statusPatch CAS-gated before enqueueing", async () => {
      const chain = chainable([{ id: "task-1" }]);
      mockDbUpdate.mockReturnValue(chain);
      const action: RepoAction = {
        kind: "requeueForAgent",
        statusPatch: { lastActivityAt: NOW },
        trigger: "x",
        reason: "x",
      };
      const outcome = await executeAction(action, repoSnapshot());
      expect(outcome.status).toBe("applied");
      expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({ lastActivityAt: NOW }));
      expect(mockTaskQueueAdd).toHaveBeenCalled();
    });
  });

  describe("enqueueAgent", () => {
    it("enqueues to workflowRunQueue", async () => {
      const action: StandaloneAction = {
        kind: "enqueueAgent",
        trigger: "reconcile_queued",
        reason: "queued_capacity_available",
      };
      const outcome = await executeAction(action, standaloneSnapshot());
      expect(outcome.status).toBe("applied");
      expect(mockWorkflowQueueAdd).toHaveBeenCalledWith(
        "process-workflow-run",
        { workflowRunId: "run-1" },
        expect.any(Object),
      );
    });
  });

  describe("launchReview", () => {
    it("calls launchReview with task id", async () => {
      mockLaunchReview.mockResolvedValue("review-task-id");
      const action: RepoAction = { kind: "launchReview", reason: "ci_pass" };
      const outcome = await executeAction(action, repoSnapshot());
      expect(outcome.status).toBe("applied");
      expect(mockLaunchReview).toHaveBeenCalledWith("task-1");
    });

    it("surfaces review-service errors", async () => {
      mockLaunchReview.mockRejectedValue(new Error("PR not found"));
      const action: RepoAction = { kind: "launchReview", reason: "ci_pass" };
      const outcome = await executeAction(action, repoSnapshot());
      expect(outcome.status).toBe("error");
    });
  });

  describe("autoMergePr", () => {
    it("merges and transitions to COMPLETED on success", async () => {
      mockGetPlatform.mockResolvedValue({
        platform: { mergePullRequest: mockMergePR },
        ri: { owner: "acme", repo: "repo" },
      });
      mockMergePR.mockResolvedValue(undefined);
      const chain = chainable([{ id: "task-1" }]);
      mockDbUpdate.mockReturnValue(chain);
      mockTransitionTask.mockResolvedValue({ id: "task-1" });

      const snap = repoSnapshot();
      if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
      snap.run.status.prUrl = "https://github.com/acme/repo/pull/42";
      snap.run.status.state = TaskState.PR_OPENED;

      const action: RepoAction = { kind: "autoMergePr", reason: "auto_merge_ready" };
      const outcome = await executeAction(action, snap);
      expect(outcome.status).toBe("applied");
      expect(mockMergePR).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "acme" }),
        42,
        "squash",
      );
      expect(mockTransitionTask).toHaveBeenCalledWith(
        "task-1",
        TaskState.COMPLETED,
        "auto_merged",
        expect.any(String),
      );
    });

    it("returns error when merge throws", async () => {
      mockGetPlatform.mockResolvedValue({
        platform: { mergePullRequest: mockMergePR },
        ri: { owner: "acme", repo: "repo" },
      });
      mockMergePR.mockRejectedValue(new Error("Merge conflict"));

      const snap = repoSnapshot();
      if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
      snap.run.status.prUrl = "https://github.com/acme/repo/pull/42";

      const action: RepoAction = { kind: "autoMergePr", reason: "auto_merge_ready" };
      const outcome = await executeAction(action, snap);
      expect(outcome.status).toBe("error");
      expect(mockTransitionTask).not.toHaveBeenCalled();
    });

    it("persists a cooldown and does not transition on a secondary rate limit", async () => {
      mockGetPlatform.mockResolvedValue({
        platform: { mergePullRequest: mockMergePR },
        ri: { owner: "acme", repo: "repo" },
      });
      mockMergePR.mockRejectedValue(
        new GitHubApiError(403, "You have exceeded a secondary rate limit", {
          retryAfterMs: 120000,
        }),
      );
      const chain = chainable([{ id: "task-1" }]);
      mockDbUpdate.mockReturnValue(chain);

      const snap = repoSnapshot();
      if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
      snap.run.status.prUrl = "https://github.com/acme/repo/pull/42";
      snap.run.status.state = TaskState.PR_OPENED;

      const outcome = await executeAction(
        { kind: "autoMergePr", reason: "auto_merge_ready" },
        snap,
      );

      // Applied (not error) so the worker won't fast-retry; run NOT advanced.
      expect(outcome.status).toBe("applied");
      expect(outcome.reason).toContain("github_cooldown");
      expect(mockTransitionTask).not.toHaveBeenCalled();
      expect(chain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          reconcileBackoffUntil: expect.anything(),
          errorMessage: expect.stringContaining("secondary rate limit"),
        }),
      );
      // Single delayed wake honoring Retry-After (>=120s).
      const enqueueArgs = mockEnqueueReconcile.mock.calls.at(-1)?.[1] as { delayMs: number };
      expect(enqueueArgs.delayMs).toBeGreaterThanOrEqual(120000);
    });

    it("persists a long cooldown for an auth (bad credentials) failure", async () => {
      mockGetPlatform.mockResolvedValue({
        platform: { mergePullRequest: mockMergePR },
        ri: { owner: "acme", repo: "repo" },
      });
      mockMergePR.mockRejectedValue(new GitHubApiError(401, '{"message":"Bad credentials"}'));
      mockDbUpdate.mockReturnValue(chainable([{ id: "task-1" }]));

      const snap = repoSnapshot();
      if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
      snap.run.status.prUrl = "https://github.com/acme/repo/pull/42";
      snap.run.status.state = TaskState.PR_OPENED;

      const outcome = await executeAction(
        { kind: "autoMergePr", reason: "auto_merge_ready" },
        snap,
      );
      expect(outcome.status).toBe("applied");
      expect(outcome.reason).toContain("github_cooldown:auth");
      expect(mockTransitionTask).not.toHaveBeenCalled();
      const enqueueArgs = mockEnqueueReconcile.mock.calls.at(-1)?.[1] as { delayMs: number };
      expect(enqueueArgs.delayMs).toBeGreaterThanOrEqual(60_000);
    });
  });

  describe("resumeAgent", () => {
    it("transitions through NEEDS_ATTENTION → QUEUED and enqueues with prompt", async () => {
      mockTransitionTask.mockResolvedValue({ id: "task-1" });
      const snap = repoSnapshot();
      if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
      snap.run.status.state = TaskState.PR_OPENED;
      snap.run.status.prUrl = "https://github.com/acme/repo/pull/42";
      snap.run.status.sessionId = "sess-99";

      const action: RepoAction = {
        kind: "resumeAgent",
        resumeReason: "ci_failure",
        reason: "ci_failing_auto_resume",
      };
      const outcome = await executeAction(action, snap);
      expect(outcome.status).toBe("applied");
      expect(mockTransitionTask).toHaveBeenNthCalledWith(
        1,
        "task-1",
        TaskState.NEEDS_ATTENTION,
        "ci_failing",
        expect.stringContaining("CI checks are failing"),
      );
      expect(mockTransitionTask).toHaveBeenNthCalledWith(
        2,
        "task-1",
        TaskState.QUEUED,
        "auto_resume_ci-fix",
      );
      expect(mockTaskQueueAdd).toHaveBeenCalledWith(
        "process-task",
        expect.objectContaining({
          taskId: "task-1",
          resumeSessionId: "sess-99",
          resumePrompt: expect.stringContaining("CI checks are failing"),
        }),
        expect.any(Object),
      );
    });

    it("uses fresh session for conflicts (no resumeSessionId)", async () => {
      mockTransitionTask.mockResolvedValue({ id: "task-1" });
      const snap = repoSnapshot();
      if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
      snap.run.status.state = TaskState.PR_OPENED;
      snap.run.status.prUrl = "https://github.com/acme/repo/pull/42";
      snap.run.status.sessionId = "sess-99";

      const action: RepoAction = {
        kind: "resumeAgent",
        resumeReason: "conflicts",
        reason: "pr_conflicts_auto_resume",
      };
      const outcome = await executeAction(action, snap);
      expect(outcome.status).toBe("applied");
      expect(mockTaskQueueAdd).toHaveBeenCalledWith(
        "process-task",
        expect.objectContaining({ resumeSessionId: undefined }),
        expect.any(Object),
      );
    });
  });

  describe("error paths", () => {
    it("DB exception produces error outcome", async () => {
      mockDbUpdate.mockImplementation(() => {
        throw new Error("db connection lost");
      });

      const action: Action = {
        kind: "deferWithBackoff",
        untilMs: NOW.getTime() + 60_000,
        reason: "x",
      };
      const outcome = await executeAction(action, repoSnapshot());
      expect(outcome.status).toBe("error");
    });
  });
});
