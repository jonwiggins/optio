/**
 * The PR watcher and the reconciler together, in the order production runs
 * them: a watcher poll (`pollPrs`, the tick's body) refreshes the task row
 * and enqueues a reconcile job, and the real reconcile worker takes that job
 * off the queue, builds its snapshot from the row the watcher left, decides
 * and executes.
 *
 * The decision function is edge-triggered on the row's `prChecksStatus`
 * ("CI just started failing"), so what the watcher writes before the
 * reconciler reads decides whether the edge exists at all (#812): unit tests
 * of `reconcileRepo` hand it a snapshot whose previous value differs, which
 * is exactly what a watcher that wrote the new value first destroys.
 *
 * Only the git host is mocked. The database, Redis, both queues, the
 * watcher's poll and the reconcile worker are the real ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Worker } from "bullmq";
import type { CICheck, PullRequest } from "@optio/shared";
import { db } from "../db/client.js";
import { taskEvents, tasks } from "../db/schema.js";
import { insertRepo, insertTask } from "../test-utils/integration/fixtures.js";
import { getRedisClient } from "../services/event-bus.js";
import { reconcileQueue } from "../services/reconcile-queue.js";
import { pollPrs, prWatcherQueue } from "./pr-watcher-worker.js";
import { startReconcileWorker } from "./reconcile-worker.js";
import { taskQueue } from "./task-worker.js";

const git = vi.hoisted(() => ({
  getPullRequest: vi.fn(),
  getCIChecks: vi.fn(),
  getReviews: vi.fn(),
  getInlineComments: vi.fn(),
  mergePullRequest: vi.fn(),
}));
vi.mock("../services/git-token-service.js", () => ({
  getGitPlatformForRepo: async () => ({
    platform: { type: "github", ...git },
    ri: {
      platform: "github",
      host: "github.com",
      owner: "it-org",
      repo: "watch",
      apiBaseUrl: "https://api.github.com",
    },
  }),
}));

const PENDING: CICheck[] = [{ name: "test", status: "in_progress", conclusion: null }];
const FAILING: CICheck[] = [{ name: "test", status: "completed", conclusion: "failure" }];
const PASSING: CICheck[] = [{ name: "test", status: "completed", conclusion: "success" }];

let pr: PullRequest;
let checks: CICheck[];
let reconciler: Worker;

beforeAll(() => {
  reconciler = startReconcileWorker();
});

beforeEach(async () => {
  vi.resetAllMocks();
  pr = {
    number: 42,
    title: "test",
    body: "",
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headSha: "head-a",
    baseBranch: "main",
    url: "https://github.com/it-org/watch/pull/42",
    author: "it",
    assignees: [],
    labels: [],
    createdAt: "",
    updatedAt: "",
  };
  checks = PENDING;
  git.getPullRequest.mockImplementation(async () => ({ ...pr }));
  git.getCIChecks.mockImplementation(async () => checks);
  git.getReviews.mockResolvedValue([]);
  git.getInlineComments.mockResolvedValue([]);
  git.mergePullRequest.mockResolvedValue(undefined);
  // Every test leaves its task out of the watcher's sight (the file shares
  // one database, and a poll walks every task with an open PR).
  await db.update(tasks).set({ state: "cancelled" });
  await settled();
});

afterAll(async () => {
  await reconciler.close();
  await reconcileQueue.close();
  await prWatcherQueue.close();
  await taskQueue.close();
  await getRedisClient().quit();
});

/** A task whose agent opened a PR, as the task worker leaves it. */
async function taskWithOpenPr(repoSettings: Parameters<typeof insertRepo>[0]) {
  const repo = await insertRepo({ autoMerge: false, reviewEnabled: false, ...repoSettings });
  return insertTask({ repoUrl: repo.repoUrl, state: "pr_opened", prUrl: pr.url });
}

async function rowOf(taskId: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return row;
}

/** Every reconcile job the producers enqueued has been worked off. */
async function settled() {
  await vi.waitFor(
    async () => {
      const counts = await reconcileQueue.getJobCounts("waiting", "active", "delayed", "paused");
      expect(counts).toEqual({ waiting: 0, active: 0, delayed: 0, paused: 0 });
    },
    { timeout: 20_000, interval: 50 },
  );
}

/** One watcher tick, then the reconciler works through what it enqueued. */
async function watcherTick() {
  await pollPrs();
  await settled();
}

async function triggersOf(taskId: string) {
  const events = await db
    .select({ trigger: taskEvents.trigger })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(asc(taskEvents.createdAt));
  return events.map((e) => e.trigger);
}

/**
 * The resume jobs on the task queue: the ones carrying a resume prompt. (A
 * queued task also gets the reconciler's plain `process-task` job, as any
 * queued task does; the task worker runs whichever it claims first.)
 */
async function resumeJobsFor(taskId: string) {
  const jobs = await taskQueue.getJobs(["waiting", "delayed", "prioritized"]);
  return jobs.filter((j) => j.data.taskId === taskId && j.data.resumePrompt);
}

describe("a PR whose CI fails, seen by the watcher first", () => {
  it("resumes the agent when the repo auto-resumes", async () => {
    const task = await taskWithOpenPr({ autoResume: true });

    // CI is running: nothing to do but show it.
    await watcherTick();
    expect(await rowOf(task.id)).toMatchObject({ state: "pr_opened", prChecksStatus: "pending" });

    // CI fails. The watcher's poll is what notices (no other producer wakes
    // the reconciler for a PR that just sits there), then the reconciler runs.
    checks = FAILING;
    await watcherTick();

    expect((await rowOf(task.id)).state).toBe("queued");
    expect(await triggersOf(task.id)).toEqual(["ci_failing", "auto_resume_ci-fix"]);
    const jobs = await resumeJobsFor(task.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data.resumePrompt).toContain("CI checks are failing");
    expect(jobs[0].data.restartFromBranch).toBe(true);
  });

  it("resumes once when the watcher polled several times before the reconciler ran", async () => {
    const task = await taskWithOpenPr({ autoResume: true });
    await watcherTick();

    // A busy reconciler: two watcher ticks go by before it gets to the task.
    await reconciler.pause();
    checks = FAILING;
    await pollPrs();
    await pollPrs();
    reconciler.resume();
    await settled();

    expect((await rowOf(task.id)).state).toBe("queued");
    expect(await triggersOf(task.id)).toEqual(["ci_failing", "auto_resume_ci-fix"]);
    expect(await resumeJobsFor(task.id)).toHaveLength(1);
  });

  it("resumes for a failure that was already there at the first poll", async () => {
    const task = await taskWithOpenPr({ autoResume: true });
    checks = FAILING;
    await watcherTick();
    expect((await rowOf(task.id)).state).toBe("queued");
    expect(await resumeJobsFor(task.id)).toHaveLength(1);
  });

  it("asks for a person, once, when the repo does not auto-resume", async () => {
    const task = await taskWithOpenPr({ autoResume: false });
    await watcherTick();
    checks = FAILING;
    await watcherTick();

    expect(await rowOf(task.id)).toMatchObject({
      state: "needs_attention",
      prChecksStatus: "failing",
    });
    expect(await triggersOf(task.id)).toEqual(["ci_failing"]);
    expect(await resumeJobsFor(task.id)).toHaveLength(0);
  });

  it("leaves a task that already failed as it is, and shows the failing CI", async () => {
    const repo = await insertRepo({ autoResume: true, autoMerge: false, reviewEnabled: false });
    const task = await insertTask({
      repoUrl: repo.repoUrl,
      state: "failed",
      prUrl: pr.url,
      prState: "open",
      prChecksStatus: "pending",
    });
    checks = FAILING;
    await watcherTick();
    await watcherTick();

    expect(await rowOf(task.id)).toMatchObject({ state: "failed", prChecksStatus: "failing" });
    expect(await triggersOf(task.id)).toEqual([]);
    expect(await resumeJobsFor(task.id)).toHaveLength(0);
  });
});

describe("what the row shows after a watcher tick", () => {
  it("follows the PR's checks while nothing needs doing", async () => {
    const task = await taskWithOpenPr({ autoResume: true });
    await watcherTick();
    expect(await rowOf(task.id)).toMatchObject({
      prNumber: 42,
      prState: "open",
      prChecksStatus: "pending",
      prReviewStatus: "none",
    });

    checks = PASSING;
    await watcherTick();
    expect(await rowOf(task.id)).toMatchObject({ state: "pr_opened", prChecksStatus: "passing" });

    checks = [];
    pr.headSha = "head-b";
    await watcherTick();
    expect(await rowOf(task.id)).toMatchObject({ state: "pr_opened", prChecksStatus: "none" });
  });

  it("keeps the checks an auto-merge went through on", async () => {
    const task = await taskWithOpenPr({ autoMerge: true });
    await watcherTick();
    expect(await rowOf(task.id)).toMatchObject({ state: "pr_opened", prChecksStatus: "pending" });

    checks = PASSING;
    await watcherTick();
    expect(git.mergePullRequest).toHaveBeenCalledOnce();
    expect(await rowOf(task.id)).toMatchObject({
      state: "completed",
      prState: "merged",
      prChecksStatus: "passing",
    });
  });
});
