/**
 * An automatic resume reads the MR's target branch and the failed jobs'
 * logs before it transitions (services/resume-facts.ts), which takes
 * seconds. Pipeline webhooks and the PR poll can queue several reconcile
 * passes for one task, and the worker runs several at once: two passes that
 * read the same pre-resume snapshot must not both resume it. Once the first
 * pass's resume has moved the task on (its new run already RUNNING, which
 * may go to NEEDS_ATTENTION and back to QUEUED), the second is stale
 * (reconcile-executor.ts `applyResumeAgent`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Queue } from "bullmq";
import { TaskState, type RepoAction } from "@optio/shared";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { insertTask } from "../test-utils/integration/fixtures.js";
import { buildWorldSnapshot } from "./reconcile-snapshot.js";
import { executeAction } from "./reconcile-executor.js";
import { getBullMQConnectionOptions } from "./redis-config.js";
import * as taskService from "./task-service.js";

const tasksQueue = new Queue("tasks", { connection: getBullMQConnectionOptions() });

afterAll(async () => {
  await tasksQueue.close();
  const { taskQueue } = await import("../workers/task-worker.js");
  await taskQueue.close();
  const { reconcileQueue } = await import("./reconcile-queue.js");
  await reconcileQueue.close();
  const { getRedisClient } = await import("./event-bus.js");
  await getRedisClient().quit();
});

async function resumeJobsFor(taskId: string) {
  const jobs = await tasksQueue.getJobs(["waiting", "prioritized", "delayed"]);
  return jobs.filter((j) => (j.data as { taskId?: string }).taskId === taskId);
}

describe("an automatic resume from a snapshot the task has moved past", () => {
  it("is stale: the task is resumed once, and its running attempt is left alone", async () => {
    const task = await insertTask({
      state: TaskState.PR_OPENED,
      prUrl: "https://github.com/it-org/race/pull/7",
      sessionId: "sess-1",
    });
    // Two passes read the task before either acts.
    const snapshot = await buildWorldSnapshot({ kind: "repo", id: task.id });
    if (!snapshot) throw new Error("no snapshot");
    const resume: RepoAction = {
      kind: "resumeAgent",
      resumeReason: "review",
      reason: "review_changes_requested",
    };

    expect(await executeAction(resume, snapshot)).toEqual({
      status: "applied",
      reason: "resume:review",
    });
    // The task worker takes the resume and the new attempt starts.
    await taskService.transitionTask(task.id, TaskState.PROVISIONING, "it_claim");
    await taskService.transitionTask(task.id, TaskState.RUNNING, "it_running");

    expect(await executeAction(resume, snapshot)).toEqual({
      status: "stale",
      reason: "cas_failed_resume",
    });
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.state).toBe(TaskState.RUNNING);
    expect(await resumeJobsFor(task.id)).toHaveLength(1);
  });
});
