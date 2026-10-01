/**
 * A personal Job runs with its owner's credentials, so acting on one of its
 * runs is the owner's to do: someone else can't retry it (that would run it
 * again as the owner), and stopping it is the owner's or an admin's.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import {
  insertWorkflow,
  insertWorkflowRun,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { workflowRoutes } from "./workflows.js";

async function insertUser(displayName: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(4).toString("hex")}`,
      email: `${displayName.toLowerCase()}@runs.it`,
      displayName,
    })
    .returning();
  return row;
}

describe("Job run retry / cancel (integration)", () => {
  it("leaves a personal Job's runs to its owner (and stopping one to admins too)", async () => {
    const ws = await insertWorkspace();
    const owner = await insertUser("Owner");
    const other = await insertUser("Other");
    const job = await insertWorkflow({ workspaceId: ws.id, ownerUserId: owner.id });
    const failed = await insertWorkflowRun(job.id, { state: "failed" });
    const running = await insertWorkflowRun(job.id, { state: "running", startedAt: new Date() });

    const as = (id: string, workspaceRole: "admin" | "member") =>
      buildRouteTestApp(workflowRoutes, { user: { id, workspaceId: ws.id, workspaceRole } });
    const member = await as(other.id, "member");
    const admin = await as(other.id, "admin");
    const self = await as(owner.id, "member");

    const retry = (app: typeof member, id: string) =>
      app.inject({ method: "POST", url: `/api/workflow-runs/${id}/retry` });
    const cancel = (app: typeof member, id: string) =>
      app.inject({ method: "POST", url: `/api/workflow-runs/${id}/cancel` });

    const denied = await retry(member, failed.id);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatch(/Only Owner can run this/);
    // An admin still can't run someone's work as them.
    expect((await retry(admin, failed.id)).statusCode).toBe(403);
    expect((await cancel(member, running.id)).statusCode).toBe(403);

    expect((await cancel(admin, running.id)).statusCode).toBe(200);
    const retried = await retry(self, failed.id);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().run.state).toBe("queued");
  });

  it("lets anyone in the workspace act on an organization Job's runs", async () => {
    const ws = await insertWorkspace();
    const someone = await insertUser("Someone");
    const job = await insertWorkflow({ workspaceId: ws.id });
    const failed = await insertWorkflowRun(job.id, { state: "failed" });
    const app = await buildRouteTestApp(workflowRoutes, {
      user: { id: someone.id, workspaceId: ws.id, workspaceRole: "member" },
    });
    const res = await app.inject({ method: "POST", url: `/api/workflow-runs/${failed.id}/retry` });
    expect(res.statusCode).toBe(200);
  });
});
