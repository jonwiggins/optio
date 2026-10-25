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
const mockReadPR = vi.fn();
const mockReadChecks = vi.fn();
const mockReadReviews = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisGet = vi.fn();
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
  getRedisClient: () => ({ set: mockRedisSet, get: mockRedisGet }),
  publishWorkflowRunEvent: (...args: unknown[]) => mockPublishWorkflowRunEvent(...args),
}));

vi.mock("../workers/webhook-worker.js", () => ({
  enqueueWebhookEvent: (...args: unknown[]) => mockEnqueueWebhookEvent(...args),
}));

const mockTransitionWorkflowRunCas = vi.fn();
vi.mock("./workflow-service.js", () => ({
  getWorkflowRun: (...args: unknown[]) => mockGetWorkflowRun(...args),
  getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
  transitionWorkflowRunCas: (...args: unknown[]) => mockTransitionWorkflowRunCas(...args),
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
    debug: vi.fn(),
  },
}));

// Import AFTER mocks
import { executeAction } from "./reconcile-executor.js";
import { GitHubApiError } from "./git-platform/github.js";
import { GitLabApiError, GitLabNotReadyError } from "./git-platform/gitlab.js";

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
      runTarget: "cluster",
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
      runTarget: "cluster",
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
    it("goes through the one Job-run transition, CAS'd on the observed state and version", async () => {
      mockTransitionWorkflowRunCas.mockResolvedValue({ id: "run-1", state: "failed" });
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
      expect(mockTransitionWorkflowRunCas).toHaveBeenCalledWith(
        "run-1",
        WorkflowRunState.QUEUED,
        WorkflowRunState.FAILED,
        {
          reconcileBackoffUntil: null,
          reconcileAttempts: 0,
          errorMessage: "Cancelled by user",
          controlIntent: null,
        },
        { version: BASE_VERSION, wakeReconciler: false },
      );
    });

    it("returns stale when the transition finds a newer row", async () => {
      mockTransitionWorkflowRunCas.mockResolvedValue(null);
      const action: StandaloneAction = {
        kind: "transition",
        to: WorkflowRunState.RUNNING,
        trigger: "claim",
        reason: "claim",
      };
      const outcome = await executeAction(action, standaloneSnapshot());
      expect(outcome.status).toBe("stale");
      expect(mockEnqueueReconcile).not.toHaveBeenCalled();
    });

    it("schedules a delayed reconcile when statusPatch carries a future backoff", async () => {
      mockTransitionWorkflowRunCas.mockResolvedValue({ id: "run-1", state: "queued" });
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
    beforeEach(() => {
      mockReadPR.mockResolvedValue({ headSha: "checked-head", state: "open", merged: false });
      mockReadChecks.mockResolvedValue([{ status: "completed", conclusion: "success" }]);
      mockReadReviews.mockResolvedValue([]);
    });

    function mergeSnapshot() {
      const snap = repoSnapshot({
        settings: { ...repoSnapshot().settings, autoMerge: true, autoMergeConfirmed: true },
        pr: {
          url: "https://github.com/acme/repo/pull/42",
          number: 42,
          state: "open",
          merged: false,
          mergeable: true,
          checksStatus: "passing",
          reviewStatus: "none",
          latestReviewComments: null,
          headSha: "checked-head",
        },
      });
      if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
      snap.run.status.prUrl = snap.pr!.url;
      snap.run.status.state = TaskState.PR_OPENED;
      return snap;
    }

    it.each(["pending", "failing"])(
      "defers when CI becomes %s after the snapshot",
      async (state) => {
        mockGetPlatform.mockResolvedValue({
          platform: {
            type: "github",
            mergePullRequest: mockMergePR,
            getPullRequest: mockReadPR,
            getCIChecks: mockReadChecks,
            getReviews: mockReadReviews,
          },
          ri: { owner: "acme", repo: "repo" },
        });
        mockReadChecks.mockResolvedValue([
          { status: state === "pending" ? "queued" : "completed", conclusion: "failure" },
        ]);
        const outcome = await executeAction(
          { kind: "autoMergePr", reason: "auto_merge_ready" },
          mergeSnapshot(),
        );
        expect(outcome).toEqual({ status: "stale", reason: `pr_checks_${state}` });
        expect(mockMergePR).not.toHaveBeenCalled();
        expect(mockTransitionTask).not.toHaveBeenCalled();
      },
    );

    it("does not merge when the CI recheck fails", async () => {
      mockGetPlatform.mockResolvedValue({
        platform: {
          type: "github",
          mergePullRequest: mockMergePR,
          getPullRequest: mockReadPR,
          getCIChecks: mockReadChecks,
          getReviews: mockReadReviews,
        },
        ri: { owner: "acme", repo: "repo" },
      });
      mockReadChecks.mockRejectedValue(new Error("CI unavailable"));
      const outcome = await executeAction(
        { kind: "autoMergePr", reason: "auto_merge_ready" },
        mergeSnapshot(),
      );
      expect(outcome.status).toBe("error");
      expect(mockMergePR).not.toHaveBeenCalled();
      expect(mockTransitionTask).not.toHaveBeenCalled();
    });

    it("reconciles a new push instead of merging the unchecked head", async () => {
      mockGetPlatform.mockResolvedValue({
        platform: {
          type: "github",
          mergePullRequest: mockMergePR,
          getPullRequest: mockReadPR,
          getCIChecks: mockReadChecks,
          getReviews: mockReadReviews,
        },
        ri: { owner: "acme", repo: "repo" },
      });
      mockReadPR.mockResolvedValue({ headSha: "new-head", state: "open", merged: false });
      const outcome = await executeAction(
        { kind: "autoMergePr", reason: "auto_merge_ready" },
        mergeSnapshot(),
      );
      expect(outcome).toEqual({ status: "stale", reason: "pr_head_changed" });
      expect(mockReadChecks).not.toHaveBeenCalled();
      expect(mockMergePR).not.toHaveBeenCalled();
    });

    it("waits on the first empty check result and schedules another pass", async () => {
      mockGetPlatform.mockResolvedValue({
        platform: {
          type: "github",
          mergePullRequest: mockMergePR,
          getPullRequest: mockReadPR,
          getCIChecks: mockReadChecks,
          getReviews: mockReadReviews,
        },
        ri: { owner: "acme", repo: "repo" },
      });
      mockReadChecks.mockResolvedValue([]);
      mockRedisGet.mockImplementation(() => Promise.resolve(String(Date.now())));
      const outcome = await executeAction(
        { kind: "autoMergePr", reason: "auto_merge_ready" },
        mergeSnapshot(),
      );
      expect(outcome).toEqual({ status: "skipped", reason: "auto_merge_waiting_for_checks" });
      expect(mockMergePR).not.toHaveBeenCalled();
      expect(mockEnqueueReconcile).toHaveBeenCalledWith(
        { kind: "repo", id: "task-1" },
        {
          reason: "auto_merge_waiting_for_checks",
          delayMs: expect.any(Number),
        },
      );
    });

    it("keeps CodeCommit auto-merge immediate without CI", async () => {
      mockGetPlatform.mockResolvedValue({
        platform: {
          type: "codecommit",
          mergePullRequest: mockMergePR,
          getPullRequest: mockReadPR,
          getCIChecks: mockReadChecks,
          getReviews: mockReadReviews,
        },
        ri: { owner: "us-east-1", repo: "repo" },
      });
      mockReadChecks.mockResolvedValue([]);
      mockMergePR.mockResolvedValue(undefined);
      mockTransitionTask.mockResolvedValue({ id: "task-1" });
      mockDbUpdate.mockReturnValue(chainable([{ id: "task-1" }]));
      const outcome = await executeAction(
        { kind: "autoMergePr", reason: "auto_merge_ready" },
        mergeSnapshot(),
      );
      expect(outcome.status).toBe("applied");
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockMergePR).toHaveBeenCalled();
    });

    it("merges and transitions to COMPLETED on success", async () => {
      mockGetPlatform.mockResolvedValue({
        platform: {
          type: "github",
          mergePullRequest: mockMergePR,
          getPullRequest: mockReadPR,
          getCIChecks: mockReadChecks,
          getReviews: mockReadReviews,
        },
        ri: { owner: "acme", repo: "repo" },
      });
      mockMergePR.mockResolvedValue(undefined);
      const chain = chainable([{ id: "task-1" }]);
      mockDbUpdate.mockReturnValue(chain);
      mockTransitionTask.mockResolvedValue({ id: "task-1" });

      const snap = mergeSnapshot();
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
        "checked-head",
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
        platform: {
          type: "github",
          mergePullRequest: mockMergePR,
          getPullRequest: mockReadPR,
          getCIChecks: mockReadChecks,
          getReviews: mockReadReviews,
        },
        ri: { owner: "acme", repo: "repo" },
      });
      mockMergePR.mockRejectedValue(new Error("Merge conflict"));

      const snap = mergeSnapshot();
      if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
      snap.run.status.prUrl = "https://github.com/acme/repo/pull/42";

      const action: RepoAction = { kind: "autoMergePr", reason: "auto_merge_ready" };
      const outcome = await executeAction(action, snap);
      expect(outcome.status).toBe("error");
      expect(mockTransitionTask).not.toHaveBeenCalled();
    });

    it("persists a cooldown and does not transition on a secondary rate limit", async () => {
      mockGetPlatform.mockResolvedValue({
        platform: {
          type: "github",
          mergePullRequest: mockMergePR,
          getPullRequest: mockReadPR,
          getCIChecks: mockReadChecks,
          getReviews: mockReadReviews,
        },
        ri: { owner: "acme", repo: "repo" },
      });
      mockMergePR.mockRejectedValue(
        new GitHubApiError(403, "You have exceeded a secondary rate limit", {
          retryAfterMs: 120000,
        }),
      );
      const chain = chainable([{ id: "task-1" }]);
      mockDbUpdate.mockReturnValue(chain);

      const snap = mergeSnapshot();
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
        platform: {
          type: "github",
          mergePullRequest: mockMergePR,
          getPullRequest: mockReadPR,
          getCIChecks: mockReadChecks,
          getReviews: mockReadReviews,
        },
        ri: { owner: "acme", repo: "repo" },
      });
      mockMergePR.mockRejectedValue(new GitHubApiError(401, '{"message":"Bad credentials"}'));
      mockDbUpdate.mockReturnValue(chainable([{ id: "task-1" }]));

      const snap = mergeSnapshot();
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

    it("holds the run on a GitLab rate limit until GitLab's reset, and on a refused token", async () => {
      mockGetPlatform.mockResolvedValue({
        platform: {
          type: "gitlab",
          mergePullRequest: mockMergePR,
          getPullRequest: mockReadPR,
          getCIChecks: mockReadChecks,
          getReviews: mockReadReviews,
        },
        ri: { owner: "acme", repo: "repo" },
      });
      const resetAt = Date.now() + 300_000;
      mockMergePR.mockRejectedValueOnce(
        new GitLabApiError(429, "Retry later", { rateLimitResetMs: resetAt }),
      );
      const chain = chainable([{ id: "task-1" }]);
      mockDbUpdate.mockReturnValue(chain);

      const snap = mergeSnapshot();
      if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
      snap.run.status.prUrl = "https://gitlab.com/acme/repo/-/merge_requests/42";
      snap.run.status.state = TaskState.PR_OPENED;

      const limited = await executeAction(
        { kind: "autoMergePr", reason: "auto_merge_ready" },
        snap,
      );
      expect(limited).toMatchObject({
        status: "applied",
        reason: "gitlab_cooldown:primary_rate_limit",
      });
      expect(mockTransitionTask).not.toHaveBeenCalled();
      const wait = mockEnqueueReconcile.mock.calls.at(-1)?.[1] as { delayMs: number };
      expect(wait.delayMs).toBeGreaterThan(250_000);

      mockMergePR.mockRejectedValueOnce(new GitLabApiError(403, '{"message":"403 Forbidden"}'));
      const refused = await executeAction(
        { kind: "autoMergePr", reason: "auto_merge_ready" },
        snap,
      );
      expect(refused.reason).toBe("gitlab_cooldown:permission");
      expect(chain.set).toHaveBeenCalledWith(
        expect.objectContaining({ errorMessage: expect.stringContaining("GitLab API error 403") }),
      );
    });

    describe("never merges what a person didn't confirm or a reviewer blocked", () => {
      function github() {
        mockGetPlatform.mockResolvedValue({
          platform: {
            type: "github",
            mergePullRequest: mockMergePR,
            getPullRequest: mockReadPR,
            getCIChecks: mockReadChecks,
            getReviews: mockReadReviews,
          },
          ri: { owner: "acme", repo: "repo" },
        });
      }

      it.each([
        ["unconfirmed", { autoMerge: true, autoMergeConfirmed: false }],
        ["confirmation unknown", { autoMerge: true, autoMergeConfirmed: undefined }],
        ["off", { autoMerge: false, autoMergeConfirmed: true }],
        ["cautious mode", { autoMerge: true, autoMergeConfirmed: true, cautiousMode: true }],
      ])("skips a setting that is %s without asking the platform", async (_label, patch) => {
        github();
        const snap = mergeSnapshot();
        snap.settings = { ...snap.settings, ...patch };
        const outcome = await executeAction(
          { kind: "autoMergePr", reason: "auto_merge_ready" },
          snap,
        );
        expect(outcome).toEqual({ status: "skipped", reason: "auto_merge_not_confirmed" });
        expect(mockGetPlatform).not.toHaveBeenCalled();
        expect(mockMergePR).not.toHaveBeenCalled();
      });

      it("skips when a reviewer requested changes, even after someone else approved", async () => {
        github();
        mockReadReviews.mockResolvedValue([
          { author: "ann", state: "CHANGES_REQUESTED", body: "fix it" },
          { author: "bob", state: "APPROVED", body: "" },
          { author: "ann", state: "COMMENTED", body: "still broken" },
        ]);
        const outcome = await executeAction(
          { kind: "autoMergePr", reason: "auto_merge_ready" },
          mergeSnapshot(),
        );
        expect(outcome).toEqual({ status: "skipped", reason: "pr_changes_requested" });
        expect(mockMergePR).not.toHaveBeenCalled();
        expect(mockTransitionTask).not.toHaveBeenCalled();
      });

      it("merges once the reviewer who asked for changes approves", async () => {
        github();
        mockReadReviews.mockResolvedValue([
          { author: "ann", state: "CHANGES_REQUESTED", body: "fix it" },
          { author: "ann", state: "APPROVED", body: "" },
        ]);
        mockMergePR.mockResolvedValue(undefined);
        mockDbUpdate.mockReturnValue(chainable([{ id: "task-1" }]));
        mockTransitionTask.mockResolvedValue({ id: "task-1" });
        const outcome = await executeAction(
          { kind: "autoMergePr", reason: "auto_merge_ready" },
          mergeSnapshot(),
        );
        expect(outcome.status).toBe("applied");
        expect(mockMergePR).toHaveBeenCalled();
      });

      it.each([
        ["a draft", { draft: true }, "pr_draft"],
        ["not mergeable", { mergeable: false }, "pr_not_mergeable"],
      ])("skips a PR that is %s", async (_label, patch, reason) => {
        github();
        mockReadPR.mockResolvedValue({
          headSha: "checked-head",
          state: "open",
          merged: false,
          ...patch,
        });
        const outcome = await executeAction(
          { kind: "autoMergePr", reason: "auto_merge_ready" },
          mergeSnapshot(),
        );
        expect(outcome).toEqual({ status: "skipped", reason });
        expect(mockMergePR).not.toHaveBeenCalled();
      });

      it("does not merge when the reviews can't be read", async () => {
        github();
        mockReadReviews.mockRejectedValue(new Error("reviews unavailable"));
        const outcome = await executeAction(
          { kind: "autoMergePr", reason: "auto_merge_ready" },
          mergeSnapshot(),
        );
        expect(outcome.status).toBe("error");
        expect(mockMergePR).not.toHaveBeenCalled();
      });
    });

    describe("a GitLab MR that isn't ready to merge yet", () => {
      function gitlab() {
        mockGetPlatform.mockResolvedValue({
          platform: {
            type: "gitlab",
            mergePullRequest: mockMergePR,
            getPullRequest: mockReadPR,
            getCIChecks: mockReadChecks,
            getReviews: mockReadReviews,
          },
          ri: { owner: "acme", repo: "repo" },
        });
      }
      function gitlabSnapshot(attempts = 0) {
        const snap = mergeSnapshot();
        if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
        snap.run.status.prUrl = "https://gitlab.com/acme/repo/-/merge_requests/42";
        snap.run.status.reconcileAttempts = attempts;
        return snap;
      }

      it("a 405 that polling didn't clear waits and tries again — not an error", async () => {
        gitlab();
        mockMergePR.mockRejectedValue(new GitLabNotReadyError("checking"));
        const chain = chainable([{ id: "task-1" }]);
        mockDbUpdate.mockReturnValue(chain);
        const outcome = await executeAction(
          { kind: "autoMergePr", reason: "auto_merge_ready" },
          gitlabSnapshot(),
        );
        expect(outcome).toEqual({ status: "skipped", reason: "auto_merge_mr_not_ready" });
        expect(mockEnqueueReconcile).toHaveBeenLastCalledWith(
          { kind: "repo", id: "task-1" },
          { reason: "auto_merge_mr_not_ready", delayMs: 15_000 },
        );
        expect(chain.set).toHaveBeenCalledWith({ reconcileAttempts: expect.anything() });
        expect(mockTransitionTask).not.toHaveBeenCalled();
      });

      it("an MR GitLab is still checking isn't merged at all yet", async () => {
        gitlab();
        mockReadPR.mockResolvedValue({
          headSha: "checked-head",
          state: "open",
          merged: false,
          mergeable: null,
          mergeStatus: "unchecked",
        });
        mockDbUpdate.mockReturnValue(chainable([{ id: "task-1" }]));
        const outcome = await executeAction(
          { kind: "autoMergePr", reason: "auto_merge_ready" },
          gitlabSnapshot(),
        );
        expect(outcome).toEqual({ status: "skipped", reason: "auto_merge_mr_not_ready" });
        expect(mockMergePR).not.toHaveBeenCalled();
      });

      it("a blocker only a person clears asks a person at once", async () => {
        gitlab();
        mockMergePR.mockRejectedValue(new GitLabNotReadyError("not_approved"));
        mockTransitionTask.mockResolvedValue({ id: "task-1" });
        const outcome = await executeAction(
          { kind: "autoMergePr", reason: "auto_merge_ready" },
          gitlabSnapshot(0),
        );
        expect(outcome).toEqual({
          status: "applied",
          reason: "auto_merge_not_ready_needs_attention",
        });
        expect(mockTransitionTask).toHaveBeenCalledWith(
          "task-1",
          TaskState.NEEDS_ATTENTION,
          "auto_merge_not_ready",
          expect.stringContaining("(not_approved)"),
        );
      });

      it("after 20 waits, asks a person instead of spinning", async () => {
        gitlab();
        mockMergePR.mockRejectedValue(new GitLabNotReadyError("conflict"));
        mockTransitionTask.mockResolvedValue({ id: "task-1" });
        const outcome = await executeAction(
          { kind: "autoMergePr", reason: "auto_merge_ready" },
          gitlabSnapshot(20),
        );
        expect(outcome).toEqual({
          status: "applied",
          reason: "auto_merge_not_ready_needs_attention",
        });
        expect(mockTransitionTask).toHaveBeenCalledWith(
          "task-1",
          TaskState.NEEDS_ATTENTION,
          "auto_merge_not_ready",
          expect.stringContaining("(conflict)"),
        );
        expect(mockEnqueueReconcile).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ reason: "auto_merge_mr_not_ready" }),
        );
      });
    });
  });

  describe("resumeAgent", () => {
    // The version re-check after the resume facts load (resume-facts.ts).
    beforeEach(() => {
      mockDbUpdate.mockReturnValue(chainable([{ id: "task-1" }]));
    });

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

    it("rebases onto the task's branch, not a fixed origin/main", async () => {
      // The MR can't be read here (no platform mocked): the task's own branch.
      mockTransitionTask.mockResolvedValue({ id: "task-1" });
      const snap = repoSnapshot();
      if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
      snap.run.spec.repoBranch = "master";
      snap.run.status.state = TaskState.PR_OPENED;
      snap.run.status.prUrl = "https://github.com/acme/repo/pull/42";

      await executeAction(
        { kind: "resumeAgent", resumeReason: "conflicts", reason: "pr_conflicts_auto_resume" },
        snap,
      );
      const prompt = mockTaskQueueAdd.mock.calls[0][1].resumePrompt as string;
      expect(prompt).toContain("git rebase origin/master");
      expect(prompt).not.toContain("origin/main");
    });

    it("is stale, not a second resume, when the task moved on while the facts loaded", async () => {
      // Another reconcile pass resumed the task while this one read GitLab:
      // the task's version no longer matches this pass's snapshot.
      mockDbUpdate.mockReturnValue(chainable([]));
      mockTransitionTask.mockResolvedValue({ id: "task-1" });
      const snap = repoSnapshot();
      if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
      snap.run.status.state = TaskState.PR_OPENED;
      snap.run.status.prUrl = "https://gitlab.example.com/acme/repo/-/merge_requests/42";

      const outcome = await executeAction(
        { kind: "resumeAgent", resumeReason: "ci_failure", reason: "ci_failing_auto_resume" },
        snap,
      );
      expect(outcome).toEqual({ status: "stale", reason: "cas_failed_resume" });
      expect(mockTransitionTask).not.toHaveBeenCalled();
      expect(mockTaskQueueAdd).not.toHaveBeenCalled();
    });

    it("says MR and glab for a merge request on a host not named gitlab", async () => {
      try {
        mockTransitionTask.mockResolvedValue({ id: "task-1" });
        const snap = repoSnapshot();
        if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
        snap.run.spec.repoUrl = "https://git.example.com/acme/repo";
        snap.run.status.state = TaskState.PR_OPENED;
        snap.run.status.prUrl = "https://git.example.com/acme/repo/-/merge_requests/42";

        await executeAction(
          { kind: "resumeAgent", resumeReason: "ci_failure", reason: "ci_failing_auto_resume" },
          snap,
        );
        const prompt = mockTaskQueueAdd.mock.calls[0][1].resumePrompt as string;
        expect(prompt).toContain("your MR");
        expect(prompt).toContain("glab ci status");
        expect(prompt).not.toContain("gh pr checks");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("says PR and gh for a pull request", async () => {
      try {
        mockTransitionTask.mockResolvedValue({ id: "task-1" });
        const snap = repoSnapshot();
        if (snap.run.kind !== "repo") throw new Error("fixture mismatch");
        snap.run.status.state = TaskState.PR_OPENED;
        snap.run.status.prUrl = "https://github.com/acme/gitlab-tools/pull/42";

        await executeAction(
          { kind: "resumeAgent", resumeReason: "ci_failure", reason: "ci_failing_auto_resume" },
          snap,
        );
        const prompt = mockTaskQueueAdd.mock.calls[0][1].resumePrompt as string;
        expect(prompt).toContain("your PR");
        expect(prompt).toContain("gh pr checks");
      } finally {
        vi.unstubAllEnvs();
      }
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

// ─── Run attachment (docs/plans/scale-out.md §2) ───

describe("reconcile-executor — reattach and requeueRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const reattach = (runId: string): Action => ({
    kind: "reattach",
    runId,
    attempt: 1_760_000_000_000,
    reason: "running_unattached",
  });

  it("reattach checks the version, then asks the kind's queue for one attach job per expiry", async () => {
    mockDbUpdate.mockReturnValueOnce(chainable([{ id: "task-1" }]));
    const snap = repoSnapshot();
    snap.run.status.state = TaskState.RUNNING;

    const outcome = await executeAction(reattach("task-1"), snap);

    expect(outcome).toEqual({
      status: "applied",
      reason: "reattach:attach__task-1__1760000000000",
    });
    expect(mockTaskQueueAdd).toHaveBeenCalledWith(
      "attach-task",
      { taskId: "task-1" },
      { jobId: "attach__task-1__1760000000000", removeOnComplete: true, removeOnFail: true },
    );
  });

  it("reattach from a stale snapshot enqueues nothing", async () => {
    mockDbUpdate.mockReturnValueOnce(chainable([]));
    const outcome = await executeAction(reattach("task-1"), repoSnapshot());
    expect(outcome.status).toBe("stale");
    expect(mockTaskQueueAdd).not.toHaveBeenCalled();
  });

  it("reattach writes nothing but the version it checks (updated_at = updated_at)", async () => {
    const chain = chainable([{ id: "task-1" }]);
    mockDbUpdate.mockReturnValueOnce(chain);
    await executeAction(reattach("task-1"), repoSnapshot());
    const set = (chain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(set)).toEqual(["updatedAt"]);
    expect(set.updatedAt).not.toBeInstanceOf(Date);
  });

  it("reattach of a Job run goes to the Job run queue", async () => {
    mockDbUpdate.mockReturnValueOnce(chainable([{ id: "run-1" }]));
    const outcome = await executeAction(reattach("run-1"), standaloneSnapshot());
    expect(outcome.status).toBe("applied");
    expect(mockWorkflowQueueAdd).toHaveBeenCalledWith(
      "attach-workflow-run",
      { workflowRunId: "run-1" },
      expect.objectContaining({ jobId: "attach__run-1__1760000000000" }),
    );
  });

  it("requeueRun puts a provisioning task back in the queue (the worker's provisioning retry)", async () => {
    mockDbUpdate.mockReturnValueOnce(chainable([{ id: "task-1" }]));
    mockTransitionTask.mockResolvedValueOnce({});
    const snap = repoSnapshot();
    snap.run.status.state = TaskState.PROVISIONING;

    const outcome = await executeAction(
      {
        kind: "requeueRun",
        runId: "task-1",
        trigger: "provisioning_interrupted",
        reason: "provisioning_unattached_never_started",
      },
      snap,
    );

    expect(outcome.status).toBe("applied");
    expect(mockTransitionTask).toHaveBeenCalledWith(
      "task-1",
      TaskState.QUEUED,
      "provisioning_interrupted",
      "provisioning_unattached_never_started",
    );
  });

  it("requeueRun takes a Job run through failed back to queued without spending a retry", async () => {
    mockTransitionWorkflowRunCas.mockResolvedValueOnce({ id: "run-1" });
    mockTransitionWorkflowRunCas.mockResolvedValueOnce({ id: "run-1" });
    const snap = standaloneSnapshot();
    snap.run.status.state = WorkflowRunState.RUNNING;

    const outcome = await executeAction(
      { kind: "requeueRun", runId: "run-1", trigger: "start_interrupted", reason: "r" },
      snap,
    );

    expect(outcome.status).toBe("applied");
    expect(mockTransitionWorkflowRunCas).toHaveBeenNthCalledWith(
      1,
      "run-1",
      WorkflowRunState.RUNNING,
      WorkflowRunState.FAILED,
      expect.objectContaining({
        errorMessage: expect.stringContaining("before its agent started"),
      }),
      { version: BASE_VERSION, wakeReconciler: false },
    );
    expect(mockTransitionWorkflowRunCas).toHaveBeenNthCalledWith(
      2,
      "run-1",
      WorkflowRunState.FAILED,
      WorkflowRunState.QUEUED,
      { errorMessage: null, finishedAt: null },
    );
    // No retryCount in either step: nothing ran.
    for (const call of mockTransitionWorkflowRunCas.mock.calls) {
      expect(call[3]).not.toHaveProperty("retryCount");
    }
  });

  it("requeueRun of a Job run from a stale snapshot stops at the first step", async () => {
    mockTransitionWorkflowRunCas.mockResolvedValueOnce(null);
    const outcome = await executeAction(
      { kind: "requeueRun", runId: "run-1", trigger: "start_interrupted", reason: "r" },
      standaloneSnapshot(),
    );
    expect(outcome.status).toBe("stale");
    expect(mockTransitionWorkflowRunCas).toHaveBeenCalledTimes(1);
  });
});
