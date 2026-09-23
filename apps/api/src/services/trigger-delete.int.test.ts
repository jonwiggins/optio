/**
 * Deleting a trigger keeps the runs it started. workflow_runs.trigger_id used
 * to reference workflow_triggers with NO ACTION, so deleting a trigger that
 * had fired failed on the foreign key and the API answered 500. Migration
 * 1791000000 makes it ON DELETE SET NULL. Real Postgres: only the database
 * enforces this.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { workflowRuns, workflowTriggers } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import {
  insertWorkflow,
  insertWorkflowRun,
  insertWorkflowTrigger,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { workflowTriggerRoutes } from "../routes/workflow-triggers.js";
import { deleteTrigger } from "./trigger-service.js";

async function jobWithFiredTrigger() {
  const ws = await insertWorkspace();
  const job = await insertWorkflow({ workspaceId: ws.id, name: "nightly" });
  const trigger = await insertWorkflowTrigger(job.id, {
    targetType: "job",
    workflowId: job.id,
    type: "schedule",
    config: { cronExpression: "0 9 * * *" },
  });
  const run = await insertWorkflowRun(job.id, { triggerId: trigger.id, state: "completed" });
  return { ws, job, trigger, run };
}

const runRow = async (id: string) =>
  (await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0];

describe("deleting a trigger that already started runs", () => {
  it("deletes the trigger and keeps its runs (trigger-service)", async () => {
    const { trigger, run } = await jobWithFiredTrigger();

    expect(await deleteTrigger(trigger.id)).toBe(true);

    expect(
      await db.select().from(workflowTriggers).where(eq(workflowTriggers.id, trigger.id)),
    ).toHaveLength(0);
    const kept = await runRow(run.id);
    expect(kept).toMatchObject({ id: run.id, state: "completed", triggerId: null });
  });

  it("DELETE /api/jobs/:id/triggers/:triggerId answers 204, not 500", async () => {
    const { ws, job, trigger, run } = await jobWithFiredTrigger();
    const app = await buildRouteTestApp(workflowTriggerRoutes, {
      user: { id: "u-it", workspaceId: ws.id, workspaceRole: "admin" },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/jobs/${job.id}/triggers/${trigger.id}`,
    });
    expect(res.statusCode, res.body).toBe(204);
    expect((await runRow(run.id)).triggerId).toBeNull();

    // The job's run list still shows the run.
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, job.id));
    expect(runs.map((r) => r.id)).toEqual([run.id]);
    await app.close();
  });
});
