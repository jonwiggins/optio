/**
 * Integration tests for the task state machine (task-service) against this
 * file's private Postgres database and leased Redis logical DB.
 *
 * Covers:
 *  - transitionTask through the legal chain pending → queued → provisioning
 *    → running → completed: row state, updatedAt/startedAt/completedAt
 *    stamping, and the task_events audit trail (trigger/message/userId).
 *  - Illegal transitions throw InvalidTransitionError and leave the row and
 *    event log untouched (including terminal `completed`).
 *  - tryTransitionTask CAS: concurrent queued → provisioning claims for the
 *    same task produce exactly one winner (the worker claim race guard).
 *  - The Redis side effect: transitionTask publishes task:state_changed on
 *    the task's pub/sub channel of the isolated Redis.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { TaskState, InvalidTransitionError } from "@optio/shared";
import { db } from "../db/client.js";
import { taskEvents, users } from "../db/schema.js";
import { insertTask } from "../test-utils/integration/fixtures.js";
import {
  getTask,
  getTaskEvents,
  transitionTask,
  tryTransitionTask,
  updateTaskResult,
} from "./task-service.js";
import { getRedisClient } from "./event-bus.js";

const uniq = () => randomBytes(4).toString("hex");

async function insertUser() {
  const suffix = uniq();
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-user-${suffix}`,
      email: `it-user-${suffix}@example.com`,
      displayName: `IT User ${suffix}`,
    })
    .returning();
  return row;
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!cond()) throw new Error("Timed out waiting for condition");
}

afterAll(async () => {
  // Close the event-bus publisher so the fork doesn't wait on it at teardown.
  await getRedisClient().quit();
});

describe("transitionTask legal chain", () => {
  it("walks pending → queued → provisioning → running → completed with stamps and events", async () => {
    const user = await insertUser();
    const task = await insertTask();
    expect(task.state).toBe("pending");
    expect(task.startedAt).toBeNull();
    expect(task.completedAt).toBeNull();

    const queued = await transitionTask(task.id, TaskState.QUEUED, "user_enqueue");
    expect(queued.state).toBe("queued");
    expect(queued.startedAt).toBeNull();
    expect(queued.completedAt).toBeNull();

    const provisioning = await transitionTask(task.id, TaskState.PROVISIONING, "worker_claim");
    expect(provisioning.state).toBe("provisioning");
    expect(provisioning.startedAt).toBeNull();

    const running = await transitionTask(task.id, TaskState.RUNNING, "agent_started");
    expect(running.state).toBe("running");
    expect(running.startedAt).not.toBeNull();
    expect(running.completedAt).toBeNull();
    // Stall-detection bookkeeping stamped on entering running
    expect(running.lastActivityAt).not.toBeNull();
    expect(running.activitySubstate).toBe("active");

    // Pre-set result fields so we can observe COMPLETED clearing them
    // (transitionTask nulls errorMessage/resultSummary on successful completion).
    await updateTaskResult(task.id, "partial summary", "transient error");

    const completed = await transitionTask(
      task.id,
      TaskState.COMPLETED,
      "agent_success",
      "all done",
      user.id,
    );
    expect(completed.state).toBe("completed");
    expect(completed.completedAt).not.toBeNull();
    expect(completed.errorMessage).toBeNull();
    expect(completed.resultSummary).toBeNull();
    // startedAt is preserved through completion
    expect(completed.startedAt!.getTime()).toBe(running.startedAt!.getTime());

    // updatedAt is re-stamped on every transition (monotonic across our
    // calls — all stamped from this process's clock)
    expect(provisioning.updatedAt.getTime()).toBeGreaterThanOrEqual(queued.updatedAt.getTime());
    expect(running.updatedAt.getTime()).toBeGreaterThanOrEqual(provisioning.updatedAt.getTime());
    expect(completed.updatedAt.getTime()).toBeGreaterThanOrEqual(running.updatedAt.getTime());

    // The row in the database matches the returned snapshot
    const row = await getTask(task.id);
    expect(row!.state).toBe("completed");
    expect(row!.completedAt!.getTime()).toBe(completed.completedAt!.getTime());

    // Audit trail: one task_events row per transition, in order, with
    // trigger metadata; the last carries message + userId and joins the user.
    const events = await getTaskEvents(task.id);
    expect(events.map((e) => [e.fromState, e.toState, e.trigger])).toEqual([
      ["pending", "queued", "user_enqueue"],
      ["queued", "provisioning", "worker_claim"],
      ["provisioning", "running", "agent_started"],
      ["running", "completed", "agent_success"],
    ]);
    expect(events[0].message).toBeNull();
    expect(events[0].userId).toBeNull();
    expect(events[0].user).toBeUndefined();
    const last = events[3];
    expect(last.message).toBe("all done");
    expect(last.userId).toBe(user.id);
    expect(last.user).toEqual({ id: user.id, displayName: user.displayName, avatarUrl: null });
  });

  it("stores the attention reason and preserves startedAt when re-entering running", async () => {
    const task = await insertTask({ state: "queued" });
    await transitionTask(task.id, TaskState.PROVISIONING, "worker_claim");
    const firstRun = await transitionTask(task.id, TaskState.RUNNING, "agent_started");
    const originalStartedAt = firstRun.startedAt!;

    const attention = await transitionTask(
      task.id,
      TaskState.NEEDS_ATTENTION,
      "agent_error",
      "agent asked a question",
    );
    expect(attention.state).toBe("needs_attention");
    expect(attention.errorMessage).toBe("agent asked a question");
    expect(attention.completedAt).toBeNull();

    const resumed = await transitionTask(task.id, TaskState.RUNNING, "user_resume");
    expect(resumed.state).toBe("running");
    // startedAt is only stamped when not already set
    expect(resumed.startedAt!.getTime()).toBe(originalStartedAt.getTime());
    expect(resumed.activitySubstate).toBe("active");

    // Without a message the trigger itself becomes the attention reason
    const stalled = await transitionTask(task.id, TaskState.NEEDS_ATTENTION, "stall_detected");
    expect(stalled.errorMessage).toBe("stall_detected");
  });

  it("re-queuing after failure resets execution fields", async () => {
    const task = await insertTask({
      state: "running",
      containerId: "pod-abc",
      startedAt: new Date(),
      resultSummary: "half-finished",
    });

    const failed = await transitionTask(task.id, TaskState.FAILED, "agent_failed", "boom");
    expect(failed.state).toBe("failed");
    expect(failed.completedAt).not.toBeNull();

    const requeued = await transitionTask(task.id, TaskState.QUEUED, "retry");
    expect(requeued.state).toBe("queued");
    expect(requeued.errorMessage).toBeNull();
    expect(requeued.resultSummary).toBeNull();
    expect(requeued.completedAt).toBeNull();
    expect(requeued.startedAt).toBeNull();
    expect(requeued.containerId).toBeNull();
  });
});

describe("illegal transitions", () => {
  it("throws InvalidTransitionError and leaves the row and event log untouched", async () => {
    const task = await insertTask(); // pending
    const before = await getTask(task.id);

    await expect(transitionTask(task.id, TaskState.RUNNING, "bad_jump")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );

    const after = await getTask(task.id);
    expect(after).toEqual(before); // byte-for-byte unchanged, updatedAt included

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(events).toHaveLength(0);
  });

  it("completed is terminal: every outbound transition is rejected", async () => {
    const task = await insertTask({ state: "completed" });
    for (const to of [TaskState.QUEUED, TaskState.RUNNING, TaskState.CANCELLED]) {
      await expect(transitionTask(task.id, to, "escape_attempt")).rejects.toBeInstanceOf(
        InvalidTransitionError,
      );
    }
    const row = await getTask(task.id);
    expect(row!.state).toBe("completed");
  });

  it("throws for an unknown task id", async () => {
    await expect(transitionTask(randomUUID(), TaskState.QUEUED, "test")).rejects.toThrow(
      /Task not found/,
    );
  });
});

describe("tryTransitionTask CAS claim race", () => {
  it("exactly one of several concurrent queued → provisioning claims wins", async () => {
    // Repeat the race a few times — a single pass can degenerate into
    // sequential execution and miss the contention we're guarding against.
    for (let round = 0; round < 3; round++) {
      const task = await insertTask({ state: "queued" });

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          tryTransitionTask(task.id, TaskState.PROVISIONING, `worker_claim_${i}`),
        ),
      );

      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.state).toBe("provisioning");

      const row = await getTask(task.id);
      expect(row!.state).toBe("provisioning");

      // Only the winner recorded an event — losers exited before the insert
      const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
      expect(events).toHaveLength(1);
      expect(events[0].fromState).toBe("queued");
      expect(events[0].toState).toBe("provisioning");
    }
  });
});

describe("Redis event publication", () => {
  it("publishes task:state_changed on the task's channel of the isolated Redis", async () => {
    const task = await insertTask({ state: "queued" });
    const sub = new Redis(process.env.REDIS_URL!);
    try {
      const messages: Array<Record<string, unknown>> = [];
      sub.on("message", (_channel, raw) => messages.push(JSON.parse(raw)));
      await sub.subscribe(`optio:task:${task.id}`);

      await transitionTask(task.id, TaskState.PROVISIONING, "worker_claim");

      await waitFor(() => messages.some((m) => m.type === "task:state_changed"));
      const evt = messages.find((m) => m.type === "task:state_changed");
      expect(evt).toMatchObject({
        taskId: task.id,
        fromState: "queued",
        toState: "provisioning",
      });
    } finally {
      await sub.quit();
    }
  });
});
