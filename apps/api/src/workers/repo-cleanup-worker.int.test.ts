import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { prReviewRuns, prReviews, taskEvents } from "../db/schema.js";
import { insertTask } from "../test-utils/integration/fixtures.js";
import { getTask } from "../services/task-service.js";

// Exercise the sweep's real Postgres queries and task transitions, without
// touching pods. Local task activity lives on the terminal, so old task-row
// timestamps must never trigger the pod worker's stall/recovery policy.
// The worktree test adds one ready repo pod whose runtime lists worktrees and
// records the scripts the sweep runs in it.
const fakePods = vi.hoisted(() => ({
  repoPods: [] as Array<Record<string, unknown>>,
  worktreeIds: [] as string[],
  execScripts: [] as string[],
}));
vi.mock("../services/container-service.js", () => ({
  getRuntime: () => ({
    status: async () => ({ state: "running" }),
    exec: async (_target: unknown, command: string[]) => {
      const script = command[command.length - 1];
      fakePods.execScripts.push(script);
      const output = script.startsWith("ls /workspace/tasks/")
        ? fakePods.worktreeIds.join("\n")
        : "";
      return {
        stdout: (async function* () {
          if (output) yield Buffer.from(output);
        })(),
        close: () => {},
      };
    },
  }),
}));
vi.mock("../services/reconcile-queue.js", () => ({ enqueueReconcile: vi.fn() }));
vi.mock("../services/repo-pool-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/repo-pool-service.js")>()),
  listRepoPods: async () => fakePods.repoPods,
  reconcileActiveTaskCounts: async () => 0,
  cleanupIdleRepoPods: async () => 0,
}));
vi.mock("../services/workflow-pool-service.js", () => ({
  reconcileActiveRunCounts: async () => 0,
  cleanupIdleWorkflowPods: async () => 0,
}));
vi.mock("../services/persistent-agent-pool-service.js", () => ({
  cleanupIdlePersistentAgentPods: async () => 0,
}));
vi.mock("../services/run-home-sweep-service.js", () => ({
  sweepFinishedRunHomes: async () => 0,
}));
vi.mock("../services/zombie-cleanup-service.js", () => ({
  cleanupZombieWorkflowRuns: async () => 0,
  cleanupOrphanedRepoTasks: async () => 0,
}));
vi.mock("../services/session-service.js", () => ({ cleanupExpiredSessions: async () => 0 }));

import { repoCleanupQueue, sweepPods } from "./repo-cleanup-worker.js";

afterAll(async () => {
  await repoCleanupQueue.close();
});

describe("pod cleanup leaves Local task liveness to its daemon", () => {
  it("ignores old Local rows while still detecting stale and stalled pod tasks", async () => {
    const old = new Date(Date.now() - 20 * 60_000);
    const local = await Promise.all(
      (["running", "provisioning"] as const).map((state) =>
        insertTask({
          state,
          runTarget: "local",
          updatedAt: old,
          lastActivityAt: old,
          activitySubstate: "active",
        }),
      ),
    );
    const podRunning = await insertTask({ state: "running", updatedAt: old });
    const podProvisioning = await insertTask({ state: "provisioning", updatedAt: old });
    const podSilent = await insertTask({
      state: "running",
      lastActivityAt: old,
      updatedAt: new Date(),
    });

    await sweepPods();

    for (const task of local) {
      expect(await getTask(task.id)).toMatchObject({
        state: task.state,
        activitySubstate: "active",
        errorMessage: null,
        worktreeState: null,
        updatedAt: old,
      });
    }
    expect(
      await db
        .select()
        .from(taskEvents)
        .where(
          inArray(
            taskEvents.taskId,
            local.map((t) => t.id),
          ),
        ),
    ).toEqual([]);
    expect(await getTask(podRunning.id)).toMatchObject({
      state: "needs_attention",
      worktreeState: "preserved",
    });
    expect(await getTask(podProvisioning.id)).toMatchObject({
      state: "failed",
      worktreeState: "preserved",
    });
    expect(await getTask(podSilent.id)).toMatchObject({
      state: "running",
      activitySubstate: "stalled",
    });
  });
});

describe("worktree sweep and PR review runs", () => {
  afterEach(() => {
    fakePods.repoPods.length = 0;
    fakePods.worktreeIds.length = 0;
    fakePods.execScripts.length = 0;
  });

  // Regression: a PR review run's worktree is keyed by the run id, which has
  // no tasks row, so the sweep deleted it as an orphan while the review agent
  // was still working in it.
  it("keeps an in-flight review's worktree and removes a finished review's", async () => {
    const [review] = await db
      .insert(prReviews)
      .values({
        prUrl: "https://github.com/it-org/it-repo/pull/7",
        prNumber: 7,
        repoOwner: "it-org",
        repoName: "it-repo",
        repoUrl: "https://github.com/it-org/it-repo",
        headSha: "3f9c2e1d8b7a6c5e4f3a2b1c0d9e8f7a6b5c4d3e",
      })
      .returning();
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    const [inFlightRun, finishedRun] = await db
      .insert(prReviewRuns)
      .values([
        { prReviewId: review.id, state: "running", updatedAt: tenMinutesAgo },
        { prReviewId: review.id, state: "completed", updatedAt: tenMinutesAgo },
      ])
      .returning();
    fakePods.repoPods.push({
      id: randomUUID(),
      pool: "repo",
      poolKey: review.repoUrl,
      podName: "optio-repo-it-0",
      podId: "optio-repo-it-0",
      state: "ready",
      managedBy: "bare-pod",
    });
    fakePods.worktreeIds.push(inFlightRun.id, finishedRun.id);

    await sweepPods();

    const removals = fakePods.execScripts.filter((script) =>
      script.includes("git worktree remove"),
    );
    expect(removals).toHaveLength(1);
    expect(removals[0]).toContain(`/workspace/tasks/${finishedRun.id}`);
  });
});
