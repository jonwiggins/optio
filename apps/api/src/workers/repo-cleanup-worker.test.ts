import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskState } from "@optio/shared";

// ── Track which processor fn BullMQ Worker captured ────────────────────────

let processorFn: () => Promise<void>;

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
  Worker: vi.fn().mockImplementation((_name: string, processor: () => Promise<void>) => {
    processorFn = processor;
    return { on: vi.fn() };
  }),
}));

// ── DB mock ────────────────────────────────────────────────────────────────

// db.select() calls are answered in order from `selectResults` (tasks,
// taskEvents, repos queries). The repo pods themselves come from
// repo-pool-service's listRepoPods (mockListRepoPods), not a db.select().

let selectResults: unknown[][] = [];
let selectCallIndex = 0;
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

function resetDbState() {
  selectResults = [];
  selectCallIndex = 0;
  mockInsert.mockReset();
  mockUpdate.mockReset();
  mockDelete.mockReset();

  // insert().values()
  mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

  // update().set().where()
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  mockUpdate.mockReturnValue({ set: updateSet });

  // delete().where()
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  mockDelete.mockReturnValue({ where: deleteWhere });
}

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockImplementation(() => {
      const idx = selectCallIndex++;
      const rows = selectResults[idx] ?? [];
      return {
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue(rows),
          // Bare from() with no where returns the rows
          then: (res: (v: unknown) => void) => Promise.resolve(rows).then(res),
          [Symbol.iterator]: function* () {
            yield* rows;
          },
        })),
      };
    }),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

// ── Schema mock — just need exported table references for eq() calls ───────

vi.mock("../db/schema.js", () => ({
  agentPods: {
    id: "agentPods.id",
    pool: "agentPods.pool",
    poolKey: "agentPods.poolKey",
    state: "agentPods.state",
    activeCount: "agentPods.activeCount",
  },
  podHealthEvents: { id: "podHealthEvents.id" },
  tasks: {
    id: "tasks.id",
    state: "tasks.state",
    repoUrl: "tasks.repoUrl",
    updatedAt: "tasks.updatedAt",
    worktreeState: "tasks.worktreeState",
    retryCount: "tasks.retryCount",
    maxRetries: "tasks.maxRetries",
    lastActivityAt: "tasks.lastActivityAt",
    activitySubstate: "tasks.activitySubstate",
    workspaceId: "tasks.workspaceId",
  },
  taskEvents: {
    id: "taskEvents.id",
    taskId: "taskEvents.taskId",
    trigger: "taskEvents.trigger",
  },
  repos: {
    repoUrl: "repos.repoUrl",
    stallThresholdMs: "repos.stallThresholdMs",
  },
}));

// ── Service mocks ──────────────────────────────────────────────────────────

const mockCleanupIdle = vi.fn().mockResolvedValue(0);
const mockUpdateWorktree = vi.fn().mockResolvedValue(undefined);
const mockReconcile = vi.fn().mockResolvedValue(0);
const mockDeleteNetPolicy = vi.fn().mockResolvedValue(undefined);
const mockKillOrphanedAgent = vi.fn().mockResolvedValue(false);
const mockListRepoPods = vi.fn().mockResolvedValue([]);

vi.mock("../services/repo-pool-service.js", () => ({
  cleanupIdleRepoPods: (...args: unknown[]) => mockCleanupIdle(...args),
  updateWorktreeState: (...args: unknown[]) => mockUpdateWorktree(...args),
  reconcileActiveTaskCounts: (...args: unknown[]) => mockReconcile(...args),
  listRepoPods: (...args: unknown[]) => mockListRepoPods(...args),
  deleteNetworkPolicy: (...args: unknown[]) => mockDeleteNetPolicy(...args),
  killOrphanedAgentInPod: (...args: unknown[]) => mockKillOrphanedAgent(...args),
}));

// Removing a pod's row is agent-pod-pool's deletePod.
const mockDeletePod = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/agent-pod-pool.js", () => ({
  deletePod: (...args: unknown[]) => mockDeletePod(...args),
}));

const mockRtStatus = vi.fn();
const mockRtExec = vi.fn();
const mockRtDestroy = vi.fn();

vi.mock("../services/container-service.js", () => ({
  getRuntime: () => ({
    status: mockRtStatus,
    exec: mockRtExec,
    destroy: mockRtDestroy,
  }),
}));

const mockTransitionTask = vi.fn().mockResolvedValue(undefined);
const mockUpdateTaskResult = vi.fn().mockResolvedValue(undefined);
const mockGetStallThreshold = vi.fn().mockReturnValue(300_000);
const mockGetLastLogSummary = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/task-service.js", () => ({
  transitionTask: (...args: unknown[]) => mockTransitionTask(...args),
  updateTaskResult: (...args: unknown[]) => mockUpdateTaskResult(...args),
  getStallThresholdForRepo: (...args: unknown[]) => mockGetStallThreshold(...args),
  getLastLogSummary: (...args: unknown[]) => mockGetLastLogSummary(...args),
}));

const mockPublishEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/event-bus.js", () => ({
  publishEvent: (...args: unknown[]) => mockPublishEvent(...args),
}));

const mockCleanupExpiredSessions = vi.fn().mockResolvedValue(0);

vi.mock("../services/session-service.js", () => ({
  cleanupExpiredSessions: (...args: unknown[]) => mockCleanupExpiredSessions(...args),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockTaskQueueAdd = vi.fn().mockResolvedValue(undefined);

vi.mock("./task-worker.js", () => ({
  taskQueue: { add: (...args: unknown[]) => mockTaskQueueAdd(...args) },
}));

const mockEnqueueReconcile = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/reconcile-queue.js", () => ({
  enqueueReconcile: (...args: unknown[]) => mockEnqueueReconcile(...args),
}));

// ── drizzle-orm mock — eq() and sql`` just pass-through ────────────────────

vi.mock("../services/k8s-workload-service.js", () => ({
  isStatefulSetEnabled: () => false,
  getWorkloadManager: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col, _val) => ({ type: "eq" })),
  sql: new Proxy((..._args: unknown[]) => ({}), {
    // Support tagged template usage: sql`...`
    apply: (_target, _thisArg, args) => args,
    get: (_target, prop) => {
      if (prop === Symbol.hasInstance) return () => false;
      return (..._args: unknown[]) => ({});
    },
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

/** A repo pod as listRepoPods returns it: an `agent_pods` row in the repo pool. */
function makePod(overrides: Record<string, unknown> = {}) {
  return {
    id: "pod-1",
    pool: "repo",
    poolKey: "https://github.com/test/repo",
    podName: "optio-test-repo-0",
    podId: "pod-id-1",
    state: "ready",
    activeCount: 0,
    instanceIndex: 0,
    errorMessage: null,
    managedBy: "bare-pod",
    statefulSetName: null,
    ...overrides,
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Test task",
    prompt: "Do something",
    repoUrl: "https://github.com/test/repo",
    state: "running",
    agentType: "claude",
    retryCount: 0,
    maxRetries: 3,
    priority: 100,
    worktreeState: "active",
    updatedAt: new Date(Date.now() - 300_000).toISOString(), // 5 min ago
    ...overrides,
  };
}

/** Create a mock ExecSession whose stdout yields `output`. */
function makeExecSession(output: string) {
  const chunks = output ? [Buffer.from(output)] : [];
  return {
    stdout: {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    },
    stderr: { [Symbol.asyncIterator]: async function* () {} },
    stdin: { write: vi.fn(), end: vi.fn() },
    resize: vi.fn(),
    close: vi.fn(),
  };
}

// ── Setup & teardown ───────────────────────────────────────────────────────

const { db } = await import("../db/client.js");

let originalDateNow: typeof Date.now;

beforeEach(() => {
  resetDbState();
  mockRtStatus.mockReset();
  mockRtExec.mockReset();
  mockRtDestroy.mockReset();
  mockTransitionTask.mockReset().mockResolvedValue(undefined);
  mockUpdateTaskResult.mockReset().mockResolvedValue(undefined);
  mockCleanupIdle.mockReset().mockResolvedValue(0);
  mockUpdateWorktree.mockReset().mockResolvedValue(undefined);
  mockReconcile.mockReset().mockResolvedValue(0);
  mockDeleteNetPolicy.mockReset().mockResolvedValue(undefined);
  mockKillOrphanedAgent.mockReset().mockResolvedValue(false);
  mockListRepoPods.mockReset().mockResolvedValue([]);
  mockDeletePod.mockReset().mockResolvedValue(undefined);
  mockCleanupExpiredSessions.mockReset().mockResolvedValue(0);
  mockTaskQueueAdd.mockReset().mockResolvedValue(undefined);
  mockPublishEvent.mockReset().mockResolvedValue(undefined);
  mockGetStallThreshold.mockReset().mockReturnValue(300_000);
  mockGetLastLogSummary.mockReset().mockResolvedValue(undefined);
  selectCallIndex = 0;
  originalDateNow = Date.now;
});

afterEach(() => {
  Date.now = originalDateNow;
});

// Capture the processor function once
const { startRepoCleanupWorker } = await import("./repo-cleanup-worker.js");
startRepoCleanupWorker();

// ────────────────────────────────────────────────────────────────────────────
// TESTS
// ────────────────────────────────────────────────────────────────────────────

describe("repo-cleanup-worker", () => {
  // ── Pod health monitoring ──────────────────────────────────────────────

  describe("pod health monitoring", () => {
    it("skips pods in provisioning state", async () => {
      // listRepoPods returns one pod in provisioning; the task queries return empty
      mockListRepoPods.mockResolvedValue([makePod({ state: "provisioning" })]);
      selectResults = [
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      await processorFn();

      expect(mockRtStatus).not.toHaveBeenCalled();
    });

    it("skips pods without podName", async () => {
      mockListRepoPods.mockResolvedValue([makePod({ podName: null })]);
      selectResults = [
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      await processorFn();

      expect(mockRtStatus).not.toHaveBeenCalled();
    });

    it("detects crashed pod and marks as error", async () => {
      const pod = makePod();
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [], // active tasks on the dead pod
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "failed", reason: "CrashLoopBackOff" });
      mockRtDestroy.mockResolvedValue(undefined);

      await processorFn();

      // Should have called update to set state="error"
      expect(mockUpdate).toHaveBeenCalled();
      const updateCall = mockUpdate.mock.results[0].value;
      expect(updateCall.set).toHaveBeenCalledWith(expect.objectContaining({ state: "error" }));
    });

    it("detects OOM killed pod", async () => {
      const pod = makePod();
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [], // active tasks
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "failed", reason: "OOMKilled" });
      mockRtDestroy.mockResolvedValue(undefined);

      await processorFn();

      // insert should be called for health events — check the first call contains "oom_killed"
      expect(mockInsert).toHaveBeenCalled();
      const firstInsert = mockInsert.mock.results[0].value;
      // The health event still names the repo: the pod's pool key
      expect(firstInsert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "oom_killed",
          repoPodId: pod.id,
          repoUrl: "https://github.com/test/repo",
        }),
      );
    });

    it("marks worktrees dirty and wakes the reconciler on dead pod", async () => {
      const pod = makePod();
      const task = makeTask({ id: "task-dead-1", state: "running" });
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [task], // active tasks on the dead pod
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "failed", reason: "Terminated" });
      mockRtDestroy.mockResolvedValue(undefined);

      await processorFn();

      // Cleanup worker no longer fires the FAILED transition itself —
      // the reconciler observes pod.phase=error from the snapshot and
      // owns the FAILED transition via decideRunning / decideProvisioning.
      expect(mockUpdateWorktree).toHaveBeenCalledWith("task-dead-1", "dirty");
      expect(mockTransitionTask).not.toHaveBeenCalled();
      expect(mockUpdateTaskResult).toHaveBeenCalledWith(
        "task-dead-1",
        undefined,
        expect.stringContaining("Terminated"),
      );
      expect(mockEnqueueReconcile).toHaveBeenCalledWith(
        { kind: "repo", id: "task-dead-1" },
        expect.objectContaining({ reason: expect.stringMatching(/^pod_/) }),
      );
    });

    it("auto-restarts dead pod — destroys and deletes record", async () => {
      const pod = makePod();
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [], // active tasks
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "failed", reason: "Error" });
      mockRtDestroy.mockResolvedValue(undefined);

      await processorFn();

      expect(mockRtDestroy).toHaveBeenCalledWith({
        id: pod.podId,
        name: pod.podName,
      });
      expect(mockDeletePod).toHaveBeenCalledWith(pod.id);
      expect(mockDeleteNetPolicy).toHaveBeenCalledWith(pod.podName);
    });

    it("detects pod recovery from error state", async () => {
      const pod = makePod({ state: "error" });
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });

      await processorFn();

      // Should update the pod to "ready"
      expect(mockUpdate).toHaveBeenCalled();
      const updateCall = mockUpdate.mock.results[0].value;
      expect(updateCall.set).toHaveBeenCalledWith(
        expect.objectContaining({ state: "ready", errorMessage: null }),
      );

      // Should record a "healthy" event
      expect(mockInsert).toHaveBeenCalled();
      const insertCall = mockInsert.mock.results[0].value;
      expect(insertCall.values).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "healthy" }),
      );
    });

    it("handles pod not found — cleans up record", async () => {
      const pod = makePod();
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockRejectedValue(new Error("Pod not found in cluster"));

      await processorFn();

      expect(mockDeleteNetPolicy).toHaveBeenCalledWith(pod.podName);
      expect(mockDeletePod).toHaveBeenCalledWith(pod.id);
      // Should record a "crashed" health event
      expect(mockInsert).toHaveBeenCalled();
      const insertCall = mockInsert.mock.results[0].value;
      expect(insertCall.values).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "crashed" }),
      );
    });
  });

  // ── Worktree cleanup ──────────────────────────────────────────────────

  describe("worktree cleanup", () => {
    it("skips non-ready pods for worktree cleanup", async () => {
      const pod = makePod({ state: "error" });
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      // The pod is in "error" state, so status will show running but the
      // cleanup loop checks pod.state === "ready" before listing worktrees.
      // However, status check happens first. For an error pod with running status,
      // it gets recovered to ready in the first pass, but the second loop
      // re-reads the in-memory pods array which still has state="error".
      mockRtStatus.mockResolvedValue({ state: "running" });

      await processorFn();

      // exec should not be called for worktree listing since pod.state !== "ready"
      // in the in-memory pods array (it was "error" when read from DB)
      // Actually: the recovery sets it to ready in DB but the in-memory `pod`
      // object still has state="error", so the worktree loop skips it.
      expect(mockRtExec).not.toHaveBeenCalled();
    });

    it("removes orphan worktrees when no task found in DB", async () => {
      const pod = makePod({ state: "ready" });
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [], // task lookup for orphan worktree (no task found)
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });

      // First exec: list worktrees — returns one task ID
      const listSession = makeExecSession("orphan-task-id\n");
      // Second exec: cleanup command
      const cleanSession = makeExecSession("");

      mockRtExec.mockResolvedValueOnce(listSession).mockResolvedValueOnce(cleanSession);

      await processorFn();

      // Should have called exec twice — list and cleanup
      expect(mockRtExec).toHaveBeenCalledTimes(2);
      expect(cleanSession.close).toHaveBeenCalled();
    });

    it("preserves active worktrees", async () => {
      const pod = makePod({ state: "ready" });
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [
          {
            state: "running",
            updatedAt: new Date().toISOString(),
            worktreeState: "active",
            retryCount: 0,
            maxRetries: 3,
          },
        ], // task lookup
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });

      const listSession = makeExecSession("task-1\n");
      mockRtExec.mockResolvedValueOnce(listSession);

      await processorFn();

      // Only the list exec should be called — no cleanup
      expect(mockRtExec).toHaveBeenCalledTimes(1);
    });

    it("preserves preserved worktrees", async () => {
      const pod = makePod({ state: "ready" });
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [
          {
            state: "completed",
            updatedAt: new Date().toISOString(),
            worktreeState: "preserved",
            retryCount: 0,
            maxRetries: 3,
          },
        ],
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });

      const listSession = makeExecSession("task-1\n");
      mockRtExec.mockResolvedValueOnce(listSession);

      await processorFn();

      // Only the list exec
      expect(mockRtExec).toHaveBeenCalledTimes(1);
    });

    it("preserves worktrees for running tasks", async () => {
      const pod = makePod({ state: "ready" });
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [
          {
            state: "running",
            updatedAt: new Date().toISOString(),
            worktreeState: "dirty",
            retryCount: 0,
            maxRetries: 3,
          },
        ],
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });

      const listSession = makeExecSession("task-1\n");
      mockRtExec.mockResolvedValueOnce(listSession);

      await processorFn();

      expect(mockRtExec).toHaveBeenCalledTimes(1);
    });

    it("preserves dirty worktrees for failed tasks with retries remaining", async () => {
      const pod = makePod({ state: "ready" });
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [
          {
            state: "failed",
            updatedAt: new Date(Date.now() - 300_000).toISOString(),
            worktreeState: "dirty",
            retryCount: 1,
            maxRetries: 3,
          },
        ],
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });

      const listSession = makeExecSession("task-1\n");
      mockRtExec.mockResolvedValueOnce(listSession);

      await processorFn();

      // Only list exec — no cleanup
      expect(mockRtExec).toHaveBeenCalledTimes(1);
    });

    it("removes worktrees for terminal tasks after grace period", async () => {
      const pod = makePod({ state: "ready" });
      // updatedAt 3 minutes ago — past the 2min grace period
      const oldDate = new Date(Date.now() - 180_000).toISOString();
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [
          {
            state: "completed",
            updatedAt: oldDate,
            worktreeState: "dirty",
            retryCount: 0,
            maxRetries: 3,
          },
        ],
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });

      const listSession = makeExecSession("task-1\n");
      const cleanSession = makeExecSession("");
      mockRtExec.mockResolvedValueOnce(listSession).mockResolvedValueOnce(cleanSession);

      await processorFn();

      // List + cleanup = 2 exec calls
      expect(mockRtExec).toHaveBeenCalledTimes(2);
      expect(mockUpdateWorktree).toHaveBeenCalledWith("task-1", "removed");
    });

    it("skips worktrees within grace period", async () => {
      const pod = makePod({ state: "ready" });
      // updatedAt 30 seconds ago — within the 2min grace period
      const recentDate = new Date(Date.now() - 30_000).toISOString();
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [
          {
            state: "completed",
            updatedAt: recentDate,
            worktreeState: "dirty",
            retryCount: 0,
            maxRetries: 3,
          },
        ],
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });

      const listSession = makeExecSession("task-1\n");
      mockRtExec.mockResolvedValueOnce(listSession);

      await processorFn();

      // Only list exec — no cleanup because within grace period
      expect(mockRtExec).toHaveBeenCalledTimes(1);
      expect(mockUpdateWorktree).not.toHaveBeenCalled();
    });

    it("preserves worktrees for pr_opened tasks", async () => {
      const pod = makePod({ state: "ready" });
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [
          {
            state: "pr_opened",
            updatedAt: new Date(Date.now() - 300_000).toISOString(),
            worktreeState: "dirty",
            retryCount: 0,
            maxRetries: 3,
          },
        ],
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });

      const listSession = makeExecSession("task-1\n");
      mockRtExec.mockResolvedValueOnce(listSession);

      await processorFn();

      expect(mockRtExec).toHaveBeenCalledTimes(1);
    });

    it("preserves worktrees for needs_attention tasks", async () => {
      const pod = makePod({ state: "ready" });
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [
          {
            state: "needs_attention",
            updatedAt: new Date(Date.now() - 300_000).toISOString(),
            worktreeState: "dirty",
            retryCount: 0,
            maxRetries: 3,
          },
        ],
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });

      const listSession = makeExecSession("task-1\n");
      mockRtExec.mockResolvedValueOnce(listSession);

      await processorFn();

      expect(mockRtExec).toHaveBeenCalledTimes(1);
    });
  });

  // ── Stale task detection ──────────────────────────────────────────────

  describe("stale task detection", () => {
    it("transitions stale task to failed then re-queues", async () => {
      const staleTask = makeTask({
        id: "stale-1",
        state: "running",
        updatedAt: new Date(Date.now() - 700_000).toISOString(),
      });
      selectResults = [
        [], // soft stall detection: running tasks with lastActivityAt
        [staleTask], // stale tasks query
        [{ count: 1 }], // staleRetryCount < MAX_STALE_RETRIES (3)
      ];

      await processorFn();

      // First: transition to FAILED
      expect(mockTransitionTask).toHaveBeenCalledWith(
        "stale-1",
        TaskState.FAILED,
        "stale_detected",
        expect.stringContaining("stalled"),
      );
      // Then: transition to QUEUED
      expect(mockTransitionTask).toHaveBeenCalledWith(
        "stale-1",
        TaskState.QUEUED,
        "auto_retry_stale",
        expect.stringContaining("Re-queued"),
      );
      // Then: add to task queue
      expect(mockTaskQueueAdd).toHaveBeenCalledWith(
        "process-task",
        { taskId: "stale-1" },
        expect.objectContaining({ priority: 100 }),
      );
    });

    it("fails permanently after 3 stale retries", async () => {
      const staleTask = makeTask({
        id: "stale-perm",
        state: "running",
        updatedAt: new Date(Date.now() - 700_000).toISOString(),
      });
      selectResults = [
        [], // soft stall detection: running tasks
        [staleTask], // stale tasks
        [{ count: 3 }], // staleRetryCount >= MAX_STALE_RETRIES
      ];

      await processorFn();

      // Should only transition to FAILED with limit message
      expect(mockTransitionTask).toHaveBeenCalledWith(
        "stale-perm",
        TaskState.FAILED,
        "stale_limit_reached",
        expect.stringContaining("3 times"),
      );
      // Should NOT re-queue
      expect(mockTaskQueueAdd).not.toHaveBeenCalled();
    });

    it("kills orphaned agent in pod before re-queueing stale task", async () => {
      const staleTask = makeTask({
        id: "stale-orphan",
        state: "running",
        lastPodId: "pod-abc",
        updatedAt: new Date(Date.now() - 700_000).toISOString(),
      });
      selectResults = [
        [], // soft stall detection: running tasks
        [staleTask], // stale tasks
        [{ count: 0 }], // staleRetryCount = 0 (first stale detection)
      ];

      mockKillOrphanedAgent.mockResolvedValue(true);

      await processorFn();

      // Should have called killOrphanedAgentInPod with the pod ID and task ID
      expect(mockKillOrphanedAgent).toHaveBeenCalledWith("pod-abc", "stale-orphan");
      // Should update worktree state to removed
      expect(mockUpdateWorktree).toHaveBeenCalledWith("stale-orphan", "removed");
      // Should still re-queue
      expect(mockTaskQueueAdd).toHaveBeenCalled();
    });

    it("escalates to needs_attention when cleanup fails on repeated stale recovery", async () => {
      const staleTask = makeTask({
        id: "stale-stuck",
        state: "running",
        lastPodId: "pod-xyz",
        updatedAt: new Date(Date.now() - 700_000).toISOString(),
      });
      selectResults = [
        [], // soft stall detection: running tasks
        [staleTask], // stale tasks
        [{ count: 1 }], // staleRetryCount = 1 (already retried once)
      ];

      // Simulate cleanup failure
      mockKillOrphanedAgent.mockRejectedValue(new Error("Pod not reachable"));

      await processorFn();

      // Should mark worktree as dirty
      expect(mockUpdateWorktree).toHaveBeenCalledWith("stale-stuck", "dirty");
      // Should transition to needs_attention (not re-queue)
      expect(mockTransitionTask).toHaveBeenCalledWith(
        "stale-stuck",
        TaskState.NEEDS_ATTENTION,
        "stale_recovery_failed",
        expect.stringContaining("Manual intervention required"),
      );
      // Should NOT re-queue
      expect(mockTaskQueueAdd).not.toHaveBeenCalled();
    });

    it("re-queues on first stale even if cleanup fails", async () => {
      const staleTask = makeTask({
        id: "stale-first",
        state: "running",
        lastPodId: "pod-first",
        updatedAt: new Date(Date.now() - 700_000).toISOString(),
      });
      selectResults = [
        [], // soft stall detection: running tasks
        [staleTask], // stale tasks
        [{ count: 0 }], // staleRetryCount = 0 (first time)
      ];

      // Cleanup fails but this is the first attempt, so we still re-queue
      mockKillOrphanedAgent.mockRejectedValue(new Error("Pod not reachable"));

      await processorFn();

      // Should still re-queue (first attempt gets a pass even on cleanup failure)
      expect(mockTaskQueueAdd).toHaveBeenCalledWith(
        "process-task",
        { taskId: "stale-first" },
        expect.objectContaining({ priority: 100 }),
      );
    });

    it("handles stale task with no lastPodId gracefully", async () => {
      const staleTask = makeTask({
        id: "stale-no-pod",
        state: "running",
        lastPodId: null,
        updatedAt: new Date(Date.now() - 700_000).toISOString(),
      });
      selectResults = [
        [], // soft stall detection: running tasks
        [staleTask], // stale tasks
        [{ count: 0 }], // staleRetryCount = 0
      ];

      await processorFn();

      // Should NOT call killOrphanedAgent (no pod to clean up)
      expect(mockKillOrphanedAgent).not.toHaveBeenCalled();
      // Should still re-queue
      expect(mockTaskQueueAdd).toHaveBeenCalled();
      // Should update worktree state to removed
      expect(mockUpdateWorktree).toHaveBeenCalledWith("stale-no-pod", "removed");
    });
  });

  // ── Reconciliation & cleanup ──────────────────────────────────────────

  describe("reconciliation and cleanup", () => {
    it("calls reconcileActiveTaskCounts", async () => {
      selectResults = [
        [], // soft stall detection: running tasks
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      await processorFn();

      expect(mockReconcile).toHaveBeenCalled();
    });

    it("calls cleanupIdleRepoPods", async () => {
      selectResults = [
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      await processorFn();

      expect(mockCleanupIdle).toHaveBeenCalled();
    });

    it("handles cleanupExpiredSessions error gracefully", async () => {
      selectResults = [
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockCleanupExpiredSessions.mockRejectedValue(new Error("DB connection failed"));

      // Should not throw
      await expect(processorFn()).resolves.toBeUndefined();
    });

    it("calls cleanupExpiredSessions", async () => {
      selectResults = [
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockCleanupExpiredSessions.mockResolvedValue(5);

      await processorFn();

      expect(mockCleanupExpiredSessions).toHaveBeenCalled();
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty pod list gracefully", async () => {
      mockListRepoPods.mockResolvedValue([]); // no repo pods at all
      selectResults = [
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      await expect(processorFn()).resolves.toBeUndefined();
    });

    it("handles multiple pods with mixed states", async () => {
      const provisioningPod = makePod({ id: "pod-prov", state: "provisioning", podName: "p1" });
      const readyPod = makePod({ id: "pod-ready", state: "ready", podName: "p2" });
      const noPodName = makePod({ id: "pod-no-name", podName: null });

      mockListRepoPods.mockResolvedValue([provisioningPod, readyPod, noPodName]);
      selectResults = [
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      // readyPod will get status checked
      mockRtStatus.mockResolvedValue({ state: "running" });

      // readyPod also gets worktree listing (it's "ready")
      const listSession = makeExecSession(""); // empty — no worktrees
      mockRtExec.mockResolvedValueOnce(listSession);

      await processorFn();

      // Only the readyPod should get status checked (provisioning + null podName skipped)
      expect(mockRtStatus).toHaveBeenCalledTimes(1);
    });

    it("handles status returning unknown state", async () => {
      const pod = makePod();
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [], // active tasks
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "unknown", reason: "NetworkError" });
      mockRtDestroy.mockResolvedValue(undefined);

      await processorFn();

      // Should treat "unknown" same as "failed" — record health event and clean up
      expect(mockInsert).toHaveBeenCalled();
      expect(mockDeletePod).toHaveBeenCalledWith(pod.id);
    });

    it("removes worktrees for cancelled tasks after grace period", async () => {
      const pod = makePod({ state: "ready" });
      const oldDate = new Date(Date.now() - 180_000).toISOString();
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [
          {
            state: "cancelled",
            updatedAt: oldDate,
            worktreeState: "dirty",
            retryCount: 0,
            maxRetries: 3,
          },
        ],
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });

      const listSession = makeExecSession("task-cancel\n");
      const cleanSession = makeExecSession("");
      mockRtExec.mockResolvedValueOnce(listSession).mockResolvedValueOnce(cleanSession);

      await processorFn();

      expect(mockRtExec).toHaveBeenCalledTimes(2);
      expect(mockUpdateWorktree).toHaveBeenCalledWith("task-cancel", "removed");
    });

    it("removes worktrees for failed tasks with no retries left after grace period", async () => {
      const pod = makePod({ state: "ready" });
      const oldDate = new Date(Date.now() - 180_000).toISOString();
      mockListRepoPods.mockResolvedValue([pod]);
      selectResults = [
        [
          {
            state: "failed",
            updatedAt: oldDate,
            worktreeState: "dirty",
            retryCount: 3,
            maxRetries: 3,
          },
        ],
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });

      const listSession = makeExecSession("task-noretry\n");
      const cleanSession = makeExecSession("");
      mockRtExec.mockResolvedValueOnce(listSession).mockResolvedValueOnce(cleanSession);

      await processorFn();

      expect(mockRtExec).toHaveBeenCalledTimes(2);
      expect(mockUpdateWorktree).toHaveBeenCalledWith("task-noretry", "removed");
    });
  });

  describe("soft stall detection", () => {
    it("flags a running task as stalled when silent beyond threshold", async () => {
      const stalledTask = {
        id: "task-stalled",
        repoUrl: "https://github.com/test/repo",
        workspaceId: null,
        lastActivityAt: new Date(Date.now() - 400_000), // 6.6 min ago
        activitySubstate: "active",
      };

      selectResults = [
        [stalledTask], // running tasks with lastActivityAt (stall detection query)
        [], // repo config lookup
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });
      mockGetStallThreshold.mockReturnValue(300_000); // 5 min

      await processorFn();

      // Should have updated the task to stalled
      expect(mockUpdate).toHaveBeenCalled();
      // Should have published task:stalled event
      expect(mockPublishEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "task:stalled",
          taskId: "task-stalled",
        }),
      );
    });

    it("does NOT flag a task that is within threshold", async () => {
      const activeTask = {
        id: "task-active",
        repoUrl: "https://github.com/test/repo",
        workspaceId: null,
        lastActivityAt: new Date(Date.now() - 60_000), // 1 min ago
        activitySubstate: "active",
      };

      selectResults = [
        [activeTask], // running tasks
        [], // repo config
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });
      mockGetStallThreshold.mockReturnValue(300_000);

      await processorFn();

      // Should NOT have published stall event
      expect(mockPublishEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "task:stalled" }),
      );
    });

    it("does NOT re-flag an already stalled task", async () => {
      const alreadyStalled = {
        id: "task-already-stalled",
        repoUrl: "https://github.com/test/repo",
        workspaceId: null,
        lastActivityAt: new Date(Date.now() - 600_000), // 10 min ago
        activitySubstate: "stalled", // already flagged
      };

      selectResults = [
        [alreadyStalled], // running tasks
        [], // repo config
        [], // soft stall detection: running tasks
        [], // stale tasks
      ];

      mockRtStatus.mockResolvedValue({ state: "running" });
      mockGetStallThreshold.mockReturnValue(300_000);

      await processorFn();

      // Should NOT publish duplicate stall event
      expect(mockPublishEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "task:stalled" }),
      );
    });
  });
});
