/**
 * A persistent agent's turn text against real Postgres: a summary, an error
 * or a failure reason quoting agent output with a NUL in it is stored with
 * U+FFFD (nul.ts) instead of failing the write — which left the turn
 * unfinished and the agent stuck running.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PersistentAgentState } from "@optio/shared";
import { db } from "../db/client.js";
import { persistentAgents, persistentAgentTurns } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  haltPersistentAgentTurn,
  transitionPersistentAgentState,
} from "./persistent-agent-service.js";

async function insertAgent(state: PersistentAgentState = PersistentAgentState.RUNNING) {
  const ws = await insertWorkspace();
  const [agent] = await db
    .insert(persistentAgents)
    .values({
      workspaceId: ws.id,
      slug: `nul-${randomBytes(4).toString("hex")}`,
      name: "Nul",
      initialPrompt: "hi",
      state,
    })
    .returning();
  return agent;
}

describe("persistent agent turn text with a NUL", () => {
  it("halts the turn with its summary and error stored", async () => {
    const agent = await insertAgent();
    const [turn] = await db
      .insert(persistentAgentTurns)
      .values({ agentId: agent.id, turnNumber: 1, wakeSource: "initial" })
      .returning();

    await haltPersistentAgentTurn({
      turnId: turn.id,
      haltReason: "error",
      errorMessage: "stderr: \u0000\u0000 binary",
      summary: "did \u0000 things",
    });

    const [row] = await db
      .select()
      .from(persistentAgentTurns)
      .where(eq(persistentAgentTurns.id, turn.id));
    expect(row.finishedAt).not.toBeNull();
    expect(row.errorMessage).toBe("stderr: �� binary");
    expect(row.summary).toBe("did � things");
  });

  it("records the agent's failure reason", async () => {
    const agent = await insertAgent();
    const moved = await transitionPersistentAgentState(
      agent.id,
      PersistentAgentState.IDLE,
      agent.updatedAt,
      { lastFailureReason: "turn failed: \u0000" },
    );
    expect(moved).toBe(true);
    const [row] = await db.select().from(persistentAgents).where(eq(persistentAgents.id, agent.id));
    expect(row.lastFailureReason).toBe("turn failed: �");
  });
});
