/**
 * Outbound webhooks belong to a workspace (Settings → Webhooks lists the
 * workspace's own). A task's or a Job run's events go to the webhooks of the
 * workspace the work is in, never to another workspace's.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { TaskState } from "@optio/shared";
import { db } from "../db/client.js";
import { webhooks } from "../db/schema.js";
import { getBullMQOptions } from "./redis-config.js";
import { getRedisClient } from "./event-bus.js";
import { transitionTask } from "./task-service.js";
import { createWorkflowRun } from "./workflow-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { workflowRunQueue } from "../workers/workflow-worker.js";
import { reconcileQueue } from "./reconcile-queue.js";
import { insertTask, insertWorkflow, insertWorkspace } from "../test-utils/integration/fixtures.js";

const queue = new Queue("webhooks", { ...getBullMQOptions() });

afterAll(async () => {
  await Promise.allSettled([
    queue.close(),
    taskQueue.close(),
    workflowRunQueue.close(),
    reconcileQueue.close(),
    getRedisClient().quit(),
  ]);
});

async function insertWebhook(workspaceId: string, events: string[]) {
  const [row] = await db
    .insert(webhooks)
    .values({ url: "https://hooks.example.test/in", workspaceId, events })
    .returning();
  return row.id;
}

/** Webhook ids that got a delivery job, among `ids`. */
async function deliveredTo(ids: string[]): Promise<string[]> {
  const jobs = await queue.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
  return [...new Set(jobs.map((j) => j.data.webhookId as string).filter((id) => ids.includes(id)))];
}

/** Delivery jobs are added one webhook at a time: let the rest of them land. */
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("outbound webhooks stay within the workspace (integration)", () => {
  it("delivers a task's events only to its own workspace's webhooks", async () => {
    const a = await insertWorkspace();
    const b = await insertWorkspace();
    const hookA = await insertWebhook(a.id, ["task.failed"]);
    const hookB = await insertWebhook(b.id, ["task.failed"]);
    const task = await insertTask({ workspaceId: a.id, state: "running" });

    await transitionTask(task.id, TaskState.FAILED, "test");

    await expect.poll(() => deliveredTo([hookA, hookB])).toContain(hookA);
    await settle();
    expect(await deliveredTo([hookA, hookB])).toEqual([hookA]);
  });

  it("delivers a Job run's events only to its Job's workspace's webhooks", async () => {
    const a = await insertWorkspace();
    const b = await insertWorkspace();
    const hookA = await insertWebhook(a.id, ["workflow_run.queued"]);
    const hookB = await insertWebhook(b.id, ["workflow_run.queued"]);
    const job = await insertWorkflow({ workspaceId: a.id });

    await createWorkflowRun(job.id);

    await expect.poll(() => deliveredTo([hookA, hookB])).toContain(hookA);
    await settle();
    expect(await deliveredTo([hookA, hookB])).toEqual([hookA]);
  });
});
