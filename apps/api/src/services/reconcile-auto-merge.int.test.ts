import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { reconcileRepo, type CICheck, type PullRequest } from "@optio/shared";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { insertRepo, insertTask } from "../test-utils/integration/fixtures.js";
import { buildWorldSnapshot } from "./reconcile-snapshot.js";
import { executeAction } from "./reconcile-executor.js";
import { getRedisClient } from "./event-bus.js";
import { reconcileQueue } from "./reconcile-queue.js";

// These tests run with the automatic-merge confirmation on (off by default).
vi.hoisted(() => {
  process.env.OPTIO_MERGE_CONFIRMATION = "true";
});

// Only the external git host is mocked. Snapshots, decisions, execution,
// state transitions, retry jobs and the shared grace period use real DB/Redis.
const git = vi.hoisted(() => ({
  getPullRequest: vi.fn(),
  getCIChecks: vi.fn(),
  getReviews: vi.fn(),
  mergePullRequest: vi.fn(),
}));
vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: async () => ({
    platform: { type: "github", ...git },
    ri: {
      platform: "github",
      host: "github.com",
      owner: "it-org",
      repo: "merge",
      apiBaseUrl: "https://api.github.com",
    },
  }),
}));

let pr: PullRequest;
let checks: CICheck[];

beforeEach(() => {
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
    url: "https://github.com/it-org/merge/pull/42",
    author: "it",
    assignees: [],
    labels: [],
    createdAt: "",
    updatedAt: "",
  };
  checks = [];
  git.getPullRequest.mockImplementation(async () => ({ ...pr }));
  git.getCIChecks.mockImplementation(async () => checks);
  git.getReviews.mockResolvedValue([]);
  git.mergePullRequest.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await reconcileQueue.close();
  const { prWatcherQueue } = await import("../workers/pr-watcher-worker.js");
  await prWatcherQueue.close();
  await getRedisClient().quit();
});

async function candidate() {
  // Confirmed: the checkbox AND the dialog (shared work/auto-merge.ts).
  const repo = await insertRepo({
    autoMerge: true,
    autoMergeConfirmedAt: new Date(),
    reviewEnabled: false,
  });
  return insertTask({
    repoUrl: repo.repoUrl,
    state: "pr_opened",
    prUrl: pr.url,
    prChecksStatus: "none",
  });
}

async function pass(taskId: string) {
  const snapshot = await buildWorldSnapshot({ kind: "repo", id: taskId });
  if (!snapshot) throw new Error("missing task");
  const action = reconcileRepo(snapshot);
  const outcome = await executeAction(action, snapshot);
  return { snapshot, action, outcome };
}

describe("automatic merge safety without changing no-CI policy", () => {
  it("waits on empty checks, then merges the same head without requiring new settings", async () => {
    const task = await candidate();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    expect((await pass(task.id)).outcome.reason).toBe("auto_merge_waiting_for_checks");
    expect(git.mergePullRequest).not.toHaveBeenCalled();
    const retry = (await reconcileQueue.getJobs(["delayed"])).find(
      (j) => j.data.ref.id === task.id,
    );
    expect(retry?.data.reason).toBe("auto_merge_waiting_for_checks");

    // A fresh snapshot/execution reads the same Redis observation, as a
    // different API replica or a restarted process would.
    now += 59_999;
    expect((await pass(task.id)).outcome.reason).toBe("auto_merge_waiting_for_checks");
    now += 1;
    expect((await pass(task.id)).outcome.reason).toBe("auto_merged");
    expect(git.mergePullRequest).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      42,
      "squash",
      "head-a",
    );
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.state).toBe("completed");
    expect(row.prState).toBe("merged");
  });

  it("waits for checks registered during the grace period and merges once they pass", async () => {
    const task = await candidate();
    expect((await pass(task.id)).outcome.reason).toBe("auto_merge_waiting_for_checks");
    checks = [{ name: "test", status: "queued", conclusion: null }];
    expect((await pass(task.id)).action.kind).not.toBe("autoMergePr");
    expect(git.mergePullRequest).not.toHaveBeenCalled();
    checks = [{ name: "test", status: "completed", conclusion: "success" }];
    expect((await pass(task.id)).outcome.reason).toBe("auto_merged");
  });

  it("a new head gets its own grace period even after the old one expires", async () => {
    const task = await candidate();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await pass(task.id);
    now += 60_000;
    pr.headSha = "head-b";
    expect((await pass(task.id)).outcome.reason).toBe("auto_merge_waiting_for_checks");
    expect(git.mergePullRequest).not.toHaveBeenCalled();
    now += 60_000;
    expect((await pass(task.id)).outcome.reason).toBe("auto_merged");
    expect(git.mergePullRequest).toHaveBeenCalledWith(expect.anything(), 42, "squash", "head-b");
  });

  it("records a failed CI read and defers instead of treating it as no CI", async () => {
    const task = await candidate();
    git.getCIChecks.mockRejectedValue(new Error("CI API unavailable"));
    const { snapshot, action } = await pass(task.id);
    expect(snapshot.readErrors).toContainEqual({
      source: "pr",
      message: "Error: CI API unavailable",
    });
    expect(action.kind).toBe("deferWithBackoff");
    expect(git.mergePullRequest).not.toHaveBeenCalled();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.state).toBe("pr_opened");
    expect(row.reconcileBackoffUntil).not.toBeNull();
  });

  it("still completes an already merged PR when CI is unavailable", async () => {
    const task = await candidate();
    pr.merged = true;
    pr.state = "closed";
    git.getCIChecks.mockRejectedValue(new Error("CI API unavailable"));
    const { action } = await pass(task.id);
    expect(action).toMatchObject({ kind: "transition", to: "completed" });
    expect(git.getCIChecks).toHaveBeenCalledOnce();
    expect(git.mergePullRequest).not.toHaveBeenCalled();
  });
});

describe("automatic merge needs a person's confirmation", () => {
  it("never merges a repo whose auto-merge nobody confirmed", async () => {
    const repo = await insertRepo({ autoMerge: true, reviewEnabled: false });
    const task = await insertTask({
      repoUrl: repo.repoUrl,
      state: "pr_opened",
      prUrl: pr.url,
      prChecksStatus: "passing",
    });
    checks = [{ name: "ci", status: "completed", conclusion: "success" }];
    const { snapshot, action } = await pass(task.id);
    expect(snapshot.settings).toMatchObject({ autoMerge: true, autoMergeConfirmed: false });
    expect(action.kind).not.toBe("autoMergePr");
    expect(git.mergePullRequest).not.toHaveBeenCalled();
  });

  it("never merges over a reviewer's requested changes", async () => {
    const task = await candidate();
    checks = [{ name: "ci", status: "completed", conclusion: "success" }];
    git.getReviews.mockResolvedValue([{ author: "ann", state: "CHANGES_REQUESTED", body: "no" }]);
    for (let i = 0; i < 3; i++) await pass(task.id);
    expect(git.mergePullRequest).not.toHaveBeenCalled();
  });
});
