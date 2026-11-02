/**
 * The assistant's action log is one table for the whole deployment. Each
 * workspace sees its own rows: Job and connection actions have to record
 * the workspace they happened in, and the list has to filter by it.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { optioActions, users } from "../db/schema.js";
import { logAction } from "../services/optio-action-service.js";
import { getRedisClient } from "../services/event-bus.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertWorkflow, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { optioRoutes } from "./optio.js";
import { workflowRoutes } from "./workflows.js";

afterAll(async () => {
  await getRedisClient().quit();
});

async function insertUser() {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(4).toString("hex")}`,
      email: `${randomBytes(4).toString("hex")}@actions.it`,
      displayName: "Actions",
    })
    .returning();
  return row;
}

describe("Optio action log scope (integration)", () => {
  it("lists the caller's workspace's actions, and legacy unscoped ones only to its admins", async () => {
    const a = await insertWorkspace();
    const b = await insertWorkspace();
    const user = await insertUser();
    const tag = randomBytes(4).toString("hex");
    await logAction({ workspaceId: a.id, userId: user.id, action: `it.${tag}.a`, success: true });
    await logAction({ workspaceId: b.id, userId: user.id, action: `it.${tag}.b`, success: true });
    await logAction({
      workspaceId: null,
      userId: user.id,
      action: `it.${tag}.none`,
      success: true,
    });

    const actionsAs = async (workspaceRole: "admin" | "member") => {
      const app = await buildRouteTestApp(optioRoutes, {
        user: { id: user.id, workspaceId: a.id, workspaceRole },
      });
      const res = await app.inject({ url: `/api/optio/actions?userId=${user.id}&limit=500` });
      expect(res.statusCode).toBe(200);
      return (res.json().actions as Array<{ action: string }>)
        .map((x) => x.action)
        .filter((x) => x.startsWith(`it.${tag}.`))
        .sort();
    };
    expect(await actionsAs("member")).toEqual([`it.${tag}.a`]);
    expect(await actionsAs("admin")).toEqual([`it.${tag}.a`, `it.${tag}.none`]);
  });

  it("records a Job's actions in the Job's workspace", async () => {
    const ws = await insertWorkspace();
    const user = await insertUser();
    const job = await insertWorkflow({ workspaceId: ws.id });
    const app = await buildRouteTestApp(workflowRoutes, {
      user: { id: user.id, workspaceId: ws.id, workspaceRole: "member" },
    });
    expect((await app.inject({ method: "DELETE", url: `/api/jobs/${job.id}` })).statusCode).toBe(
      204,
    );
    await expect
      .poll(async () =>
        (
          await db
            .select({ workspaceId: optioActions.workspaceId, action: optioActions.action })
            .from(optioActions)
            .where(eq(optioActions.userId, user.id))
        ).map((r) => [r.action, r.workspaceId]),
      )
      .toEqual([["workflow.delete", ws.id]]);
  });
});
