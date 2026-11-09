/**
 * The Work surfaces follow the same scope as the per-kind routes: a person's
 * sessions show in the workspace they were started in, and someone else's
 * personal scheduled Task or Job (its runs and its triggers) is its owner's
 * and the admins' to see.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { interactiveSessions, users } from "../db/schema.js";
import { getRedisClient } from "../services/event-bus.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import {
  insertWorkflow,
  insertWorkflowRun,
  insertWorkflowTrigger,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { workRoutes } from "./work.js";
import { workflowTriggerRoutes } from "./workflow-triggers.js";

afterAll(async () => {
  await getRedisClient().quit();
});

async function insertUser(displayName: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(4).toString("hex")}`,
      email: `${randomBytes(4).toString("hex")}@work-scope.it`,
      displayName,
    })
    .returning();
  return row;
}

describe("Work scope (integration)", () => {
  it("shows a person's session only in the workspace it was started in", async () => {
    const a = await insertWorkspace();
    const b = await insertWorkspace();
    const user = await insertUser("Two");
    const [session] = await db
      .insert(interactiveSessions)
      .values({
        repoUrl: "https://github.com/it-org/scope",
        branch: "main",
        userId: user.id,
        workspaceId: a.id,
      })
      .returning();
    const inWorkspace = (workspaceId: string) =>
      buildRouteTestApp(workRoutes, {
        user: { id: user.id, workspaceId, workspaceRole: "member" },
      });

    const inA = await inWorkspace(a.id);
    const listA = await inA.inject({ url: "/api/work" });
    expect(listA.statusCode).toBe(200);
    expect(JSON.stringify(listA.json())).toContain(session.id);
    expect((await inA.inject({ url: `/api/work/${session.id}` })).statusCode).toBe(200);

    const inB = await inWorkspace(b.id);
    const listB = await inB.inject({ url: "/api/work" });
    expect(listB.statusCode).toBe(200);
    expect(JSON.stringify(listB.json())).not.toContain(session.id);
    expect((await inB.inject({ url: `/api/work/${session.id}` })).statusCode).toBe(404);
  });

  it("keeps a personal Job's runs and triggers to its owner and admins", async () => {
    const ws = await insertWorkspace();
    const owner = await insertUser("Owner");
    const other = await insertUser("Other");
    const job = await insertWorkflow({ workspaceId: ws.id, ownerUserId: owner.id });
    await insertWorkflowRun(job.id, { state: "completed" });
    await insertWorkflowTrigger(job.id, { workflowId: job.id, targetType: "job", type: "manual" });

    const as = async (id: string, workspaceRole: "admin" | "member") => {
      const user = { id, workspaceId: ws.id, workspaceRole };
      const work = await buildRouteTestApp(workRoutes, { user });
      const triggers = await buildRouteTestApp(workflowTriggerRoutes, { user });
      return [
        (await work.inject({ url: `/api/work/${job.id}/runs` })).statusCode,
        (await work.inject({ url: `/api/work/${job.id}/triggers` })).statusCode,
        (await triggers.inject({ url: `/api/jobs/${job.id}/triggers` })).statusCode,
      ];
    };
    expect(await as(other.id, "member")).toEqual([404, 404, 404]);
    expect(await as(other.id, "admin")).toEqual([200, 200, 200]);
    expect(await as(owner.id, "member")).toEqual([200, 200, 200]);
  });
});
