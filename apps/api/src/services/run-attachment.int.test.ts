/**
 * Run attachment against a real Postgres (docs/plans/scale-out.md §2): two
 * API instances — two module graphs of run-attachment.ts, each with its own
 * INSTANCE_ID and connection pool — race for the same runs. Exactly one
 * claims an expired attachment, a live one is nobody else's (this
 * instance's own second job's neither), a finished run is never claimed, a
 * log batch from a hold that lost the run rolls back whole, a run's exit
 * and spend are recorded once, a requeue is told apart from a takeover, an
 * agent its job left behind is stopped, and a run queued again stops its
 * last attempt's agent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { TaskState, WorkflowRunState } from "@optio/shared";
import { db } from "../db/client.js";
import { taskLogs, type tasks, workRuns } from "../db/schema.js";
import {
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
} from "../test-utils/integration/fixtures.js";

// The pod side: every pod is there, and every kill is recorded.
const killRun = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./agent-pod-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-pod-pool.js")>();
  return {
    ...actual,
    getPod: async (id: string) => ({
      id,
      podId: `k8s-${id}`,
      podName: `pod-${id}`,
      state: "ready",
    }),
  };
});
vi.mock("./container-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./container-service.js")>();
  return { ...actual, getRuntime: () => ({ killRun }) };
});

type AttachmentModule = typeof import("./run-attachment.js");
type LogModule = typeof import("./run-log-service.js");

interface Instance {
  id: string;
  att: AttachmentModule;
  logs: LogModule;
}

/** A fresh module graph: what a second API process would be. */
async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const { INSTANCE_ID } = await import("./instance.js");
  return {
    id: INSTANCE_ID,
    att: await import("./run-attachment.js"),
    logs: await import("./run-log-service.js"),
  };
}

const ref = (id: string) => ({ kind: "work-run" as const, id });
const expired = () => new Date(Date.now() - 5_000);
const POD = "00000000-0000-4000-8000-000000000001";

async function startedRun(overrides: Partial<typeof tasks.$inferInsert> = {}) {
  return insertTask({
    state: TaskState.RUNNING,
    execState: "started",
    execPid: 4242,
    lastPodId: POD,
    attachedBy: "gone-instance:000000/0000",
    attachLeaseUntil: expired(),
    ...overrides,
  });
}

async function row(id: string) {
  const [r] = await db.select().from(workRuns).where(eq(workRuns.id, id));
  return r;
}

async function expectReleased(id: string) {
  const [lease] = await db
    .select({ expired: sql<boolean>`${workRuns.attachLeaseUntil} <= now()` })
    .from(workRuns)
    .where(eq(workRuns.id, id));
  expect(lease.expired).toBe(true);
}

/** Claims the run for `inst` and holds it, as an attach job does. */
async function claimAndHold(inst: Instance, id: string) {
  const claim = await inst.att.claimAttachment(ref(id));
  if (!claim) throw new Error("claim lost");
  return inst.att.startHold(ref(id), claim.token, {
    phase: "streaming",
    agent: claim.pid ? { podId: POD, pid: claim.pid } : null,
  });
}

beforeEach(() => {
  killRun.mockClear();
});

describe("run attachment, two instances on one database", () => {
  it("racing the claim on an expired attachment, exactly one instance wins — every time", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    expect(a.id).not.toBe(b.id);

    for (let i = 0; i < 25; i++) {
      const run = await startedRun({ consumedBytes: 123 });
      const [ca, cb] = await Promise.all([
        a.att.claimAttachment(ref(run.id)),
        b.att.claimAttachment(ref(run.id)),
      ]);
      const winners = [ca, cb].filter(Boolean);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toMatchObject({ consumedBytes: 123, execState: "started", pid: 4242 });
      const after = await row(run.id);
      // The hold's own mark: the winning instance, and the hold's nonce.
      expect(after.attachedBy).toBe(winners[0]!.token);
      expect(after.attachedBy!.startsWith(`${ca ? a.id : b.id}/`)).toBe(true);
      expect(after.attachLeaseUntil!.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("a live attachment is nobody else's: the other's claim and renew fail, the holder's renew holds", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const run = await startedRun();

    const claim = await a.att.claimAttachment(ref(run.id));
    expect(claim).not.toBeNull();
    const held = { ref: ref(run.id), token: claim!.token };
    expect(await b.att.claimAttachment(ref(run.id))).toBeNull();
    expect(await b.att.renewAttachment({ ref: ref(run.id), token: `${b.id}/beef` })).toBe(false);
    expect(await a.att.renewAttachment(held)).toBe(true);
    expect((await row(run.id)).attachedBy).toBe(claim!.token);

    // Given up at shutdown, it is claimable at once.
    await a.att.releaseAttachment(held);
    expect(await b.att.claimAttachment(ref(run.id))).not.toBeNull();
    expect(await a.att.renewAttachment(held)).toBe(false);
  });

  it("a released attachment is immediately claimable even when the releasing API clock is ahead", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const run = await startedRun();
    const claim = await a.att.claimAttachment(ref(run.id));
    expect(claim).not.toBeNull();
    const held = { ref: ref(run.id), token: claim!.token };

    // Only Date is replaced: database I/O and timers remain real. A handoff
    // must not wait for Postgres to catch up with the releasing host's clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    try {
      await a.att.releaseAttachment(held);
    } finally {
      vi.useRealTimers();
    }
    await expectReleased(run.id);
    const taken = await b.att.claimAttachment(ref(run.id));
    expect(taken).not.toBeNull();
    expect((await row(run.id)).attachedBy).toBe(taken!.token);

    // A late release from the old holder must still respect the token CAS.
    await a.att.releaseAttachment(held);
    expect(await a.att.claimAttachment(ref(run.id))).toBeNull();
    expect((await row(run.id)).attachedBy).toBe(taken!.token);
  });

  it("(4) one instance never claims a run it holds live: a second job of it loses the claim", async () => {
    const a = await bootInstance();
    const run = await startedRun();
    const first = await a.att.claimAttachment(ref(run.id));
    expect(first).not.toBeNull();
    // The old CAS let `attached_by = me` through whatever the lease said.
    expect(await a.att.claimAttachment(ref(run.id))).toBeNull();
    expect((await row(run.id)).attachedBy).toBe(first!.token);
  });

  it("a run never started is not claimable; one with its exit recorded is (to finish settling)", async () => {
    const a = await bootInstance();
    const never = await startedRun({ execState: null });
    expect(await a.att.claimAttachment(ref(never.id))).toBeNull();

    const settling = await startedRun({ execState: "exited", consumedBytes: 77 });
    expect(await a.att.claimAttachment(ref(settling.id))).toMatchObject({
      consumedBytes: 77,
      execState: "exited",
    });
  });

  it("(5) a finished run is never claimed — even one that finished between a handler's read and its claim", async () => {
    const a = await bootInstance();
    for (const state of [
      TaskState.COMPLETED,
      TaskState.FAILED,
      TaskState.CANCELLED,
      TaskState.PR_OPENED,
      TaskState.NEEDS_ATTENTION,
    ]) {
      // The attach handler read `running`; the run finished before its claim.
      const run = await startedRun();
      await db
        .update(workRuns)
        .set({ state, execState: "exited", attachedBy: null, attachLeaseUntil: null })
        .where(eq(workRuns.id, run.id));
      const before = await row(run.id);
      expect(await a.att.claimAttachment(ref(run.id)), state).toBeNull();
      expect(await row(run.id)).toEqual(before);
    }
    // A run whose exit is recorded but whose state is still active is
    // finished by its claimer, its spend never added again.
    const half = await startedRun({ execState: "exited", costUsd: "0.5" });
    const claim = await a.att.claimAttachment(ref(half.id));
    expect(claim).toMatchObject({ execState: "exited" });
    const { addUsage } = await import("./run-usage.js");
    expect(
      await a.att.settleRun(
        { ref: ref(half.id), token: claim!.token },
        addUsage(workRuns, { costUsd: 0.5 }),
      ),
    ).toBe("already");
    expect((await row(half.id)).costUsd).toBe("0.5");
  });

  it("a Job run that is no longer running is not claimed either", async () => {
    const a = await bootInstance();
    const job = await insertWorkflow();
    const run = await insertWorkflowRun(job.id, {
      state: WorkflowRunState.FAILED,
      execState: "started",
      execPid: 7,
      attachedBy: null,
      attachLeaseUntil: null,
    });
    expect(await a.att.claimAttachment(ref(run.id))).toBeNull();
  });

  it("log rows and the offset commit together: the loser's batch rolls back whole", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const run = await startedRun();
    const claim = await a.att.claimAttachment(ref(run.id));

    const line = { content: "hello", logType: "text" };
    await expect(
      b.logs.appendRunLogsBatch(ref(run.id), [line, line], { from: 0, to: 12 }, `${b.id}/beef`),
    ).rejects.toBeInstanceOf(b.logs.AttachmentLostError);
    const count = async () =>
      (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(taskLogs)
          .where(eq(taskLogs.taskId, run.id))
      )[0].n;
    expect(await count()).toBe(0);
    expect((await row(run.id)).consumedBytes).toBe(0);

    const stored = await a.logs.appendRunLogsBatch(
      ref(run.id),
      [line, line],
      { from: 0, to: 12 },
      claim!.token,
    );
    expect(stored).toHaveLength(2);
    expect(await count()).toBe(2);
    expect((await row(run.id)).consumedBytes).toBe(12);

    // A batch from a stale offset (a duplicate) is refused the same way.
    await expect(
      a.logs.appendRunLogsBatch(ref(run.id), [line], { from: 0, to: 6 }, claim!.token),
    ).rejects.toBeInstanceOf(a.logs.AttachmentLostError);
    // So is one from another hold of the same instance (an old attempt's job).
    await expect(
      a.logs.appendRunLogsBatch(ref(run.id), [line], { from: 12, to: 18 }, `${a.id}/0001`),
    ).rejects.toBeInstanceOf(a.logs.AttachmentLostError);
    expect(await count()).toBe(2);
  });

  it("a run's exit and its spend are recorded once, whichever instance finishes it", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const { addUsage } = await import("./run-usage.js");
    const run = await startedRun({ costUsd: "0.25" });
    const claim = await a.att.claimAttachment(ref(run.id));
    const aHold = { ref: ref(run.id), token: claim!.token, agent: { podId: POD, pid: 4242 } };
    const bHold = { ref: ref(run.id), token: `${b.id}/beef`, agent: { podId: POD, pid: 4242 } };

    const spend = () => addUsage(workRuns, { costUsd: 0.5, inputTokens: 10 });
    expect(await b.att.settleRun(bHold, spend())).toBe("taken");
    expect(await a.att.settleRun(aHold, spend())).toBe("settled");
    expect(await a.att.settleRun(aHold, spend())).toBe("already");
    const after = await row(run.id);
    expect(after.execState).toBe("exited");
    expect(after.costUsd).toBe("0.75");
    expect(after.inputTokens).toBe(10);

    // Its holder went away before settling the rest: the next one finishes
    // the run without adding the spend again.
    await db.update(workRuns).set({ attachLeaseUntil: expired() }).where(eq(workRuns.id, run.id));
    const again = await b.att.claimAttachment(ref(run.id));
    expect(again).toMatchObject({ execState: "exited" });
    const bClaimed = { ref: ref(run.id), token: again!.token };
    expect(await b.att.settleRun(bClaimed, spend())).toBe("already");
    expect((await row(run.id)).costUsd).toBe("0.75");

    await b.att.closeAttachment(bClaimed);
    const closed = await row(run.id);
    expect(closed.attachedBy).toBeNull();
    expect(closed.attachLeaseUntil).toBeNull();
  });

  it("(12) a settle that finds its attempt queued again says reset, not taken", async () => {
    const a = await bootInstance();
    const { transitionTask } = await import("./task-service.js");
    const run = await startedRun();
    const claim = await a.att.claimAttachment(ref(run.id));
    const hold = { ref: ref(run.id), token: claim!.token, agent: { podId: POD, pid: 4242 } };

    await db.update(workRuns).set({ state: TaskState.FAILED }).where(eq(workRuns.id, run.id));
    await transitionTask(run.id, TaskState.QUEUED, "user_retry");
    expect(await a.att.settleRun(hold, {})).toBe("reset");
    expect(await a.att.classifyLoss(hold)).toBe("reset");

    // A new attempt started meanwhile (another supervisor): reset too, and
    // the old hold's settle never touches the new attempt.
    await db
      .update(workRuns)
      .set({ state: TaskState.RUNNING, execState: "started", execPid: 5151, attachedBy: "x/1" })
      .where(eq(workRuns.id, run.id));
    expect(await a.att.settleRun(hold, {})).toBe("reset");
    expect((await row(run.id)).execState).toBe("started");
  });

  it("(2) a job that ends without settling stops the agent it left behind — not one another hold streams", async () => {
    const a = await bootInstance();
    const b = await bootInstance();

    // The job errored while still setting the run up, its agent started:
    // the agent is stopped.
    const run = await startedRun();
    const claim = await a.att.claimAttachment(ref(run.id));
    const setup = a.att.startHold(ref(run.id), claim!.token, {
      origin: "start",
      agent: { podId: POD, pid: 4242 },
    });
    await a.att.endRunJob(setup, null);
    expect(killRun).toHaveBeenCalledWith(
      { id: `k8s-${POD}`, name: `pod-${POD}` },
      expect.objectContaining({ runId: run.id, signal: "TERM", pid: 4242 }),
    );
    // Its lease was given up.
    await expectReleased(run.id);

    // The job errored while streaming: the agent is left running for the
    // next attach, the lease given up so it comes at once.
    killRun.mockClear();
    const streaming = await startedRun();
    const held = await claimAndHold(a, streaming.id);
    expect(await a.att.onStreamError(held)).toBe("detached");
    await a.att.endRunJob(held, "detached");
    expect(killRun).not.toHaveBeenCalled();
    await expectReleased(streaming.id);
    expect((await row(streaming.id)).metadata).toMatchObject({ attachFailures: 1 });

    // …until it is the attempt's third failed attach in a row: failed, stopped.
    for (const expected of ["detached", "failed"] as const) {
      const next = await claimAndHold(a, streaming.id);
      const end = await a.att.onStreamError(next);
      expect(end).toBe(expected);
      await a.att.endRunJob(next, end);
    }
    expect(killRun).toHaveBeenCalledTimes(1);
    expect(killRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: streaming.id, pid: 4242 }),
    );

    // Another instance took the run over (a live lease on the same agent):
    // the old job leaves it alone.
    killRun.mockClear();
    const run2 = await startedRun();
    const old = await claimAndHold(a, run2.id);
    await db.update(workRuns).set({ attachLeaseUntil: expired() }).where(eq(workRuns.id, run2.id));
    const taker = await claimAndHold(b, run2.id);
    await a.att.endRunJob(old, null);
    expect(killRun).not.toHaveBeenCalled();
    await taker.end();

    // The job finished the run: nothing to stop.
    const run3 = await startedRun();
    const done = await claimAndHold(a, run3.id);
    await a.att.endRunJob(done, "finished");
    expect(killRun).not.toHaveBeenCalled();
  });

  it("(1) queuing a task again resets its execution and stops the last attempt's agent, scoped to its pid", async () => {
    const { transitionTask } = await import("./task-service.js");
    const run = await startedRun({
      state: TaskState.FAILED,
      consumedBytes: 900,
      attachLeaseUntil: new Date(Date.now() + 30_000),
    });
    await transitionTask(run.id, TaskState.QUEUED, "user_retry");
    const [after] = await db
      .select()
      .from(workRuns)
      .where(and(eq(workRuns.id, run.id), eq(workRuns.state, TaskState.QUEUED)));
    expect(after).toMatchObject({
      execState: null,
      execPid: null,
      consumedBytes: 0,
      attachedBy: null,
      attachLeaseUntil: null,
    });
    await vi.waitFor(() =>
      expect(killRun).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ runId: run.id, signal: "TERM", pid: 4242 }),
      ),
    );

    // A run whose agent already exited: nothing to stop.
    killRun.mockClear();
    const exited = await startedRun({ state: TaskState.FAILED, execState: "exited" });
    await transitionTask(exited.id, TaskState.QUEUED, "user_retry");
    await new Promise((r) => setTimeout(r, 100));
    expect(killRun).not.toHaveBeenCalled();
  });

  it("(1) a force-redo of a running task resets it in one go, its logs gone, its agent stopped", async () => {
    const { forceRedoTask } = await import("./task-service.js");
    const run = await startedRun({ consumedBytes: 64, attachedBy: "live/1" });
    await db.insert(taskLogs).values({ taskId: run.id, content: "old attempt" });
    await forceRedoTask(run.id);
    expect(await row(run.id)).toMatchObject({
      state: TaskState.QUEUED,
      execState: null,
      execPid: null,
      consumedBytes: 0,
      attachedBy: null,
      attachLeaseUntil: null,
    });
    expect(await db.select().from(taskLogs).where(eq(taskLogs.taskId, run.id))).toEqual([]);
    await vi.waitFor(() =>
      expect(killRun).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ runId: run.id, signal: "TERM", pid: 4242 }),
      ),
    );
  });

  it("(1) a Job run sent back to queued stops its last attempt's agent the same way", async () => {
    const { transitionWorkflowRunCas } = await import("./workflow-service.js");
    const job = await insertWorkflow();
    const run = await insertWorkflowRun(job.id, {
      state: WorkflowRunState.FAILED,
      execState: "started",
      execPid: 6262,
      lastPodId: POD,
      attachedBy: "gone/1",
    });
    const queued = await transitionWorkflowRunCas(
      run.id,
      WorkflowRunState.FAILED,
      WorkflowRunState.QUEUED,
    );
    expect(queued).toMatchObject({ execState: null, attachedBy: null, consumedBytes: 0 });
    await vi.waitFor(() =>
      expect(killRun).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ runId: run.id, pid: 6262 }),
      ),
    );
  });

  it("counts the attach jobs that failed an attempt in its own jsonb, per hold, cleared by progress and a new start", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const run = await startedRun({ metadata: { run: { isReviewTask: false }, keep: 1 } });
    const claim = await a.att.claimAttachment(ref(run.id));
    const hold = { ref: ref(run.id), token: claim!.token };

    expect(await a.att.countAttachFailure(hold)).toBe(1);
    expect(await a.att.countAttachFailure(hold)).toBe(2);
    // Another hold's count is no count: it does not have the run.
    expect(await b.att.countAttachFailure({ ref: ref(run.id), token: `${b.id}/beef` })).toBeNull();
    // The run's own bookkeeping in the column is untouched.
    expect((await row(run.id)).metadata).toEqual({
      run: { isReviewTask: false },
      keep: 1,
      attachFailures: 2,
    });

    // An attach job that made progress: the failures were not in a row.
    await a.att.clearAttachFailures(hold);
    expect((await row(run.id)).metadata).toEqual({ run: { isReviewTask: false }, keep: 1 });
    expect(await a.att.countAttachFailure(hold)).toBe(1);

    // A new attempt starts with none.
    const fresh = a.att.startHold(ref(run.id), claim!.token);
    expect(await a.att.recordRunStarted(fresh, { podId: POD, pid: 5151 })).toBe(true);
    expect((await row(run.id)).metadata).toEqual({ run: { isReviewTask: false }, keep: 1 });
    await fresh.end();
  });
});
