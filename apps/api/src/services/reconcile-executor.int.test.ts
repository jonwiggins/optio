/**
 * Integration tests for the reconcile snapshot→decide→execute cycle for the
 * STANDALONE kind (workflow_runs), against the real per-file database and
 * Redis.
 *
 * The reconcile worker (workers/reconcile-worker.ts) exports no per-job entry
 * point — its BullMQ processor inlines exactly:
 *
 *     buildWorldSnapshot(ref) → reconcileStandalone(snapshot) → executeAction
 *
 * so reconcileOnce() below composes those same three calls.
 *
 * Precision note (discovered against the real DB): Postgres `timestamptz`
 * columns store microseconds while JS Dates carry milliseconds, so every CAS
 * guard in the executor — including applyStandaloneTransition's — compares
 * updated_at truncated to milliseconds (see updatedAtMatches). A plain eq()
 * would silently never match a row whose updated_at was last written by PG
 * `now()`/`defaultNow()`, leaving every standalone transition from it
 * permanently "stale". Dedicated tests at the bottom pin the µs-safe behavior
 * on both the transition and casUpdate paths.
 *
 * Covers:
 *  - QUEUED run → enqueueAgent → the BullMQ "workflow-runs" queue receives
 *    the process-workflow-run job (inspected via a Queue with the same name
 *    and connection options the executor uses).
 *  - FAILED run with retryCount < maxRetries → auto-retry back to QUEUED with
 *    retryCount+1 and a future reconcileBackoffUntil; the executor schedules
 *    a delayed "backoff_expired" reconcile; a pass during the backoff window
 *    is a pure noop.
 *  - CAS staleness: re-executing the same action from the pre-transition
 *    snapshot is rejected ("cas_failed_standalone_transition") instead of
 *    double-applying.
 *  - FAILED run with retries exhausted stays FAILED, with no write at all.
 *  - control_intent="cancel" on a QUEUED run → FAILED with the retry budget
 *    exhausted, intent cleared, no agent job enqueued — and the next pass
 *    leaves the cancelled run alone instead of auto-retrying it.
 *  - The µs/ms CAS seam: transitions and casUpdate both apply from
 *    µs-stamped rows (see precision note above).
 */
import { afterAll, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { reconcileStandalone, WorkflowRunState } from "@optio/shared";
import type { RunRef, StandaloneAction, WorldSnapshot } from "@optio/shared";
import { db } from "../db/client.js";
import { workflowRuns } from "../db/schema.js";
import { insertWorkflow, insertWorkflowRun } from "../test-utils/integration/fixtures.js";
import { buildWorldSnapshot } from "./reconcile-snapshot.js";
import { executeAction, type ExecuteOutcome } from "./reconcile-executor.js";
import { getBullMQConnectionOptions } from "./redis-config.js";

// Inspection handles into this file's private Redis — same queue names and
// connection options the executor's applicators use. No worker consumes
// either queue in this tier, so enqueued jobs stay in waiting/delayed.
const workflowRunsQueue = new Queue("workflow-runs", { connection: getBullMQConnectionOptions() });
const reconcileQueueInspect = new Queue("reconcile", { connection: getBullMQConnectionOptions() });

afterAll(async () => {
  await workflowRunsQueue.close();
  await reconcileQueueInspect.close();
  // Best-effort close of app-module singletons loaded during the tests so the
  // forked worker exits quickly instead of leaning on the teardown kill.
  const { reconcileQueue } = await import("./reconcile-queue.js");
  await reconcileQueue.close();
  const { prWatcherQueue } = await import("../workers/pr-watcher-worker.js");
  await prWatcherQueue.close();
  const { workflowRunQueue } = await import("../workers/workflow-worker.js");
  await workflowRunQueue.close();
  const { getRedisClient } = await import("./event-bus.js");
  await getRedisClient().quit();
});

interface Pass {
  snapshot: WorldSnapshot;
  action: StandaloneAction;
  outcome: ExecuteOutcome;
}

/** One synchronous reconcile pass, composed exactly as the worker does. */
async function reconcileOnce(runId: string): Promise<Pass> {
  const ref: RunRef = { kind: "standalone", id: runId };
  const snapshot = await buildWorldSnapshot(ref);
  if (!snapshot) throw new Error(`no snapshot for workflow run ${runId}`);
  const action = reconcileStandalone(snapshot);
  const outcome = await executeAction(action, snapshot);
  return { snapshot, action, outcome };
}

async function getRun(id: string) {
  const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
  return row;
}

async function agentJobsFor(runId: string) {
  const jobs = await workflowRunsQueue.getJobs(["waiting", "prioritized", "delayed"]);
  return jobs.filter((j) => (j.data as { workflowRunId?: string }).workflowRunId === runId);
}

describe("reconcile standalone: snapshot → decide → execute", () => {
  it("queued run: enqueueAgent lands a process-workflow-run job on the workflow-runs queue", async () => {
    const workflow = await insertWorkflow();
    const run = await insertWorkflowRun(workflow.id); // state defaults to "queued"

    const { snapshot, action, outcome } = await reconcileOnce(run.id);

    expect(snapshot.run.kind).toBe("standalone");
    expect(snapshot.run.status.state).toBe(WorkflowRunState.QUEUED);
    expect(action).toEqual({
      kind: "enqueueAgent",
      trigger: "reconcile_queued",
      reason: "queued_capacity_available",
    });
    expect(outcome).toEqual({ status: "applied", reason: "enqueued:reconcile_queued" });

    const jobs = await agentJobsFor(run.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("process-workflow-run");
    expect(jobs[0].data).toEqual({ workflowRunId: run.id });
    // Unique reconcile-suffixed jobId (a stable id would be no-op'd by BullMQ
    // once a prior job for this run completed).
    expect(String(jobs[0].id)).toMatch(new RegExp(`^${run.id}-reconcile-\\d+`));

    // enqueueAgent performs no DB write — the worker claims QUEUED→RUNNING.
    const row = await getRun(run.id);
    expect(row.state).toBe("queued");
    expect(row.updatedAt.getTime()).toBe(run.updatedAt.getTime());
  });

  it("failed run with retry budget: flips back to queued with retryCount+1 and a future backoff", async () => {
    const workflow = await insertWorkflow(); // maxRetries defaults to 1
    const run = await insertWorkflowRun(workflow.id, {
      state: "failed",
      retryCount: 0,
      errorMessage: "agent exploded",
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(),
      updatedAt: new Date(), // ms precision, as production writers stamp it
    });

    const { snapshot, action, outcome } = await reconcileOnce(run.id);

    expect(action.kind).toBe("transition");
    const transition = action as Extract<StandaloneAction, { kind: "transition" }>;
    expect(transition.to).toBe(WorkflowRunState.QUEUED);
    expect(transition.trigger).toBe("auto_retry");
    expect(transition.reason).toBe("auto_retry_1/1");
    expect(outcome).toEqual({ status: "applied", reason: "standalone_transition:queued" });

    const row = await getRun(run.id);
    expect(row.state).toBe("queued");
    expect(row.retryCount).toBe(1);
    expect(row.errorMessage).toBeNull();
    // decideFailed clears finishedAt so decideRunning won't short-circuit the
    // retry to COMPLETED once the worker advances it to RUNNING.
    expect(row.finishedAt).toBeNull();
    expect(row.reconcileAttempts).toBe(0);
    expect(row.controlIntent).toBeNull();

    // Backoff = 5s * 2^retryCount + jitter(0–3s), anchored to snapshot.now.
    expect(row.reconcileBackoffUntil).not.toBeNull();
    const untilMs = row.reconcileBackoffUntil!.getTime();
    expect(untilMs).toBeGreaterThanOrEqual(snapshot.now.getTime() + 5_000);
    expect(untilMs).toBeLessThanOrEqual(snapshot.now.getTime() + 8_000);

    // The executor scheduled a delayed reconcile to fire when the backoff
    // expires (scheduleBackoffReconcile) — not waiting for the resync sweep.
    const delayed = await reconcileQueueInspect.getJobs(["delayed"]);
    const wakes = delayed.filter((j) => {
      const data = j.data as { ref?: RunRef; reason?: string };
      return data.ref?.id === run.id && data.reason === "backoff_expired";
    });
    expect(wakes).toHaveLength(1);

    // A pass during the backoff window is a pure noop: no decision beyond
    // the guard, no write.
    const second = await reconcileOnce(run.id);
    expect(second.action).toEqual({ kind: "noop", reason: "reconcile_backoff_active" });
    expect(second.outcome).toEqual({ status: "skipped", reason: "reconcile_backoff_active" });
    const rowAfter = await getRun(run.id);
    expect(rowAfter.updatedAt.getTime()).toBe(row.updatedAt.getTime());
    expect(rowAfter.retryCount).toBe(1);
  });

  it("re-executing the same action from a pre-transition snapshot is rejected by CAS", async () => {
    const workflow = await insertWorkflow({ maxRetries: 3 });
    const run = await insertWorkflowRun(workflow.id, {
      state: "failed",
      retryCount: 0,
      errorMessage: "flaky",
      finishedAt: new Date(),
      updatedAt: new Date(),
    });

    const ref: RunRef = { kind: "standalone", id: run.id };
    const snapshot = (await buildWorldSnapshot(ref))!;
    const action = reconcileStandalone(snapshot);
    expect(action.kind).toBe("transition");

    const first = await executeAction(action, snapshot);
    expect(first).toEqual({ status: "applied", reason: "standalone_transition:queued" });

    // Same snapshot again: updated_at (and state) moved on, so the CAS guard
    // refuses the write instead of double-incrementing retryCount.
    const second = await executeAction(action, snapshot);
    expect(second).toEqual({ status: "stale", reason: "cas_failed_standalone_transition" });

    const row = await getRun(run.id);
    expect(row.state).toBe("queued");
    expect(row.retryCount).toBe(1);
  });

  it("failed run with retries exhausted stays failed, with no write", async () => {
    const workflow = await insertWorkflow(); // maxRetries defaults to 1
    const run = await insertWorkflowRun(workflow.id, {
      state: "failed",
      retryCount: 1,
      errorMessage: "still broken",
      finishedAt: new Date(),
      updatedAt: new Date(),
    });

    const { action, outcome } = await reconcileOnce(run.id);

    expect(action).toEqual({ kind: "noop", reason: "failed_no_retry_intent" });
    expect(outcome).toEqual({ status: "skipped", reason: "failed_no_retry_intent" });

    const row = await getRun(run.id);
    expect(row.state).toBe("failed");
    expect(row.retryCount).toBe(1);
    expect(row.errorMessage).toBe("still broken");
    expect(row.updatedAt.getTime()).toBe(run.updatedAt.getTime());
    expect(await agentJobsFor(run.id)).toHaveLength(0);
  });

  it("control_intent=cancel on a queued run cancels it and clears the intent", async () => {
    const workflow = await insertWorkflow();
    const run = await insertWorkflowRun(workflow.id, {
      controlIntent: "cancel",
      updatedAt: new Date(),
    });

    const { action, outcome } = await reconcileOnce(run.id);

    expect(action).toMatchObject({
      kind: "transition",
      to: WorkflowRunState.FAILED,
      clearControlIntent: true,
      trigger: "user_cancel",
      reason: "control_intent=cancel",
    });
    expect(outcome).toEqual({ status: "applied", reason: "standalone_transition:failed" });

    const row = await getRun(run.id);
    expect(row.state).toBe("failed");
    expect(row.controlIntent).toBeNull();
    expect(row.errorMessage).toBe("Cancelled by user");
    expect(row.finishedAt).not.toBeNull();
    // Cancellation exhausts the retry budget (insertWorkflow's maxRetries
    // defaults to 1) so decideFailed cannot auto-retry the cancelled run.
    expect(row.retryCount).toBe(1);

    // The intent short-circuits before decideQueued — no agent job enqueued.
    expect(await agentJobsFor(run.id)).toHaveLength(0);

    // Follow-up pass: decideFailed sees no retry budget left and leaves the
    // cancelled run alone. (Before the retry-budget stamp, it treated the
    // cancellation like any failure and flipped it back to QUEUED — a
    // user-cancelled run silently reran.)
    const followUp = await reconcileOnce(run.id);
    expect(followUp.action).toEqual({ kind: "noop", reason: "failed_no_retry_intent" });
    expect(followUp.outcome).toEqual({ status: "skipped", reason: "failed_no_retry_intent" });
    const rowAfter = await getRun(run.id);
    expect(rowAfter.state).toBe("failed");
    expect(rowAfter.errorMessage).toBe("Cancelled by user");
    expect(rowAfter.updatedAt.getTime()).toBe(row.updatedAt.getTime());
    expect(await agentJobsFor(run.id)).toHaveLength(0);
  });
});

describe("reconcile standalone: µs/ms updated_at precision seam", () => {
  it("standalone transition applies when updated_at carries microseconds", async () => {
    const workflow = await insertWorkflow();
    const run = await insertWorkflowRun(workflow.id, {
      state: "failed",
      retryCount: 0,
      errorMessage: "boom",
      finishedAt: new Date(),
    });
    // Force a non-zero sub-millisecond component (the schema's defaultNow()
    // usually has one too, but pin it so this can't flake 1-in-1000).
    await db.execute(sql`
      UPDATE workflow_runs
      SET updated_at = date_trunc('milliseconds', now()) + interval '456 microseconds'
      WHERE id = ${run.id}
    `);

    // The decision is a normal auto-retry transition...
    const { snapshot, action, outcome } = await reconcileOnce(run.id);
    expect(action).toMatchObject({ kind: "transition", to: WorkflowRunState.QUEUED });

    // ...and applyStandaloneTransition now guards with the same ms-truncating
    // updated_at comparison as casUpdate, so the ms-precision snapshot version
    // matches the µs-precision stored value and the write applies. (It used
    // to be a plain eq(updatedAt, version), which NEVER matched a µs-stamped
    // row — every transition from it was permanently stale.)
    expect(outcome).toEqual({ status: "applied", reason: "standalone_transition:queued" });

    const row = await getRun(run.id);
    expect(row.state).toBe("queued");
    expect(row.retryCount).toBe(1);
    expect(row.errorMessage).toBeNull();

    // CAS integrity is intact: replaying the same action from the now-stale
    // snapshot is still refused (updated_at and state have both moved on).
    const replay = await executeAction(action, snapshot);
    expect(replay).toEqual({ status: "stale", reason: "cas_failed_standalone_transition" });
    expect((await getRun(run.id)).retryCount).toBe(1);
  });

  it("clearControlIntent uses the date_trunc CAS and applies despite microsecond precision", async () => {
    const workflow = await insertWorkflow();
    const run = await insertWorkflowRun(workflow.id, {
      state: "completed",
      controlIntent: "cancel",
      finishedAt: new Date(),
    });
    await db.execute(sql`
      UPDATE workflow_runs
      SET updated_at = date_trunc('milliseconds', now()) + interval '456 microseconds'
      WHERE id = ${run.id}
    `);

    // Cancel on a terminal run resolves to clearControlIntent, which goes
    // through casUpdate() — the ms-truncating comparison — so the same
    // µs-precision updated_at that stales a transition applies fine here.
    const { action, outcome } = await reconcileOnce(run.id);
    expect(action).toEqual({ kind: "clearControlIntent", reason: "intent_cancel_on_terminal" });
    expect(outcome).toEqual({ status: "applied", reason: "cleared_control_intent" });

    const row = await getRun(run.id);
    expect(row.state).toBe("completed");
    expect(row.controlIntent).toBeNull();
  });
});
