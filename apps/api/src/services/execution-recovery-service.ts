import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflowRuns, persistentAgents, persistentAgentTurns } from "../db/schema.js";

/** Called once before serving requests or starting workers (one API replica).
 * Preserve attempt records and consumed messages. A lost stream cannot prove
 * whether an external side effect happened, so never replay these attempts.
 * Local processes reconnect through their daemon and stay running. */
export async function recoverInterruptedExecutions() {
  const message =
    "API restarted during execution. Outcome is uncertain; inspect saved output and side effects before explicitly resuming.";
  await db.transaction(async (tx) => {
    await tx
      .update(workflowRuns)
      .set({
        state: "failed",
        recoveryRequired: true,
        errorMessage: message,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(workflowRuns.state, "running"), isNull(workflowRuns.localTerminalId)));
    const agents = await tx
      .update(persistentAgents)
      .set({
        state: "failed",
        lastFailureReason: message,
        lastFailureAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(persistentAgents.state, ["running", "provisioning"]))
      .returning({ id: persistentAgents.id });
    if (agents.length)
      await tx
        .update(persistentAgentTurns)
        .set({ haltReason: "error", errorMessage: message, finishedAt: new Date() })
        .where(
          and(
            inArray(
              persistentAgentTurns.agentId,
              agents.map((a) => a.id),
            ),
            isNull(persistentAgentTurns.finishedAt),
          ),
        );
  });
}
