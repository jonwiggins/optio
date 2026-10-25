/**
 * Settings that hold a site's credentials reach the audit trail
 * (docs/audit.md) through the real routes and Postgres: a remote-workspace
 * connection added, changed and removed (through the older Coder routes,
 * which answer the same); a ticket provider (Jira) added, re-enabled and
 * removed; an admin removing someone else's personal token (offboarding),
 * which names whose token it was. Never a token's value.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, asc, eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { optioActions, users, workspaceMembers } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { getRedisClient } from "../services/event-bus.js";
import { storeSecret } from "../services/secret-service.js";
import { remoteWorkspaceRoutes } from "./remote-workspaces.js";
import { secretRoutes } from "./secrets.js";
import { ticketRoutes } from "./tickets.js";

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
  routes: typeof remoteWorkspaceRoutes,
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

async function org() {
  const ws = await insertWorkspace();
  const [admin, bob] = await Promise.all([person("admin"), person("bob")]);
  await db.insert(workspaceMembers).values([
    { workspaceId: ws.id, userId: admin.id, role: "admin" },
    { workspaceId: ws.id, userId: bob.id, role: "member" },
  ]);
  return { ws, admin, bob };
}

/** This workspace's entries whose action starts with `prefix`, oldest first (written without waiting). */
async function trail(workspaceId: string, prefix: string, expected: number) {
  let rows: (typeof optioActions.$inferSelect)[] = [];
  for (let i = 0; i < 40; i++) {
    rows = await db
      .select()
      .from(optioActions)
      .where(
        and(eq(optioActions.workspaceId, workspaceId), like(optioActions.action, `${prefix}%`)),
      )
      .orderBy(asc(optioActions.createdAt));
    if (rows.length >= expected) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return rows;
}

describe("remote-workspace connections in the audit trail", () => {
  it("records one added, changed and removed, with its owner and never its token", async () => {
    const { ws, admin } = await org();
    const app = await as(remoteWorkspaceRoutes, admin, ws.id, "admin");
    const made = await app.inject({
      method: "POST",
      url: "/api/coder/connections",
      payload: { name: "Site Coder", url: "https://coder.example.com", token: "coder-secret-1" },
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().connection.id as string;
    const changed = await app.inject({
      method: "PATCH",
      url: `/api/coder/connections/${id}`,
      payload: { token: "coder-secret-2", name: "Site Coder 2" },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const removed = await app.inject({ method: "DELETE", url: `/api/coder/connections/${id}` });
    expect(removed.statusCode, removed.body).toBe(204);

    const rows = await trail(ws.id, "remote_workspace_connection.", 3);
    const provider = "coder";
    expect(rows.map((r) => [r.action, r.userId, r.params])).toEqual([
      [
        "remote_workspace_connection.create",
        admin.id,
        { id, provider, name: "Site Coder", scope: "workspace" },
      ],
      [
        "remote_workspace_connection.update",
        admin.id,
        { id, provider, name: "Site Coder 2", scope: "workspace", fields: ["name", "token"] },
      ],
      [
        "remote_workspace_connection.delete",
        admin.id,
        { id, provider, name: "Site Coder 2", scope: "workspace" },
      ],
    ]);
    expect(JSON.stringify(rows)).not.toContain("coder-secret");
  });
});

describe("ticket providers in the audit trail", () => {
  it("records one added, re-enabled and removed, never its API token", async () => {
    const { ws, admin } = await org();
    const app = await as(ticketRoutes, admin, ws.id, "admin");
    const made = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: {
        source: "jira",
        config: {
          baseUrl: "https://jira.example.com",
          deployment: "server",
          authType: "pat",
          apiToken: "jira-secret-1",
          projectKey: "OPS",
        },
      },
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().provider.id as string;
    const enabled = await app.inject({
      method: "PATCH",
      url: `/api/tickets/providers/${id}/re-enable`,
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const removed = await app.inject({ method: "DELETE", url: `/api/tickets/providers/${id}` });
    expect(removed.statusCode, removed.body).toBe(204);

    const rows = await trail(ws.id, "ticket_provider.", 3);
    expect(rows.map((r) => [r.action, r.userId, r.params])).toEqual([
      ["ticket_provider.create", admin.id, { id, type: "jira", scope: "workspace" }],
      ["ticket_provider.enable", admin.id, { id, type: "jira", scope: "workspace" }],
      ["ticket_provider.delete", admin.id, { id, type: "jira", scope: "workspace" }],
    ]);
    expect(JSON.stringify(rows)).not.toContain("jira-secret");
  });

  it("names the person whose own provider an admin removes", async () => {
    const { ws, admin, bob } = await org();
    const asBob = await as(ticketRoutes, bob, ws.id, "member");
    const made = await asBob.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: {
        source: "jira",
        owner: "me",
        config: { baseUrl: "https://jira.example.com", authType: "pat", apiToken: "bob-secret" },
      },
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().provider.id as string;
    const asAdmin = await as(ticketRoutes, admin, ws.id, "admin");
    const removed = await asAdmin.inject({ method: "DELETE", url: `/api/tickets/providers/${id}` });
    expect(removed.statusCode, removed.body).toBe(204);

    const rows = await trail(ws.id, "ticket_provider.", 2);
    expect(rows.map((r) => [r.action, r.userId, r.params])).toEqual([
      // Bob's own: no one else to name.
      ["ticket_provider.create", bob.id, { id, type: "jira", scope: "user" }],
      [
        "ticket_provider.delete",
        admin.id,
        { id, type: "jira", scope: "user", targetUserId: bob.id },
      ],
    ]);
  });
});

describe("a token removed for someone else", () => {
  it("names whose personal token an admin deleted (offboarding)", async () => {
    const { ws, admin, bob } = await org();
    await storeSecret("GITLAB_TOKEN", "glpat-bob", "user", ws.id, bob.id);
    const app = await as(secretRoutes, admin, ws.id, "admin");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/secrets/GITLAB_TOKEN?scope=user&userId=${bob.id}`,
    });
    expect(res.statusCode, res.body).toBe(204);

    const [row] = await trail(ws.id, "gitlab.token.", 1);
    expect(row).toMatchObject({
      action: "gitlab.token.delete",
      userId: admin.id,
      params: { name: "GITLAB_TOKEN", scope: "user", targetUserId: bob.id },
    });
  });

  it("names no one when a person deletes their own", async () => {
    const { ws, bob } = await org();
    await storeSecret("GITLAB_TOKEN", "glpat-bob", "user", ws.id, bob.id);
    const app = await as(secretRoutes, bob, ws.id, "member");
    const res = await app.inject({ method: "DELETE", url: "/api/secrets/GITLAB_TOKEN?scope=user" });
    expect(res.statusCode, res.body).toBe(204);

    const [row] = await trail(ws.id, "gitlab.token.", 1);
    expect(row.params).toEqual({ name: "GITLAB_TOKEN", scope: "user" });
  });
});
