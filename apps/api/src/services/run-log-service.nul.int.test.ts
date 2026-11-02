/**
 * Agent output with a NUL (U+0000) is stored, not rejected. Postgres refuses
 * a NUL in a text column (22021) and inside any string of a jsonb value
 * (22P05); before the fix one such line failed the insert, and with it the
 * run. The NUL is stored as U+FFFD.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { persistentAgents, persistentAgentTurns, tasks, workRuns } from "../db/schema.js";
import { insertTask } from "../test-utils/integration/fixtures.js";
import { appendRunLogsBatch, insertLog, listLogs } from "./run-log-service.js";
import { updateTaskResult } from "./task-service.js";
import { haltPersistentAgentTurn } from "./persistent-agent-service.js";
import { sanitizeTranscriptEntries } from "./local-terminal-service.js";

const NUL = "\u0000";
const FFFD = "�";

describe("NUL-safe log storage", () => {
  it("stores a log line whose content and metadata carry a NUL", async () => {
    const task = await insertTask();

    const row = await insertLog(
      { taskId: task.id },
      {
        content: `binary${NUL}output`,
        logType: "tool_result",
        metadata: { tool: "Read", output: [`a${NUL}b`, { nested: NUL }], [`k${NUL}`]: 1 },
      },
    );

    expect(row.content).toBe(`binary${FFFD}output`);
    const [stored] = await listLogs({ taskId: task.id });
    expect(stored.content).toBe(`binary${FFFD}output`);
    expect(stored.metadata).toEqual({
      tool: "Read",
      output: [`a${FFFD}b`, { nested: FFFD }],
      [`k${FFFD}`]: 1,
    });
  });

  it("stores a run's log batch that carries a NUL and advances its offset", async () => {
    const task = await insertTask();
    await db
      .update(workRuns)
      .set({ attachedBy: "instance-a/0001", consumedBytes: 0 })
      .where(eq(workRuns.id, task.id));

    const rows = await appendRunLogsBatch(
      { kind: "work-run", id: task.id },
      [{ content: "clean" }, { content: `x${NUL}y`, metadata: { raw: `${NUL}` } }],
      { from: 0, to: 20 },
      "instance-a/0001",
    );

    expect(rows.map((r) => r.content)).toEqual(["clean", `x${FFFD}y`]);
    expect(rows[1].metadata).toEqual({ raw: FFFD });
    const [run] = await db.select().from(workRuns).where(eq(workRuns.id, task.id));
    expect(run.consumedBytes).toBe(20);
  });

  it("stores a task's result and error that carry a NUL", async () => {
    const task = await insertTask();

    await updateTaskResult(task.id, `done${NUL}`, `stderr: ${NUL}boom`);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.resultSummary).toBe(`done${FFFD}`);
    expect(row.errorMessage).toBe(`stderr: ${FFFD}boom`);
  });

  it("stores a persistent-agent turn's summary and error that carry a NUL", async () => {
    const [agent] = await db
      .insert(persistentAgents)
      .values({ slug: "nul-agent", name: "Nul", initialPrompt: "hi" })
      .returning();
    const [turn] = await db
      .insert(persistentAgentTurns)
      .values({ agentId: agent.id, turnNumber: 1, wakeSource: "initial" })
      .returning();

    await haltPersistentAgentTurn({
      turnId: turn.id,
      haltReason: "error",
      errorMessage: `failed${NUL}`,
      summary: `half${NUL}done`,
    });

    const [row] = await db
      .select()
      .from(persistentAgentTurns)
      .where(eq(persistentAgentTurns.id, turn.id));
    expect(row.errorMessage).toBe(`failed${FFFD}`);
    expect(row.summary).toBe(`half${FFFD}done`);
  });

  it("cleans a local transcript entry's text and detail before it is stored", () => {
    const [entry] = sanitizeTranscriptEntries([
      { seq: 1, role: "assistant", kind: "text", text: `hi${NUL}`, detail: `d${NUL}` },
    ]);
    expect(entry.text).toBe(`hi${FFFD}`);
    expect(entry.detail).toBe(`d${FFFD}`);
  });
});
