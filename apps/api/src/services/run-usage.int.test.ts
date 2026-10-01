/**
 * Spend accumulation in Postgres: exact decimal strings (no float drift, no
 * trailing zeros, no scientific notation), null / '' treated as zero, and no
 * lost update when writers race.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { persistentAgents, tasks } from "../db/schema.js";
import { insertTask } from "../test-utils/integration/fixtures.js";
import { addUsage, plusCost } from "./run-usage.js";

async function costAfter(start: string | null, add: number | string): Promise<string | null> {
  const task = await insertTask({ costUsd: start });
  const [row] = await db
    .update(tasks)
    .set({ costUsd: plusCost(tasks.costUsd, add) })
    .where(eq(tasks.id, task.id))
    .returning({ costUsd: tasks.costUsd });
  return row.costUsd;
}

describe("run usage accumulation", () => {
  it("adds exactly, as a plain decimal string", async () => {
    expect(await costAfter(null, 0.0123)).toBe("0.0123");
    expect(await costAfter("", 1)).toBe("1");
    expect(await costAfter("0.1", 0.2)).toBe("0.3");
    expect(await costAfter("1.50", "0.25")).toBe("1.75");
    expect(await costAfter("2", 1e-7)).toBe("2.0000001");
  });

  it("adds tokens and records the model, leaving absent fields alone", async () => {
    const task = await insertTask({ costUsd: "1", inputTokens: 100, outputTokens: null });
    const [row] = await db
      .update(tasks)
      .set(addUsage(tasks, { inputTokens: 50, outputTokens: 7, model: "claude-opus-5" }))
      .where(eq(tasks.id, task.id))
      .returning();
    expect(row).toMatchObject({
      costUsd: "1",
      inputTokens: 150,
      outputTokens: 7,
      modelUsed: "claude-opus-5",
    });
    expect(addUsage(tasks, {})).toEqual({});
  });

  it("never loses a concurrent writer's spend", async () => {
    const [agent] = await db
      .insert(persistentAgents)
      .values({ slug: "racer", name: "Racer", initialPrompt: "hi" })
      .returning();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        db
          .update(persistentAgents)
          .set({ totalCostUsd: plusCost(persistentAgents.totalCostUsd, "0.05") })
          .where(eq(persistentAgents.id, agent.id)),
      ),
    );
    const [after] = await db
      .select({ total: persistentAgents.totalCostUsd })
      .from(persistentAgents)
      .where(eq(persistentAgents.id, agent.id));
    expect(after.total).toBe("1");
  });
});
