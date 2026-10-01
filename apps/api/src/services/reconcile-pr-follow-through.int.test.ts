/**
 * "Works until merged": a task's own PR follow-through (`tasks.auto_resume` /
 * `tasks.auto_merge`) wins over the repo's settings in the reconciler's
 * snapshot, null falls back to the repo, and a scheduled Task copies its
 * follow-through onto every task it spawns.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { insertRepo, insertTask } from "../test-utils/integration/fixtures.js";
import { buildWorldSnapshot } from "./reconcile-snapshot.js";
import * as taskConfigService from "./task-config-service.js";

afterAll(async () => {
  const { taskQueue } = await import("../workers/task-worker.js");
  await taskQueue.close();
  const { reconcileQueue } = await import("./reconcile-queue.js");
  await reconcileQueue.close();
  const { getRedisClient } = await import("./event-bus.js");
  await getRedisClient().quit();
});

async function settingsFor(taskId: string) {
  const snapshot = await buildWorldSnapshot({ kind: "repo", id: taskId });
  if (!snapshot) throw new Error("no snapshot");
  return snapshot.settings;
}

describe("PR follow-through in the repo snapshot", () => {
  it("a task with no follow-through of its own takes the repo's", async () => {
    const repo = await insertRepo({ autoResume: true, autoMerge: false });
    const task = await insertTask({ repoUrl: repo.repoUrl });
    const s = await settingsFor(task.id);
    expect(s.autoResume).toBe(true);
    expect(s.autoMerge).toBe(false);
  });

  it("'works until merged' resumes and merges even when the repo doesn't", async () => {
    const repo = await insertRepo({ autoResume: false, autoMerge: false });
    const task = await insertTask({ repoUrl: repo.repoUrl, autoResume: true, autoMerge: true });
    const s = await settingsFor(task.id);
    expect(s.autoResume).toBe(true);
    expect(s.autoMerge).toBe(true);
  });

  it("an explicit false turns off what the repo would do", async () => {
    const repo = await insertRepo({ autoResume: true, autoMerge: true });
    const task = await insertTask({ repoUrl: repo.repoUrl, autoResume: true, autoMerge: false });
    const s = await settingsFor(task.id);
    expect(s.autoResume).toBe(true);
    expect(s.autoMerge).toBe(false);
  });

  it("cautious mode is still reported, so the merge stays held back", async () => {
    const repo = await insertRepo({ cautiousMode: true });
    const task = await insertTask({ repoUrl: repo.repoUrl, autoResume: true, autoMerge: true });
    const s = await settingsFor(task.id);
    expect(s.autoMerge).toBe(true);
    expect(s.cautiousMode).toBe(true);
  });
});

describe("scheduled Tasks pass their follow-through to spawned tasks", () => {
  it("instantiateTask copies auto_resume / auto_merge", async () => {
    const repo = await insertRepo();
    const config = await taskConfigService.createTaskConfig({
      name: "until merged",
      title: "until merged",
      prompt: "fix it",
      repoUrl: repo.repoUrl,
      autoResume: true,
      autoMerge: false,
    });
    expect(config.autoResume).toBe(true);
    expect(config.autoMerge).toBe(false);

    const spawned = await taskConfigService.instantiateTask(config.id);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, spawned.id));
    expect(row.autoResume).toBe(true);
    expect(row.autoMerge).toBe(false);
  });

  it("a config without follow-through spawns tasks that follow the repo", async () => {
    const repo = await insertRepo();
    const config = await taskConfigService.createTaskConfig({
      name: "repo decides",
      title: "repo decides",
      prompt: "fix it",
      repoUrl: repo.repoUrl,
    });
    const spawned = await taskConfigService.instantiateTask(config.id);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, spawned.id));
    expect(row.autoResume).toBeNull();
    expect(row.autoMerge).toBeNull();
  });

  it("updateTaskConfig can set and clear follow-through", async () => {
    const repo = await insertRepo();
    const config = await taskConfigService.createTaskConfig({
      name: "toggle",
      title: "toggle",
      prompt: "fix it",
      repoUrl: repo.repoUrl,
    });
    const on = await taskConfigService.updateTaskConfig(config.id, {
      autoResume: true,
      autoMerge: true,
    });
    expect(on?.autoResume).toBe(true);
    const off = await taskConfigService.updateTaskConfig(config.id, {
      autoResume: null,
      autoMerge: null,
    });
    expect(off?.autoResume).toBeNull();
    expect(off?.autoMerge).toBeNull();
  });
});
