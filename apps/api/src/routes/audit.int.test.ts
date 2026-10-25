/**
 * The Audit page's API (docs/audit.md) against real Postgres: who may read
 * it (workspace admins their workspace, deployment admins everything,
 * members and viewers nothing — list, export and settings alike), the
 * filters (person, team, action, time, outcome), the three export formats,
 * the retention setting, the members' Activity feed leaving the
 * admin-only actions out, and the deployment-wide entries (refused
 * sign-ins, sign-in settings) staying with deployment admins in the
 * Activity feed and the action list.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import {
  auditSettings,
  optioActions,
  teamMembers,
  teams,
  users,
  workspaceMembers,
} from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { getRedisClient } from "../services/event-bus.js";
import { activityRoutes } from "./activity.js";
import { auditRoutes } from "./audit.js";
import { optioRoutes } from "./optio.js";

const uniq = () => randomBytes(4).toString("hex");
const DAY = 86_400_000;

async function person(name: string, deploymentAdmin = false) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `${name}-${uniq()}@example.test`,
      displayName: name,
      deploymentAdmin,
    })
    .returning();
  return row;
}

/** Two workspaces, their people, a team, and entries of every kind. */
async function seed() {
  const ws = await insertWorkspace({ name: "Org" });
  const other = await insertWorkspace({ name: "Other" });
  const admin = await person("admin");
  const member = await person("member");
  const viewer = await person("viewer");
  const outsider = await person("outsider");
  const operator = await person("operator", true);
  const otherAdmin = await person("other-admin");
  await db.insert(workspaceMembers).values([
    { workspaceId: ws.id, userId: admin.id, role: "admin" },
    { workspaceId: ws.id, userId: member.id, role: "member" },
    { workspaceId: ws.id, userId: viewer.id, role: "viewer" },
    { workspaceId: ws.id, userId: outsider.id, role: "member" },
    // A deployment admin needn't be a workspace admin to read everything.
    { workspaceId: ws.id, userId: operator.id, role: "member" },
    { workspaceId: other.id, userId: otherAdmin.id, role: "admin" },
  ]);
  const [team] = await db
    .insert(teams)
    .values({ workspaceId: ws.id, name: `Platform ${uniq()}`, slug: `platform-${uniq()}` })
    .returning();
  await db.insert(teamMembers).values({ teamId: team.id, userId: member.id, status: "active" });

  const now = Date.now();
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY);
  const rows = await db
    .insert(optioActions)
    .values([
      {
        workspaceId: ws.id,
        userId: member.id,
        action: "auth.sign_in",
        params: { provider: "ldap", via: "cli" },
        success: true,
        clientIp: "10.0.0.1",
        createdAt: at(2),
      },
      {
        workspaceId: ws.id,
        userId: admin.id,
        action: "team.join.approve",
        params: { teamId: team.id, targetUserId: member.id },
        success: true,
        createdAt: at(1),
      },
      {
        workspaceId: ws.id,
        userId: admin.id,
        action: "pr.merge",
        params: { via: "button", prUrl: "https://gitlab.example.test/p/r/-/merge_requests/3" },
        success: false,
        createdAt: at(0),
      },
      {
        workspaceId: ws.id,
        userId: outsider.id,
        action: "secret.upsert",
        // Written before write-time filtering: the read must still drop it.
        params: { name: "X", scope: "user", value: "must-not-leak" },
        success: true,
        createdAt: at(10),
      },
      {
        workspaceId: other.id,
        userId: otherAdmin.id,
        action: "auth.sign_in",
        params: { provider: "oidc", via: "web" },
        success: true,
        createdAt: at(0),
      },
      {
        workspaceId: null,
        userId: null,
        action: "auth.sign_in.failure",
        params: { provider: "ldap", reason: "invalid_credentials", username: "mallory" },
        success: false,
        createdAt: at(0),
      },
    ])
    .returning();
  const [signIn, approve, merge, legacy, otherSignIn, refused] = rows;
  return {
    ws,
    other,
    team,
    people: { admin, member, viewer, outsider, operator, otherAdmin },
    rows: { signIn, approve, merge, legacy, otherSignIn, refused },
  };
}

type Seed = Awaited<ReturnType<typeof seed>>;

const apps: FastifyInstance[] = [];
async function as(
  user: { id: string },
  workspaceId: string,
  role: "admin" | "member" | "viewer",
  routes = auditRoutes,
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

/** The ids a list answer holds, limited to this test's seed. */
function idsOf(body: { items: { id: string }[] }, s: Seed): string[] {
  const mine = new Set(Object.values(s.rows).map((r) => r.id));
  return body.items.map((i) => i.id).filter((id) => mine.has(id));
}

const list = async (app: FastifyInstance, qs = "") => {
  const res = await app.inject({ method: "GET", url: `/api/audit?limit=500${qs}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    items: { id: string; action: string; details: Record<string, unknown>; actor: unknown }[];
    total: number;
    scope: string;
  };
};

describe("who may read the audit trail", () => {
  it("refuses members and viewers everywhere: list, both exports, settings", async () => {
    const s = await seed();
    for (const [user, role] of [
      [s.people.member, "member"],
      [s.people.viewer, "viewer"],
    ] as const) {
      const app = await as(user, s.ws.id, role);
      for (const url of [
        "/api/audit",
        "/api/audit/export?format=csv",
        "/api/activity/export?format=jsonl",
        "/api/audit/settings",
      ]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, `${role} ${url}`).toBe(403);
        expect(res.json().error).toBe("Only workspace admins can read the audit trail");
      }
      const put = await app.inject({
        method: "PUT",
        url: "/api/audit/settings",
        payload: { retentionDays: 1 },
      });
      expect(put.statusCode).toBe(403);
    }
  });

  it("gives a workspace admin their workspace's entries only, whatever they ask", async () => {
    const s = await seed();
    const app = await as(s.people.admin, s.ws.id, "admin");
    const body = await list(app, "&workspace=all");
    expect(body.scope).toBe("workspace");
    expect(idsOf(body, s).sort()).toEqual(
      [s.rows.signIn.id, s.rows.approve.id, s.rows.merge.id, s.rows.legacy.id].sort(),
    );
  });

  it("gives a deployment admin every workspace and the deployment-wide entries", async () => {
    const s = await seed();
    const app = await as(s.people.operator, s.ws.id, "member");
    const all = await list(app);
    expect(all.scope).toBe("all");
    expect(idsOf(all, s)).toEqual(
      expect.arrayContaining([s.rows.otherSignIn.id, s.rows.refused.id, s.rows.signIn.id]),
    );
    const current = await list(app, "&workspace=current");
    expect(idsOf(current, s)).not.toContain(s.rows.otherSignIn.id);
    expect(idsOf(current, s)).not.toContain(s.rows.refused.id);
    const picked = await list(app, `&workspace=${s.other.id}`);
    expect(idsOf(picked, s)).toEqual([s.rows.otherSignIn.id]);
  });
});

describe("filters", () => {
  it("by person: what they did and what named them", async () => {
    const s = await seed();
    const app = await as(s.people.admin, s.ws.id, "admin");
    const body = await list(app, `&userId=${s.people.member.id}`);
    expect(idsOf(body, s).sort()).toEqual([s.rows.signIn.id, s.rows.approve.id].sort());
  });

  it("by team: its members' entries and entries naming it", async () => {
    const s = await seed();
    const app = await as(s.people.admin, s.ws.id, "admin");
    const body = await list(app, `&teamId=${s.team.id}`);
    expect(idsOf(body, s).sort()).toEqual([s.rows.signIn.id, s.rows.approve.id].sort());
  });

  it("by action names and prefixes, by time and by outcome", async () => {
    const s = await seed();
    const app = await as(s.people.admin, s.ws.id, "admin");
    expect(idsOf(await list(app, "&action=auth"), s)).toEqual([s.rows.signIn.id]);
    expect(idsOf(await list(app, "&action=team.join,pr.merge"), s)).toEqual([
      s.rows.merge.id,
      s.rows.approve.id,
    ]);
    // A segment prefix only: `team.jo` names nothing.
    expect(idsOf(await list(app, "&action=team.jo"), s)).toEqual([]);
    expect(idsOf(await list(app, "&outcome=failure"), s)).toEqual([s.rows.merge.id]);
    const from = new Date(Date.now() - 3 * DAY).toISOString();
    const to = new Date(Date.now() - 0.5 * DAY).toISOString();
    expect(
      idsOf(await list(app, `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`), s),
    ).toEqual([s.rows.approve.id, s.rows.signIn.id]);
  });

  it("refuses a time it can't read", async () => {
    const s = await seed();
    const app = await as(s.people.admin, s.ws.id, "admin");
    const res = await app.inject({ method: "GET", url: "/api/audit?from=yesterday" });
    expect(res.statusCode).toBe(400);
  });

  it("never shows a stored detail off the allowlist", async () => {
    const s = await seed();
    const app = await as(s.people.admin, s.ws.id, "admin");
    const body = await list(app, "&action=secret");
    const legacy = body.items.find((i) => i.id === s.rows.legacy.id)!;
    expect(legacy.details).toEqual({ name: "X", scope: "user" });
  });
});

describe("export", () => {
  const only = "action=auth,team,pr,secret";

  it("CSV: a header and a line per entry, as a download", async () => {
    const s = await seed();
    const app = await as(s.people.admin, s.ws.id, "admin");
    const res = await app.inject({ method: "GET", url: `/api/audit/export?format=csv&${only}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="optio-audit-.*\.csv"$/,
    );
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toBe(
      "time,workspace_id,workspace,actor_id,actor_email,actor_name,action,label,success,client_ip,details",
    );
    expect(lines).toHaveLength(5);
    expect(res.body).toContain("10.0.0.1");
    expect(res.body).not.toContain("must-not-leak");
  });

  it("JSON lines (also at /api/activity/export) and a JSON array", async () => {
    const s = await seed();
    const app = await as(s.people.admin, s.ws.id, "admin");
    const jsonl = await app.inject({
      method: "GET",
      url: `/api/activity/export?format=jsonl&${only}`,
    });
    expect(jsonl.statusCode).toBe(200);
    expect(jsonl.headers["content-type"]).toContain("application/x-ndjson");
    const entries = jsonl.body
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries.map((e) => e.action)).toEqual([
      "pr.merge",
      "team.join.approve",
      "auth.sign_in",
      "secret.upsert",
    ]);
    expect(entries[2]).toMatchObject({
      actor: { id: s.people.member.id, name: "member" },
      clientIp: "10.0.0.1",
      label: "Signed in",
      details: { provider: "ldap", via: "cli" },
    });

    const json = await app.inject({ method: "GET", url: `/api/audit/export?format=json&${only}` });
    expect(json.statusCode).toBe(200);
    expect((JSON.parse(json.body) as unknown[]).length).toBe(4);
  });

  it("pages through more entries than one batch, newest first, none twice", async () => {
    const s = await seed();
    const stamp = new Date();
    // 1,205 entries in the same instant: the keyset must still read each once.
    await db.execute(
      sql`
        INSERT INTO optio_actions (workspace_id, user_id, action, success, created_at)
        SELECT ${s.ws.id}::uuid, ${s.people.admin.id}::uuid, 'work.create', true, ${stamp.toISOString()}::timestamptz
        FROM generate_series(1, 1205)`,
    );
    const app = await as(s.people.admin, s.ws.id, "admin");
    const res = await app.inject({
      method: "GET",
      url: "/api/audit/export?format=jsonl&action=work.create",
    });
    const ids = res.body
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).id as string);
    expect(ids).toHaveLength(1205);
    expect(new Set(ids).size).toBe(1205);
  });

  it("records who exported", async () => {
    const s = await seed();
    const app = await as(s.people.admin, s.ws.id, "admin");
    await app.inject({ method: "GET", url: "/api/audit/export?format=csv" });
    let row;
    for (let i = 0; i < 20 && !row; i++) {
      [row] = await db
        .select()
        .from(optioActions)
        .where(
          and(eq(optioActions.action, "audit.export"), eq(optioActions.userId, s.people.admin.id)),
        );
      if (!row) await new Promise((r) => setTimeout(r, 50));
    }
    expect(row).toMatchObject({
      workspaceId: s.ws.id,
      params: { kind: "csv", scope: "workspace" },
    });
  });

  it("records a deployment admin's export of every workspace as deployment-wide", async () => {
    const s = await seed();
    const app = await as(s.people.operator, s.ws.id, "member");
    await app.inject({ method: "GET", url: "/api/audit/export?format=jsonl" });
    await app.inject({ method: "GET", url: "/api/audit/export?format=csv&workspace=current" });
    const rows = await entriesBy(s.people.operator.id, "audit.export", 2);
    expect(rows.map((r) => [r.workspaceId, (r.params as { kind: string }).kind]).sort()).toEqual(
      [
        [null, "jsonl"],
        [s.ws.id, "csv"],
      ].sort(),
    );
  });
});

/** `action` entries by `userId`, waiting for the ones written without waiting. */
async function entriesBy(userId: string, action: string, expected: number) {
  let rows: (typeof optioActions.$inferSelect)[] = [];
  for (let i = 0; i < 40 && rows.length < expected; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 50));
    rows = await db
      .select()
      .from(optioActions)
      .where(and(eq(optioActions.action, action), eq(optioActions.userId, userId)));
  }
  return rows;
}

describe("retention setting", () => {
  it("workspace admins read it; only a deployment admin changes it", async () => {
    const s = await seed();
    await db.delete(auditSettings);
    const admin = await as(s.people.admin, s.ws.id, "admin");
    const read = await admin.inject({ method: "GET", url: "/api/audit/settings" });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      retention: { days: 365, source: "default" },
      stdout: false,
      canChange: false,
    });
    const refused = await admin.inject({
      method: "PUT",
      url: "/api/audit/settings",
      payload: { retentionDays: 30 },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe(
      "Only a deployment admin can change how long the audit trail is kept",
    );

    const operator = await as(s.people.operator, s.ws.id, "member");
    const set = await operator.inject({
      method: "PUT",
      url: "/api/audit/settings",
      payload: { retentionDays: 30 },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({
      retention: { days: 30, source: "app", updatedBy: s.people.operator.id },
      canChange: true,
    });
    const bad = await operator.inject({
      method: "PUT",
      url: "/api/audit/settings",
      payload: { retentionDays: 0 },
    });
    expect(bad.statusCode).toBe(400);
    const cleared = await operator.inject({
      method: "PUT",
      url: "/api/audit/settings",
      payload: { retentionDays: null },
    });
    expect(cleared.json().retention).toMatchObject({ days: 365, source: "default" });
    // Retention is the deployment's: its entries have no workspace.
    const changes = await entriesBy(s.people.operator.id, "audit.settings", 2);
    expect(changes.map((r) => r.workspaceId)).toEqual([null, null]);
  });
});

describe("the members' Activity feed", () => {
  it("leaves sign-ins, keys and tokens out for members; admins still see them", async () => {
    const s = await seed();
    const member = await as(s.people.member, s.ws.id, "member", activityRoutes);
    const seen = await member.inject({ method: "GET", url: "/api/activity?days=30&type=action" });
    expect(seen.statusCode).toBe(200);
    const actions = (seen.json().items as { id: string; action: string }[]).map((i) => i.action);
    expect(actions).not.toContain("auth.sign_in");
    expect(actions).toContain("team.join.approve");

    // Merges name merge requests and runs a member may not see (work visibility).
    expect(actions).not.toContain("pr.merge");

    const admin = await as(s.people.admin, s.ws.id, "admin", activityRoutes);
    const all = await admin.inject({ method: "GET", url: "/api/activity?days=30&type=action" });
    expect((all.json().items as { action: string }[]).map((i) => i.action)).toEqual(
      expect.arrayContaining(["auth.sign_in", "pr.merge"]),
    );
  });
});

describe("deployment-wide entries stay with deployment admins", () => {
  /** A refused sign-in, a sign-in setting and a legacy row, all without a workspace, newest of all. */
  async function wide(s: Seed) {
    const soon = new Date(Date.now() + 60_000);
    const [refused, adminAdded, legacy] = await db
      .insert(optioActions)
      .values([
        {
          workspaceId: null,
          userId: null,
          action: "auth.sign_in.failure",
          // What someone typed in the user name field (a password, by mistake).
          params: { provider: "ldap", reason: "invalid_credentials", username: "hunter2-typed" },
          success: false,
          createdAt: soon,
        },
        {
          workspaceId: null,
          userId: s.people.operator.id,
          action: "sign_in.deployment_admin_added",
          params: { email: "new-admin@example.test" },
          success: true,
          createdAt: soon,
        },
        {
          workspaceId: null,
          userId: s.people.admin.id,
          action: "workflow.create",
          params: { name: "legacy" },
          success: true,
          createdAt: soon,
        },
      ])
      .returning();
    return { refused, adminAdded, legacy };
  }

  const feedIds = async (app: FastifyInstance) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/activity?days=30&type=action&limit=200",
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().items as { id: string }[]).map((i) => i.id);
  };
  const listIds = async (app: FastifyInstance) => {
    const res = await app.inject({ method: "GET", url: "/api/optio/actions?limit=500" });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().actions as { id: string }[]).map((a) => a.id);
  };

  it("leaves them out of a workspace admin's Activity feed; a deployment admin sees them", async () => {
    const s = await seed();
    const w = await wide(s);
    const wsAdmin = await feedIds(await as(s.people.admin, s.ws.id, "admin", activityRoutes));
    expect(wsAdmin).not.toContain(w.refused.id);
    expect(wsAdmin).not.toContain(w.adminAdded.id);
    // Upstream's rule for other rows without a workspace stays.
    expect(wsAdmin).toContain(w.legacy.id);
    expect(wsAdmin).toContain(s.rows.signIn.id);

    const deployment = await feedIds(await as(s.people.operator, s.ws.id, "admin", activityRoutes));
    expect(deployment).toEqual(expect.arrayContaining([w.refused.id, w.adminAdded.id]));
  });

  it("holds the action list (GET /api/optio/actions) to the same rule", async () => {
    const s = await seed();
    const w = await wide(s);

    const member = await listIds(await as(s.people.member, s.ws.id, "member", optioRoutes));
    expect(member).toContain(s.rows.approve.id);
    for (const hidden of [
      s.rows.signIn.id, // a sign-in: admins only
      s.rows.merge.id, // a merge: admins only
      s.rows.otherSignIn.id, // another workspace
      w.refused.id,
      w.legacy.id,
    ]) {
      expect(member).not.toContain(hidden);
    }

    const wsAdmin = await listIds(await as(s.people.admin, s.ws.id, "admin", optioRoutes));
    expect(wsAdmin).toEqual(
      expect.arrayContaining([s.rows.signIn.id, s.rows.merge.id, w.legacy.id]),
    );
    expect(wsAdmin).not.toContain(w.refused.id);
    expect(wsAdmin).not.toContain(w.adminAdded.id);
    expect(wsAdmin).not.toContain(s.rows.otherSignIn.id);

    const deployment = await listIds(await as(s.people.operator, s.ws.id, "admin", optioRoutes));
    expect(deployment).toEqual(expect.arrayContaining([w.refused.id, w.adminAdded.id]));
  });
});
