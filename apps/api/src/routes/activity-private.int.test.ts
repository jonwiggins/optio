/**
 * The activity feed's task transitions follow the task list's rule: another
 * member's private task is theirs and the admins' to see, so its state
 * changes (with its id) stay out of a member's feed.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { taskEvents, users } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { activityRoutes } from "./activity.js";

async function insertUser(displayName: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(4).toString("hex")}`,
      email: `${randomBytes(4).toString("hex")}@activity-private.it`,
      displayName,
    })
    .returning();
  return row.id;
}

describe("activity feed and private tasks (integration)", () => {
  it("shows a private task's transitions to its owner and admins only", async () => {
    const ws = (await insertWorkspace()).id;
    const owner = await insertUser("Owner");
    const other = await insertUser("Other");
    const org = await insertTask({ workspaceId: ws });
    const mine = await insertTask({ workspaceId: ws, ownerUserId: owner });
    await db.insert(taskEvents).values(
      [org, mine].map((t) => ({
        taskId: t.id,
        fromState: "pending" as const,
        toState: "queued" as const,
        trigger: "test",
      })),
    );
    const feedOf = async (id: string, workspaceRole: "admin" | "member") => {
      const app = await buildRouteTestApp(activityRoutes, {
        user: { id, workspaceId: ws, workspaceRole },
      });
      const res = await app.inject({ url: "/api/activity?type=task_event" });
      expect(res.statusCode).toBe(200);
      return (res.json().items as Array<{ resourceId: string }>).map((i) => i.resourceId).sort();
    };
    expect(await feedOf(other, "member")).toEqual([org.id]);
    expect(await feedOf(owner, "member")).toEqual([org.id, mine.id].sort());
    expect(await feedOf(other, "admin")).toEqual([org.id, mine.id].sort());
  });
});
