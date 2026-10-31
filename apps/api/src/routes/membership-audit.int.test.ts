/**
 * Membership changes reach the audit trail (docs/audit.md) through the real
 * routes and Postgres: workspace members added, changed and removed; a
 * workspace's settings saved (field names, never values).
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { optioActions, users, workspaceMembers } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { getRedisClient } from "../services/event-bus.js";
import { workspaceRoutes } from "./workspaces.js";

const uniq = () => randomBytes(4).toString("hex");

async function person(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `${name}-${uniq()}@example.test`,
      displayName: name,
    })
    .returning();
  return row;
}

const apps: FastifyInstance[] = [];
async function as(
  routes: typeof workspaceRoutes,
  user: { id: string; email: string },
  workspaceId: string,
  role: "admin" | "member",
) {
  const signedInUser = { id: user.id, email: user.email, workspaceId, workspaceRole: role };
  const app = await buildRouteTestApp(routes, { user: signedInUser });
  apps.push(app);
  return app;
}

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await getRedisClient().quit();
});

/** This workspace's audit entries of these actions, oldest first (written without waiting). */
async function trail(workspaceId: string, actions: string[], expected: number) {
  let rows: (typeof optioActions.$inferSelect)[] = [];
  for (let i = 0; i < 40; i++) {
    rows = await db
      .select()
      .from(optioActions)
      .where(and(eq(optioActions.workspaceId, workspaceId), inArray(optioActions.action, actions)))
      .orderBy(asc(optioActions.createdAt));
    if (rows.length >= expected) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return rows;
}

describe("workspace membership and settings in the audit trail", () => {
  it("records members added, changed and removed, and settings saved by field name", async () => {
    const ws = await insertWorkspace();
    const [admin, dana] = await Promise.all([person("admin"), person("dana")]);
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: admin.id, role: "admin" });
    const app = await as(workspaceRoutes, admin, ws.id, "admin");

    const added = await app.inject({
      method: "POST",
      url: `/api/workspaces/${ws.id}/members`,
      payload: { userId: dana.id, role: "viewer" },
    });
    expect(added.statusCode, added.body).toBe(201);
    await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${ws.id}/members/${dana.id}`,
      payload: { role: "member" },
    });
    await app.inject({ method: "DELETE", url: `/api/workspaces/${ws.id}/members/${dana.id}` });
    const saved = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${ws.id}`,
      payload: { name: "Renamed", autoJoinDomains: ["example.test"] },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const rows = await trail(
      ws.id,
      [
        "workspace.member.add",
        "workspace.member.role",
        "workspace.member.remove",
        "workspace.settings",
      ],
      4,
    );
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => [r.action, r.params])).toEqual(
      expect.arrayContaining([
        ["workspace.member.add", { targetUserId: dana.id, role: "viewer" }],
        ["workspace.member.role", { targetUserId: dana.id, role: "member" }],
        ["workspace.member.remove", { targetUserId: dana.id }],
        ["workspace.settings", { fields: ["autoJoinDomains", "name"] }],
      ]),
    );
    expect(rows.every((r) => r.userId === admin.id && r.clientIp === "127.0.0.1")).toBe(true);
  });
});
