/**
 * The cost dashboard reads every kind of run in the workspace. Like the
 * lists, it shows a member the organization's runs and their own: another
 * member's private task or pod session (title, spend, link) is theirs and
 * the admins' to see.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { interactiveSessions, users } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { analyticsRoutes } from "./analytics.js";

async function insertUser(displayName: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(4).toString("hex")}`,
      email: `${randomBytes(4).toString("hex")}@costs.it`,
      displayName,
    })
    .returning();
  return row.id;
}

describe("cost dashboard and private work (integration)", () => {
  it("leaves another member's private task and session out of a member's costs", async () => {
    const ws = (await insertWorkspace()).id;
    const owner = await insertUser("Owner");
    const other = await insertUser("Other");
    await insertTask({ workspaceId: ws, title: "org task", costUsd: "1.00" });
    await insertTask({
      workspaceId: ws,
      ownerUserId: owner,
      title: "private task",
      costUsd: "2.00",
    });
    await db.insert(interactiveSessions).values({
      repoUrl: "https://github.com/it-org/costs",
      branch: "main",
      title: "private session",
      userId: owner,
      workspaceId: ws,
      costUsd: "3.00",
    });
    const costsFor = async (id: string, workspaceRole: "admin" | "member") => {
      const app = await buildRouteTestApp(analyticsRoutes, {
        user: { id, workspaceId: ws, workspaceRole },
      });
      const res = await app.inject({ url: "/api/analytics/costs?days=30" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      return {
        total: Number(body.summary.totalCost),
        titles: (body.topTasks as Array<{ title: string }>).map((t) => t.title).sort(),
      };
    };
    expect(await costsFor(other, "member")).toEqual({ total: 1, titles: ["org task"] });
    expect(await costsFor(owner, "member")).toEqual({
      total: 6,
      titles: ["org task", "private session", "private task"],
    });
    expect((await costsFor(other, "admin")).total).toBe(6);
  });
});
