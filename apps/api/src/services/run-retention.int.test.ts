/**
 * Run retention against a real Postgres (services/run-retention.ts): the
 * logs, transcripts and prompts of work that finished before the cutoff go;
 * recent work, running work and active sessions keep everything; with
 * retention off nothing is touched; a large backlog drains in batches.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  interactiveSessions,
  localHosts,
  localTerminals,
  localTerminalSnapshots,
  localTerminalTranscripts,
  persistentAgentMessages,
  persistentAgents,
  persistentAgentTurns,
  prReviewChatMessages,
  prReviewRuns,
  prReviews,
  sessionChatEvents,
  sessionChatTurns,
  taskEvents,
  taskLogs,
  taskMessages,
  workRuns,
} from "../db/schema.js";
import {
  insertSessionWithChatEvents,
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
} from "../test-utils/integration/fixtures.js";
import {
  RETENTION_BATCH,
  isPromptPruned,
  pruneRunData,
  resetRetentionRest,
} from "./run-retention.js";

const DAY = 86_400_000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const RETAIN = 30;

beforeEach(async () => {
  resetRetentionRest();
  // Each test sees only its own rows.
  await db.execute(sql`DO $$ BEGIN
    SET LOCAL client_min_messages = warning;
    TRUNCATE tasks, pr_reviews, persistent_agents, interactive_sessions, local_hosts,
      work_definitions CASCADE;
  END $$`);
});

async function logsOf(taskId: string) {
  return db.select().from(taskLogs).where(eq(taskLogs.taskId, taskId));
}
async function run(id: string) {
  const [row] = await db.select().from(workRuns).where(eq(workRuns.id, id));
  return row;
}
async function addLogs(owner: Partial<typeof taskLogs.$inferInsert>, n = 2) {
  await db
    .insert(taskLogs)
    .values(Array.from({ length: n }, (_, i) => ({ ...owner, content: `line ${i}` })));
}

/** A finished repo task with logs, a message, a state event and a result. */
async function finishedTask(
  endedDaysAgo: number,
  state: "completed" | "failed" | "cancelled" = "completed",
) {
  const task = await insertTask({
    state,
    prompt: "the secret plan",
    resultSummary: "did the thing",
    errorMessage: state === "completed" ? null : "it broke",
    completedAt: ago(endedDaysAgo),
    costUsd: "1.25",
    inputTokens: 100,
  });
  await addLogs({ taskId: task.id });
  await db.insert(taskMessages).values({ taskId: task.id, content: "please also fix y" });
  await db
    .insert(taskEvents)
    .values({ taskId: task.id, toState: state, trigger: "test", message: "ended" });
  return task;
}

async function reviewRun(endedDaysAgo: number, state: "completed" | "running") {
  const [review] = await db
    .insert(prReviews)
    .values({
      prUrl: `https://github.com/o/r/pull/${Math.floor(Math.random() * 1e6)}`,
      prNumber: 1,
      repoOwner: "o",
      repoName: "r",
      repoUrl: "https://github.com/o/r",
      headSha: "abc",
      state: state === "running" ? "reviewing" : "submitted",
      updatedAt: ago(endedDaysAgo),
    })
    .returning();
  const [r] = await db
    .insert(prReviewRuns)
    .values({
      prReviewId: review.id,
      state,
      prompt: "review this",
      resultSummary: "looks fine",
      completedAt: state === "completed" ? ago(endedDaysAgo) : null,
      updatedAt: ago(endedDaysAgo),
    })
    .returning();
  await addLogs({ prReviewRunId: r.id });
  await db
    .insert(prReviewChatMessages)
    .values({ prReviewId: review.id, runId: r.id, role: "user", content: "why?" });
  return { review, run: r };
}

async function agentTurn(finishedDaysAgo: number | null) {
  const [agent] = await db
    .insert(persistentAgents)
    .values({
      slug: `a-${Math.random().toString(36).slice(2, 8)}`,
      name: "it",
      initialPrompt: "x",
    })
    .returning();
  const [turn] = await db
    .insert(persistentAgentTurns)
    .values({
      agentId: agent.id,
      turnNumber: 1,
      wakeSource: "user",
      wakePayload: { messages: ["hi"] },
      promptUsed: "turn prompt",
      summary: "turn summary",
      finishedAt: finishedDaysAgo === null ? null : ago(finishedDaysAgo),
      execState: finishedDaysAgo === null ? "started" : "exited",
    })
    .returning();
  await addLogs({ persistentAgentTurnId: turn.id });
  await db.insert(persistentAgentMessages).values({
    agentId: agent.id,
    senderType: "user",
    body: "hello agent",
    processedAt: ago(finishedDaysAgo ?? 40),
    turnId: turn.id,
  });
  return turn;
}

async function session(endedDaysAgo: number | null) {
  const s = await insertSessionWithChatEvents(3, {
    state: endedDaysAgo === null ? "active" : "ended",
    endedAt: endedDaysAgo === null ? null : ago(endedDaysAgo),
    initialPrompt: "session prompt",
  });
  await db.insert(sessionChatTurns).values({
    sessionId: s.id,
    requestId: crypto.randomUUID(),
    promptHash: "h",
    prompt: "turn text",
    state: endedDaysAgo === null ? "running" : "completed",
  });
  return s;
}

async function terminal(endedDaysAgo: number | null) {
  const [host] = await db
    .insert(localHosts)
    .values({ name: "h", hostname: "h", platform: "linux" })
    .returning();
  const [t] = await db
    .insert(localTerminals)
    .values({
      hostId: host.id,
      title: "t",
      dir: "/w",
      spec: {},
      state: endedDaysAgo === null ? "running" : "exited",
      endedAt: endedDaysAgo === null ? null : ago(endedDaysAgo),
      preview: "screen text",
    })
    .returning();
  await db.insert(localTerminalTranscripts).values({
    terminalId: t.id,
    seq: 1,
    role: "user",
    kind: "text",
    text: "hi",
  });
  await db
    .insert(localTerminalSnapshots)
    .values({ terminalId: t.id, data: Buffer.from("x"), cols: 80, rows: 24 });
  return t;
}

describe("run retention", () => {
  it("removes old finished work's logs, transcripts and prompts, and keeps the run row", async () => {
    const old = await finishedTask(45);
    const oldFailed = await finishedTask(45, "failed");
    const job = await insertWorkflow();
    const oldJobRun = await insertWorkflowRun(job.id, {
      state: "completed",
      prompt: "job prompt",
      output: { answer: 42 },
      finishedAt: ago(45),
    });
    await addLogs({ taskId: oldJobRun.id });
    const oldReview = await reviewRun(45, "completed");
    const oldTurn = await agentTurn(45);
    const oldSession = await session(45);
    const oldTerminal = await terminal(45);

    expect(await pruneRunData(NOW, RETAIN)).toBeGreaterThan(0);

    for (const t of [old, oldFailed]) {
      expect(await logsOf(t.id)).toHaveLength(0);
      expect(await db.select().from(taskMessages).where(eq(taskMessages.taskId, t.id))).toEqual([]);
      const r = await run(t.id);
      expect(r).toMatchObject({
        prompt: "",
        resultSummary: null,
        errorMessage: null,
        title: "it task",
        state: t.state,
        costUsd: "1.25",
        inputTokens: 100,
      });
      expect(isPromptPruned(r)).toBe(true);
      // The state history stays.
      expect(await db.select().from(taskEvents).where(eq(taskEvents.taskId, t.id))).toHaveLength(1);
    }
    expect(await logsOf(oldJobRun.id)).toHaveLength(0);
    expect(await run(oldJobRun.id)).toMatchObject({ prompt: null, output: null });

    expect(
      await db.select().from(taskLogs).where(eq(taskLogs.prReviewRunId, oldReview.run.id)),
    ).toEqual([]);
    const [rr] = await db.select().from(prReviewRuns).where(eq(prReviewRuns.id, oldReview.run.id));
    expect(rr).toMatchObject({ prompt: null, resultSummary: null, state: "completed" });
    expect(
      await db
        .select()
        .from(prReviewChatMessages)
        .where(eq(prReviewChatMessages.prReviewId, oldReview.review.id)),
    ).toEqual([]);

    expect(
      await db.select().from(taskLogs).where(eq(taskLogs.persistentAgentTurnId, oldTurn.id)),
    ).toEqual([]);
    const [tr] = await db
      .select()
      .from(persistentAgentTurns)
      .where(eq(persistentAgentTurns.id, oldTurn.id));
    expect(tr).toMatchObject({ promptUsed: null, wakePayload: null, summary: null });
    expect(
      await db
        .select()
        .from(persistentAgentMessages)
        .where(eq(persistentAgentMessages.turnId, oldTurn.id)),
    ).toEqual([]);

    expect(
      await db
        .select()
        .from(sessionChatEvents)
        .where(eq(sessionChatEvents.sessionId, oldSession.id)),
    ).toEqual([]);
    const [s] = await db
      .select()
      .from(interactiveSessions)
      .where(eq(interactiveSessions.id, oldSession.id));
    expect(s.initialPrompt).toBe("");
    const [ct] = await db
      .select()
      .from(sessionChatTurns)
      .where(eq(sessionChatTurns.sessionId, oldSession.id));
    expect(ct.prompt).toBeNull();

    expect(
      await db
        .select()
        .from(localTerminalTranscripts)
        .where(eq(localTerminalTranscripts.terminalId, oldTerminal.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(localTerminalSnapshots)
        .where(eq(localTerminalSnapshots.terminalId, oldTerminal.id)),
    ).toEqual([]);
    const [lt] = await db
      .select()
      .from(localTerminals)
      .where(eq(localTerminals.id, oldTerminal.id));
    expect(lt.preview).toBeNull();
  });

  it("keeps recent work, running work and active sessions whole", async () => {
    const recent = await finishedTask(5);
    const running = await insertTask({
      state: "running",
      execState: "started",
      prompt: "still going",
      completedAt: null,
      updatedAt: ago(90),
    });
    await addLogs({ taskId: running.id });
    // Terminal state but its agent is recorded as started: not finished.
    const stillAttached = await insertTask({
      state: "failed",
      execState: "started",
      completedAt: ago(90),
      prompt: "attached",
    });
    await addLogs({ taskId: stillAttached.id });
    const queuedOld = await insertTask({ state: "queued", createdAt: ago(90), updatedAt: ago(90) });
    await addLogs({ taskId: queuedOld.id });
    // Failed long ago, but its PR is open: still watched, may be resumed.
    const openPr = await insertTask({
      state: "failed",
      completedAt: ago(90),
      prUrl: "https://github.com/o/r/pull/7",
      prState: "open",
    });
    await addLogs({ taskId: openPr.id });
    const liveReview = await reviewRun(60, "running");
    const liveTurn = await agentTurn(null);
    const activeSession = await session(null);
    const recentSession = await session(3);
    const liveTerminal = await terminal(null);

    await pruneRunData(NOW, RETAIN);

    expect(await logsOf(recent.id)).toHaveLength(2);
    expect(await run(recent.id)).toMatchObject({
      prompt: "the secret plan",
      resultSummary: "did the thing",
    });
    expect(isPromptPruned(await run(recent.id))).toBe(false);
    for (const t of [running, stillAttached, queuedOld, openPr]) {
      expect(await logsOf(t.id)).toHaveLength(2);
      expect((await run(t.id)).prompt).not.toBe("");
    }
    expect(
      await db.select().from(taskLogs).where(eq(taskLogs.prReviewRunId, liveReview.run.id)),
    ).toHaveLength(2);
    expect(
      await db
        .select()
        .from(prReviewChatMessages)
        .where(eq(prReviewChatMessages.prReviewId, liveReview.review.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(taskLogs).where(eq(taskLogs.persistentAgentTurnId, liveTurn.id)),
    ).toHaveLength(2);
    expect(
      await db
        .select()
        .from(persistentAgentMessages)
        .where(eq(persistentAgentMessages.turnId, liveTurn.id)),
    ).toHaveLength(1);
    for (const s of [activeSession, recentSession]) {
      expect(
        await db.select().from(sessionChatEvents).where(eq(sessionChatEvents.sessionId, s.id)),
      ).toHaveLength(3);
    }
    expect(
      await db
        .select()
        .from(localTerminalTranscripts)
        .where(eq(localTerminalTranscripts.terminalId, liveTerminal.id)),
    ).toHaveLength(1);
  });

  it("off (null days) deletes nothing, however old", async () => {
    const old = await finishedTask(4000);
    const oldSession = await session(4000);
    expect(await pruneRunData(NOW, null)).toBe(0);
    expect(await logsOf(old.id)).toHaveLength(2);
    expect((await run(old.id)).prompt).toBe("the secret plan");
    expect(
      await db
        .select()
        .from(sessionChatEvents)
        .where(eq(sessionChatEvents.sessionId, oldSession.id)),
    ).toHaveLength(3);
  });

  it("drains a large backlog in batches, then rests once it has caught up", async () => {
    const task = await finishedTask(100);
    const n = RETENTION_BATCH * 2 + 10;
    for (let i = 0; i < n; i += 1000) {
      await addLogs({ taskId: task.id }, Math.min(1000, n - i));
    }
    const before = (await logsOf(task.id)).length;
    expect(before).toBe(n + 2);

    await pruneRunData(NOW, RETAIN);
    expect((await logsOf(task.id)).length).toBe(before - RETENTION_BATCH);
    await pruneRunData(new Date(NOW.getTime() + 1), RETAIN);
    expect((await logsOf(task.id)).length).toBe(before - 2 * RETENTION_BATCH);
    // The pass that empties the backlog finds less than a batch: caught up.
    await pruneRunData(new Date(NOW.getTime() + 2), RETAIN);
    expect(await logsOf(task.id)).toHaveLength(0);

    // Resting: new old rows wait for the next pass.
    await addLogs({ taskId: task.id }, 1);
    expect(await pruneRunData(new Date(NOW.getTime() + 3), RETAIN)).toBe(0);
    expect(await logsOf(task.id)).toHaveLength(1);
    resetRetentionRest();
    await pruneRunData(new Date(NOW.getTime() + 4), RETAIN);
    expect(await logsOf(task.id)).toHaveLength(0);
  });

  it("a second pass over caught-up rows changes nothing", async () => {
    const old = await finishedTask(45);
    await pruneRunData(NOW, RETAIN);
    const first = await run(old.id);
    resetRetentionRest();
    expect(await pruneRunData(new Date(NOW.getTime() + 1), RETAIN)).toBe(0);
    expect(await run(old.id)).toEqual(first);
  });

  it("a task whose prompt was removed can't be retried or redone; a recent one isn't marked", async () => {
    const { controlTask, TaskControlError } = await import("./task-control-service.js");
    const old = await finishedTask(45, "failed");
    await pruneRunData(NOW, RETAIN);
    for (const action of ["retry", "redo"] as const) {
      await expect(controlTask(old.id, action)).rejects.toBeInstanceOf(TaskControlError);
    }
    expect((await run(old.id)).state).toBe("failed");
    const recent = await finishedTask(1, "failed");
    expect(isPromptPruned(await run(recent.id))).toBe(false);
  });
});
