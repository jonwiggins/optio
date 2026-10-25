/**
 * One log store for every kind of run: lines of a task, a PR-review run, and
 * a persistent-agent turn live side by side and never leak into each other.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { TaskState } from "@optio/shared";
import { db } from "../db/client.js";
import {
  persistentAgents,
  persistentAgentTurns,
  prReviewRuns,
  prReviews,
  workRuns,
} from "../db/schema.js";
import { insertTask } from "../test-utils/integration/fixtures.js";
import { appendRunLogsBatch, insertLog, listLogs } from "./run-log-service.js";
import { listTurnLogs } from "./persistent-agent-service.js";

describe("run-log-service", () => {
  it("stores and lists each owner's lines in order, filtered", async () => {
    const task = await insertTask();
    const [review] = await db
      .insert(prReviews)
      .values({
        prUrl: "https://github.com/acme/app/pull/1",
        prNumber: 1,
        repoOwner: "acme",
        repoName: "app",
        repoUrl: "https://github.com/acme/app",
        headSha: "abc",
      })
      .returning();
    const [run] = await db.insert(prReviewRuns).values({ prReviewId: review.id }).returning();
    const [agent] = await db
      .insert(persistentAgents)
      .values({ slug: "forge", name: "Forge", initialPrompt: "hi" })
      .returning();
    const [turn] = await db
      .insert(persistentAgentTurns)
      .values({ agentId: agent.id, turnNumber: 1, wakeSource: "initial" })
      .returning();

    const first = await insertLog({ taskId: task.id }, { content: "reading files" });
    await insertLog({ taskId: task.id }, { content: "Error: boom", logType: "error" });
    await insertLog({ prReviewRunId: run.id }, { content: "LGTM", stream: "stdout" });
    await insertLog(
      { persistentAgentTurnId: turn.id },
      { content: "hello", logType: "text", metadata: { turn: 1 } },
    );

    expect(first).toMatchObject({ taskId: task.id, stream: "stdout", logType: null });
    expect((await listLogs({ taskId: task.id })).map((l) => l.content)).toEqual([
      "reading files",
      "Error: boom",
    ]);
    expect(
      (await listLogs({ taskId: task.id }, { logType: "error" })).map((l) => l.content),
    ).toEqual(["Error: boom"]);
    expect(
      (await listLogs({ taskId: task.id }, { search: "READING" })).map((l) => l.content),
    ).toEqual(["reading files"]);
    expect((await listLogs({ taskId: task.id }, { limit: 1 })).map((l) => l.content)).toEqual([
      "reading files",
    ]);
    expect((await listLogs({ prReviewRunId: run.id })).map((l) => l.content)).toEqual(["LGTM"]);

    // The agent routes keep serving the turn-log shape.
    expect(await listTurnLogs(turn.id)).toEqual([
      expect.objectContaining({
        turnId: turn.id,
        content: "hello",
        logType: "text",
        metadata: { turn: 1 },
      }),
    ]);
  });

  it("stores a line with a NUL as U+FFFD instead of failing the insert", async () => {
    // Postgres rejects a NUL in text (22021) and in jsonb (22P05): the one
    // line used to fail the run, since every re-attach replayed it.
    const holder = "it-instance:000000/0001";
    const run = await insertTask({
      state: TaskState.RUNNING,
      execState: "started",
      attachedBy: holder,
      consumedBytes: 0,
    });

    const stored = await appendRunLogsBatch(
      { kind: "work-run", id: run.id },
      [
        { content: "a\u0000b", logType: "text", metadata: { x: "\u0000", nested: ["\u0000"] } },
        { content: "clean", logType: "text" },
      ],
      { from: 0, to: 20 },
      holder,
    );
    expect(stored.map((l) => l.content)).toEqual(["a�b", "clean"]);
    expect(stored[0].metadata).toEqual({ x: "�", nested: ["�"] });
    const [after] = await db
      .select({ consumedBytes: workRuns.consumedBytes })
      .from(workRuns)
      .where(eq(workRuns.id, run.id));
    expect(after.consumedBytes).toBe(20);

    const single = await insertLog(
      { taskId: run.id },
      { content: "\u0000", metadata: { detail: "x\u0000y" } },
    );
    expect(single).toMatchObject({ content: "�", metadata: { detail: "x�y" } });
    // (The batch's two rows share a timestamp, so their order is the ids'.)
    expect((await listLogs({ taskId: run.id })).map((l) => l.content).sort()).toEqual(
      ["a�b", "clean", "�"].sort(),
    );
  });
});
