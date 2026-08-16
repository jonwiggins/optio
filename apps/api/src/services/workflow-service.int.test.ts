/**
 * Integration tests for the workflow (Job) service — CRUD + run lifecycle
 * against this file's private Postgres and leased Redis logical DB.
 *
 * Covers:
 *   - createWorkflow / updateWorkflow / deleteWorkflow roundtrip, including
 *     the (workspace_id, name) unique constraint
 *   - createWorkflowRun: queued row insert + BullMQ enqueue on "workflow-runs"
 *   - transitionWorkflowRunState state-machine enforcement
 *   - appendWorkflowRunLog / getWorkflowRunLogs roundtrip incl. logType filter
 *   - retryWorkflowRun / cancelWorkflowRun state rules, incl. cancel
 *     exhausting the retry budget so the reconciler cannot auto-retry
 *     a user-cancelled run
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { WorkflowRunState, reconcileStandalone } from "@optio/shared";
import { db } from "../db/client.js";
import { workflowRuns } from "../db/schema.js";
import * as workflowService from "./workflow-service.js";
import { buildWorldSnapshot } from "./reconcile-snapshot.js";
import { getBullMQConnectionOptions } from "./redis-config.js";
import {
  insertWorkflow,
  insertWorkflowRun,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";

// Independent handle on the same queue the service enqueues to (name +
// connection options must match workers/workflow-worker.ts). No worker is
// started in this file, so enqueued jobs stay waiting and are inspectable.
const workflowRunsQueue = new Queue("workflow-runs", { connection: getBullMQConnectionOptions() });

afterAll(async () => {
  await workflowRunsQueue.close();
  // createWorkflowRun dynamically imports the worker module (for its queue
  // singleton) and the event bus publisher; close both so the fork exits.
  const { workflowRunQueue } = await import("../workers/workflow-worker.js");
  await workflowRunQueue.close();
  const { getRedisClient } = await import("./event-bus.js");
  await getRedisClient().quit();
});

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms${opts.label ? `: ${opts.label}` : ""}`,
      );
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 100));
  }
}

describe("workflow CRUD", () => {
  it("createWorkflow persists schema defaults and getWorkflow roundtrips", async () => {
    const created = await workflowService.createWorkflow({
      name: `it-crud-${randomUUID().slice(0, 8)}`,
      promptTemplate: "do the thing with {{PARAM}}",
      description: "integration crud",
    });

    expect(created.id).toBeTruthy();
    expect(created.agentRuntime).toBe("claude-code");
    expect(created.maxConcurrent).toBe(2);
    expect(created.maxRetries).toBe(1);
    expect(created.warmPoolSize).toBe(0);
    expect(created.maxPodInstances).toBe(1);
    expect(created.maxAgentsPerPod).toBe(2);
    expect(created.enabled).toBe(true);
    expect(created.workspaceId).toBeNull();

    const fetched = await workflowService.getWorkflow(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe(created.name);
    expect(fetched!.promptTemplate).toBe("do the thing with {{PARAM}}");
    expect(fetched!.description).toBe("integration crud");
  });

  it("rejects duplicate names within a workspace but allows them with null workspace", async () => {
    const ws = await insertWorkspace();
    const name = `it-dup-${randomUUID().slice(0, 8)}`;

    await workflowService.createWorkflow({ name, promptTemplate: "p", workspaceId: ws.id });
    // Drizzle wraps the PG error ("Failed query: ...") — the unique-violation
    // detail is on the error's `cause` chain.
    const err = await workflowService
      .createWorkflow({ name, promptTemplate: "p", workspaceId: ws.id })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).cause ?? err)).toMatch(
      /duplicate key value.*workflows_workspace_name_key/,
    );

    // Actual behavior: the unique constraint is (workspace_id, name) and
    // Postgres treats NULLs as distinct, so workspace-less duplicates insert.
    const a = await workflowService.createWorkflow({ name, promptTemplate: "p" });
    const b = await workflowService.createWorkflow({ name, promptTemplate: "p" });
    expect(a.id).not.toBe(b.id);
  });

  it("updateWorkflow updates fields and returns null for an unknown id", async () => {
    const wf = await insertWorkflow();

    const updated = await workflowService.updateWorkflow(wf.id, {
      description: "updated desc",
      model: "claude-sonnet-4-5",
      maxConcurrent: 7,
      enabled: false,
    });

    expect(updated).not.toBeNull();
    expect(updated!.description).toBe("updated desc");
    expect(updated!.model).toBe("claude-sonnet-4-5");
    expect(updated!.maxConcurrent).toBe(7);
    expect(updated!.enabled).toBe(false);
    // untouched fields survive
    expect(updated!.name).toBe(wf.name);
    expect(updated!.promptTemplate).toBe(wf.promptTemplate);
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(wf.updatedAt.getTime());

    expect(await workflowService.updateWorkflow(randomUUID(), { description: "x" })).toBeNull();
  });

  it("deleteWorkflow removes the row (cascading its runs) and returns false for unknown ids", async () => {
    const wf = await insertWorkflow();
    const run = await insertWorkflowRun(wf.id);

    expect(await workflowService.deleteWorkflow(wf.id)).toBe(true);
    expect(await workflowService.getWorkflow(wf.id)).toBeNull();

    const orphaned = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    expect(orphaned).toHaveLength(0);

    expect(await workflowService.deleteWorkflow(wf.id)).toBe(false);
  });
});

describe("createWorkflowRun", () => {
  it("inserts a queued run and enqueues a BullMQ job on workflow-runs keyed by run id", async () => {
    const wf = await insertWorkflow();

    const run = await workflowService.createWorkflowRun(wf.id, { params: { PARAM: "x" } });

    expect(run.workflowId).toBe(wf.id);
    expect(run.state).toBe(WorkflowRunState.QUEUED);
    expect(run.params).toEqual({ PARAM: "x" });
    expect(run.retryCount).toBe(0);

    const persisted = await workflowService.getWorkflowRun(run.id);
    expect(persisted).not.toBeNull();
    expect(persisted!.state).toBe("queued");

    // The enqueue is fire-and-forget (dynamic import inside the service),
    // so poll for the job rather than expecting it synchronously.
    const job = await waitFor(() => workflowRunsQueue.getJob(run.id), {
      label: `bullmq job ${run.id}`,
    });
    expect(job.id).toBe(run.id);
    expect(job.name).toBe("process-workflow-run");
    expect(job.data).toEqual({ workflowRunId: run.id });
  });

  it("rejects a missing workflow", async () => {
    await expect(workflowService.createWorkflowRun(randomUUID())).rejects.toThrow(
      "Workflow not found",
    );
  });

  it("rejects a disabled workflow", async () => {
    const wf = await insertWorkflow({ enabled: false });
    await expect(workflowService.createWorkflowRun(wf.id)).rejects.toThrow("Workflow is disabled");
  });
});

describe("transitionWorkflowRunState", () => {
  it("walks queued → running → completed, stamping timestamps and extras", async () => {
    const wf = await insertWorkflow();
    const run = await insertWorkflowRun(wf.id); // state defaults to "queued"

    await workflowService.transitionWorkflowRunState(run.id, WorkflowRunState.RUNNING);
    let current = await workflowService.getWorkflowRun(run.id);
    expect(current!.state).toBe("running");
    expect(current!.startedAt).toBeInstanceOf(Date);
    expect(current!.finishedAt).toBeNull();

    await workflowService.transitionWorkflowRunState(run.id, WorkflowRunState.COMPLETED, {
      costUsd: "0.0421",
      inputTokens: 111,
      outputTokens: 222,
      modelUsed: "claude-sonnet-4-5",
    });
    current = await workflowService.getWorkflowRun(run.id);
    expect(current!.state).toBe("completed");
    expect(current!.finishedAt).toBeInstanceOf(Date);
    expect(current!.costUsd).toBe("0.0421");
    expect(current!.inputTokens).toBe(111);
    expect(current!.outputTokens).toBe(222);
    expect(current!.modelUsed).toBe("claude-sonnet-4-5");
  });

  it("rejects illegal transitions and leaves the row untouched", async () => {
    const wf = await insertWorkflow();

    // queued → completed skips running
    const queued = await insertWorkflowRun(wf.id);
    await expect(
      workflowService.transitionWorkflowRunState(queued.id, WorkflowRunState.COMPLETED),
    ).rejects.toThrow("Invalid workflow run transition: queued → completed");
    expect((await workflowService.getWorkflowRun(queued.id))!.state).toBe("queued");

    // completed is terminal
    const completed = await insertWorkflowRun(wf.id, { state: "completed" });
    await expect(
      workflowService.transitionWorkflowRunState(completed.id, WorkflowRunState.RUNNING),
    ).rejects.toThrow("Invalid workflow run transition: completed → running");
    expect((await workflowService.getWorkflowRun(completed.id))!.state).toBe("completed");
  });

  it("rejects an unknown run id", async () => {
    const missing = randomUUID();
    await expect(
      workflowService.transitionWorkflowRunState(missing, WorkflowRunState.RUNNING),
    ).rejects.toThrow(`Workflow run ${missing} not found`);
  });
});

describe("workflow run logs", () => {
  it("appendWorkflowRunLog + getWorkflowRunLogs roundtrip in timestamp order, scoped per run", async () => {
    const wf = await insertWorkflow();
    const run = await insertWorkflowRun(wf.id);
    const otherRun = await insertWorkflowRun(wf.id);

    await workflowService.appendWorkflowRunLog({ workflowRunId: run.id, content: "line one" });
    await workflowService.appendWorkflowRunLog({
      workflowRunId: run.id,
      content: "thinking...",
      logType: "agent",
      metadata: { turn: 1 },
    });
    await workflowService.appendWorkflowRunLog({
      workflowRunId: run.id,
      content: "something odd",
      stream: "stderr",
      logType: "system",
    });
    await workflowService.appendWorkflowRunLog({
      workflowRunId: otherRun.id,
      content: "other run's log",
    });

    const all = await workflowService.getWorkflowRunLogs(run.id);
    expect(all).toHaveLength(3);
    expect(all.map((l) => l.content)).toEqual(["line one", "thinking...", "something odd"]);
    // defaults + explicit values persist
    expect(all[0].stream).toBe("stdout");
    expect(all[0].logType).toBeNull();
    expect(all[1].metadata).toEqual({ turn: 1 });
    expect(all[2].stream).toBe("stderr");
    // ordered by timestamp ascending
    const times = all.map((l) => l.timestamp.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // other run's logs are not mixed in
    expect(all.every((l) => l.workflowRunId === run.id)).toBe(true);
  });

  it("filters by logType and honors limit", async () => {
    const wf = await insertWorkflow();
    const run = await insertWorkflowRun(wf.id);

    await workflowService.appendWorkflowRunLog({ workflowRunId: run.id, content: "raw" });
    await workflowService.appendWorkflowRunLog({
      workflowRunId: run.id,
      content: "agent a",
      logType: "agent",
    });
    await workflowService.appendWorkflowRunLog({
      workflowRunId: run.id,
      content: "agent b",
      logType: "agent",
    });
    await workflowService.appendWorkflowRunLog({
      workflowRunId: run.id,
      content: "sys",
      logType: "system",
    });

    const agentOnly = await workflowService.getWorkflowRunLogs(run.id, { logType: "agent" });
    expect(agentOnly.map((l) => l.content)).toEqual(["agent a", "agent b"]);

    const limited = await workflowService.getWorkflowRunLogs(run.id, { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((l) => l.content)).toEqual(["raw", "agent a"]);

    const filteredAndLimited = await workflowService.getWorkflowRunLogs(run.id, {
      logType: "agent",
      limit: 1,
    });
    expect(filteredAndLimited.map((l) => l.content)).toEqual(["agent a"]);
  });
});

describe("retryWorkflowRun / cancelWorkflowRun", () => {
  it("retry flips a failed run to queued, bumps retryCount, and clears error state", async () => {
    const wf = await insertWorkflow();
    const run = await insertWorkflowRun(wf.id, {
      state: "failed",
      errorMessage: "boom",
      finishedAt: new Date(),
      retryCount: 1,
    });

    const updated = await workflowService.retryWorkflowRun(run.id);
    expect(updated.state).toBe(WorkflowRunState.QUEUED);
    expect(updated.retryCount).toBe(2);
    expect(updated.errorMessage).toBeNull();
    expect(updated.finishedAt).toBeNull();

    // Actual behavior: retryWorkflowRun does NOT re-enqueue the BullMQ job
    // itself — the reconciler's enqueueAgent action owns re-dispatch. Probe
    // by job DATA (enqueue paths use suffixed jobIds, so getJob(run.id)
    // would be vacuously empty) after a settle window for fire-and-forget.
    await new Promise((r) => setTimeout(r, 500));
    const jobs = await workflowRunsQueue.getJobs(["waiting", "delayed", "active", "prioritized"]);
    expect(jobs.filter((j) => j.data?.workflowRunId === run.id)).toHaveLength(0);
  });

  it("retry rejects runs that are not failed", async () => {
    const wf = await insertWorkflow();

    const queued = await insertWorkflowRun(wf.id);
    await expect(workflowService.retryWorkflowRun(queued.id)).rejects.toThrow(
      'Cannot retry workflow run in state "queued"',
    );

    const completed = await insertWorkflowRun(wf.id, { state: "completed" });
    await expect(workflowService.retryWorkflowRun(completed.id)).rejects.toThrow(
      'Cannot retry workflow run in state "completed"',
    );

    await expect(workflowService.retryWorkflowRun(randomUUID())).rejects.toThrow(
      "Workflow run not found",
    );
  });

  it("cancel fails a queued run with a cancellation message and exhausts the retry budget", async () => {
    const wf = await insertWorkflow({ maxRetries: 3 });
    const run = await insertWorkflowRun(wf.id); // queued

    const cancelled = await workflowService.cancelWorkflowRun(run.id);
    expect(cancelled.state).toBe(WorkflowRunState.FAILED);
    expect(cancelled.errorMessage).toBe("Cancelled by user");
    expect(cancelled.finishedAt).toBeInstanceOf(Date);
    // retryCount is stamped to the workflow's maxRetries so the reconciler's
    // decideFailed — which auto-retries any FAILED run with budget left and
    // cannot tell a user cancel from an agent failure — leaves it alone.
    expect(cancelled.retryCount).toBe(3);

    // Prove it end-to-end against the reconciler's decision function: the
    // cancelled run's snapshot decides noop, not auto_retry back to QUEUED.
    const snapshot = await buildWorldSnapshot({ kind: "standalone", id: run.id });
    expect(snapshot).not.toBeNull();
    expect(reconcileStandalone(snapshot!)).toEqual({
      kind: "noop",
      reason: "failed_no_retry_intent",
    });
  });

  it("cancel never lowers a retryCount already above the workflow's maxRetries", async () => {
    const wf = await insertWorkflow({ maxRetries: 1 });
    const run = await insertWorkflowRun(wf.id, { state: "running", retryCount: 4 });

    const cancelled = await workflowService.cancelWorkflowRun(run.id);
    expect(cancelled.state).toBe(WorkflowRunState.FAILED);
    expect(cancelled.retryCount).toBe(4);
  });

  it("cancel rejects runs already in a state that cannot fail", async () => {
    const wf = await insertWorkflow();

    const completed = await insertWorkflowRun(wf.id, { state: "completed" });
    await expect(workflowService.cancelWorkflowRun(completed.id)).rejects.toThrow(
      'Cannot cancel workflow run in state "completed"',
    );

    // failed → failed is not a legal transition either
    const failed = await insertWorkflowRun(wf.id, { state: "failed" });
    await expect(workflowService.cancelWorkflowRun(failed.id)).rejects.toThrow(
      'Cannot cancel workflow run in state "failed"',
    );

    await expect(workflowService.cancelWorkflowRun(randomUUID())).rejects.toThrow(
      "Workflow run not found",
    );
  });
});
