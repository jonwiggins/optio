/**
 * Membership changes reach the audit trail (docs/audit.md) through the real
 * routes and Postgres: a team join request, its approval or denial, a role
 * change and a removal; workspace members added, changed and removed; a
 * workspace's settings saved (field names, never values).
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { optioActions, users, workspaceMembers } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { getRedisClient } from "../services/event-bus.js";
import { teamRoutes } from "./teams.js";
import { workspaceRoutes } from "./workspaces.js";

// These tests run with teams on (off by default).
vi.hoisted(() => {
  process.env.OPTIO_TEAMS_ENABLED = "true";
});

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
  routes: typeof teamRoutes,
  user: { id: string },
  workspaceId: string,
  role: "admin" | "member",
) {
  const app = await buildRouteTestApp(routes, {
    user: { id: user.id, workspaceId, workspaceRole: role },
  });
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

describe("team membership in the audit trail", () => {
  it("records a request, its approval, a role change, a denial and a removal", async () => {
    const ws = await insertWorkspace();
    const [alice, bob, carol] = await Promise.all([
      person("alice"),
      person("bob"),
      person("carol"),
    ]);
    await db.insert(workspaceMembers).values([
      { workspaceId: ws.id, userId: alice.id, role: "admin" },
      { workspaceId: ws.id, userId: bob.id, role: "member" },
      { workspaceId: ws.id, userId: carol.id, role: "member" },
    ]);
    const asAlice = await as(teamRoutes, alice, ws.id, "admin");
    const made = await asAlice.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: `Platform ${uniq()}`, joinPolicy: "request" },
    });
    expect(made.statusCode, made.body).toBe(201);
    const teamId = made.json().team.id as string;

    const asBob = await as(teamRoutes, bob, ws.id, "member");
    expect(
      (await asBob.inject({ method: "POST", url: `/api/teams/${teamId}/join` })).statusCode,
    ).toBe(200);
    const asCarol = await as(teamRoutes, carol, ws.id, "member");
    expect(
      (await asCarol.inject({ method: "POST", url: `/api/teams/${teamId}/join` })).statusCode,
    ).toBe(200);

    const decide = (userId: string, decision: string) =>
      asAlice.inject({
        method: "POST",
        url: `/api/teams/${teamId}/members/${userId}/decide`,
        payload: { decision },
      });
    expect((await decide(bob.id, "approve")).statusCode).toBe(200);
    expect((await decide(carol.id, "deny")).statusCode).toBe(200);
    expect(
      (
        await asAlice.inject({
          method: "PATCH",
          url: `/api/teams/${teamId}/members/${bob.id}`,
          payload: { role: "admin" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await asAlice.inject({ method: "DELETE", url: `/api/teams/${teamId}/members/${bob.id}` }))
        .statusCode,
    ).toBe(200);

    const rows = await trail(
      ws.id,
      [
        "team.create",
        "team.join.request",
        "team.join.approve",
        "team.join.deny",
        "team.member.role",
        "team.member.remove",
      ],
      7,
    );
    const seen = rows.map((r) => [r.action, r.userId, r.params?.targetUserId ?? null]);
    expect(seen).toEqual(
      expect.arrayContaining([
        ["team.create", alice.id, null],
        ["team.join.request", bob.id, null],
        ["team.join.request", carol.id, null],
        ["team.join.approve", alice.id, bob.id],
        ["team.join.deny", alice.id, carol.id],
        ["team.member.role", alice.id, bob.id],
        ["team.member.remove", alice.id, bob.id],
      ]),
    );
    expect(rows.every((r) => r.params?.teamId === teamId || r.action === "team.create")).toBe(true);
    expect(rows.find((r) => r.action === "team.member.role")?.params).toMatchObject({
      role: "admin",
    });
  });
});

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
      payload: { workVisibility: "teams", autoJoinDomains: ["example.test"] },
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
        ["workspace.settings", { fields: ["autoJoinDomains", "workVisibility"] }],
      ]),
    );
    expect(rows.every((r) => r.userId === admin.id && r.clientIp === "127.0.0.1")).toBe(true);
  });
});
