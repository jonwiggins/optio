/**
 * A repo URL may be registered in several workspaces, each with its own
 * settings. Work reads the settings of its own workspace's registration:
 * a task in B never posts to the Slack channel the default workspace set
 * up for the same repo.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { TaskState } from "@optio/shared";
import { db } from "../db/client.js";
import { workspaces } from "../db/schema.js";
import { getRedisClient } from "./event-bus.js";
import { taskQueue } from "../workers/task-worker.js";
import { reconcileQueue } from "./reconcile-queue.js";
import { insertRepo, insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";

const slackCalls: Array<{ taskId: string; repoWorkspace: string | null; channel: string | null }> =
  [];
vi.mock("./slack-service.js", () => ({
  notifySlackOnTransition: async (
    task: { id: string },
    _state: string,
    repo: { workspaceId: string | null; slackChannel: string | null } | null,
  ) => {
    slackCalls.push({
      taskId: task.id,
      repoWorkspace: repo?.workspaceId ?? null,
      channel: repo?.slackChannel ?? null,
    });
  },
}));

const { transitionTask, getRepoConfig } = await import("./task-service.js");

afterAll(async () => {
  await Promise.allSettled([taskQueue.close(), reconcileQueue.close(), getRedisClient().quit()]);
});

async function defaultWorkspaceId() {
  const [row] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, "default"));
  return row?.id ?? (await insertWorkspace({ slug: "default" })).id;
}

describe("repo settings follow the work's workspace (integration)", () => {
  it("notifies the task's own workspace's Slack channel for a repo registered twice", async () => {
    const home = await defaultWorkspaceId();
    const b = (await insertWorkspace()).id;
    const repoUrl = `https://github.com/it-org/slack-${Date.now().toString(36)}`;
    const fullName = repoUrl.replace("https://github.com/", "");
    await insertRepo({
      workspaceId: home,
      repoUrl,
      fullName,
      slackEnabled: true,
      slackChannel: "#default",
    });
    await insertRepo({
      workspaceId: b,
      repoUrl,
      fullName,
      slackEnabled: true,
      slackChannel: "#b",
    });
    const task = await insertTask({ workspaceId: b, repoUrl, state: "running" });

    await transitionTask(task.id, TaskState.FAILED, "test");

    await expect.poll(() => slackCalls.find((c) => c.taskId === task.id)).toBeTruthy();
    expect(slackCalls.find((c) => c.taskId === task.id)).toEqual({
      taskId: task.id,
      repoWorkspace: b,
      channel: "#b",
    });
  });

  it("reads a repo's stall settings in the given workspace", async () => {
    const a = (await insertWorkspace()).id;
    const b = (await insertWorkspace()).id;
    const repoUrl = `https://github.com/it-org/stall-${Date.now().toString(36)}`;
    const fullName = repoUrl.replace("https://github.com/", "");
    await insertRepo({ workspaceId: a, repoUrl, fullName, stallThresholdMs: 1000 });
    await insertRepo({ workspaceId: b, repoUrl, fullName, stallThresholdMs: 2000 });
    expect((await getRepoConfig(repoUrl, a))?.stallThresholdMs).toBe(1000);
    expect((await getRepoConfig(repoUrl, b))?.stallThresholdMs).toBe(2000);
  });
});
