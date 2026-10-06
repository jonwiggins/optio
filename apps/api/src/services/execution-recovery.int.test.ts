import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflowRuns, persistentAgents, persistentAgentTurns, agentPods } from "../db/schema.js";
import { insertWorkflow, insertWorkflowRun } from "../test-utils/integration/fixtures.js";
import { idlePods } from "./agent-pod-pool.js";
import { recoverInterruptedExecutions } from "./execution-recovery-service.js";

it("retains uncertain pod attempts without replaying, and leaves local processes to reconnect", async () => {
  const job = await insertWorkflow();
  const [pod] = await db
    .insert(agentPods)
    .values({ pool: "standalone", poolKey: job.id, state: "ready", activeCount: 0 })
    .returning();
  const run = await insertWorkflowRun(job.id, { state: "running", lastPodId: pod.id });
  const local = await insertWorkflowRun(job.id, {
    state: "running",
    localTerminalId: randomUUID(),
  });
  const [agent] = await db
    .insert(persistentAgents)
    .values({ name: randomUUID(), slug: randomUUID(), initialPrompt: "Run once", state: "running" })
    .returning();
  const [turn] = await db
    .insert(persistentAgentTurns)
    .values({ agentId: agent.id, turnNumber: 1, wakeSource: "user", promptUsed: "Run once" })
    .returning();
  await recoverInterruptedExecutions();
  const [recovered] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
  expect(recovered).toMatchObject({ state: "failed", recoveryRequired: true });
  expect(await idlePods("standalone", new Date(Date.now() + 60000))).toEqual([]);
  const [untouched] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, local.id));
  expect(untouched.state).toBe("running");
  const [pa] = await db.select().from(persistentAgents).where(eq(persistentAgents.id, agent.id));
  expect(pa.state).toBe("failed");
  const [attempt] = await db
    .select()
    .from(persistentAgentTurns)
    .where(eq(persistentAgentTurns.id, turn.id));
  expect(attempt).toMatchObject({ promptUsed: "Run once", haltReason: "error" });
  expect(attempt.finishedAt).not.toBeNull();
  await recoverInterruptedExecutions();
  const [same] = await db
    .select()
    .from(persistentAgentTurns)
    .where(eq(persistentAgentTurns.id, turn.id));
  expect(same.finishedAt).toEqual(attempt.finishedAt);
});
