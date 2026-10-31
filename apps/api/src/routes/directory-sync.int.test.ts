/**
 * Settings → Access → Directory sync's API (routes/directory-sync.ts)
 * and the sign-in side of a disabled account, against real Postgres and
 * Redis and an in-memory directory behind the real LDAP code: only
 * deployment admins read or change it; the settings' bounds; "Run now"
 * (and 409 while another run holds the lock); "Disable and sign out
 * everywhere" and "Enable"; the paused automations named only to a
 * workspace admin of theirs; and the LDAP password form refusing a disabled
 * account with a clear message — or letting someone the sync disabled back
 * in once the directory does.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FakeDirectory } from "../test-utils/fake-ldap.js";

const h = vi.hoisted(() => ({ dir: null as FakeDirectory | null }));
vi.mock("ldapts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ldapts")>();
  const { fakeLdapClient } = await import("../test-utils/fake-ldap.js");
  return { ...actual, Client: fakeLdapClient(() => h.dir!) };
});

import * as ldapts from "ldapts";
import { FakeDirectory as Directory } from "../test-utils/fake-ldap.js";
import { db } from "../db/client.js";
import { users, workspaceMembers } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import {
  insertWorkflow,
  insertWorkflowTrigger,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { createApiKey, validateApiKey } from "../services/api-key-service.js";
import { acquireLease, releaseLease } from "../services/lease-service.js";
import { ACCOUNT_DISABLED_MESSAGE } from "../services/offboarding.js";
import { authRoutes } from "./auth.js";
import { directorySyncRoutes } from "./directory-sync.js";

const uniq = () => randomBytes(4).toString("hex");
const SVC = "cn=optio-svc,ou=service,dc=corp,dc=test";
const PEOPLE = "ou=people,dc=corp,dc=test";
const USERS_GROUP = "cn=optio-users,ou=groups,dc=corp,dc=test";

let orgId: string;
let otherWsId: string;
let operator: typeof users.$inferSelect; // deployment admin, admin of the org workspace
let outsiderOp: typeof users.$inferSelect; // deployment admin in another workspace only
let member: typeof users.$inferSelect;
const apps: FastifyInstance[] = [];

async function person(name: string, opts: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `${name}-${uniq()}@example.test`,
      displayName: name,
      ...opts,
    })
    .returning();
  return row!;
}

async function ldapPerson(uid: string, password = "pw-" + uid) {
  const name = `${uid}-${uniq()}`;
  const dn = `uid=${name},${PEOPLE}`;
  const entryUUID = randomUUID();
  h.dir!.addUser(
    dn,
    { uid: name, mail: `${name}@example.test`, displayName: name, entryUUID },
    password,
  );
  h.dir!.addToGroup(USERS_GROUP, dn);
  const user = await person(name, {
    provider: "ldap",
    externalId: entryUUID,
    username: name,
    email: `${name}@example.test`,
  });
  await db.insert(workspaceMembers).values({ workspaceId: orgId, userId: user.id, role: "member" });
  return { user, dn, name, password };
}

async function appAs(user: typeof users.$inferSelect | null, workspaceId = orgId) {
  const app = await buildRouteTestApp(
    async (a) => {
      await directorySyncRoutes(a);
      await authRoutes(a);
    },
    { user: user ? { id: user.id, workspaceId, workspaceRole: "admin" } : null },
  );
  apps.push(app);
  return app;
}

beforeAll(async () => {
  h.dir = new Directory({ serviceDn: SVC, servicePassword: "svc-pw" }, ldapts);

  orgId = (await insertWorkspace({ name: "Org", organization: true })).id;
  otherWsId = (await insertWorkspace({ name: "Elsewhere" })).id;
  operator = await person("operator", { deploymentAdmin: true });
  outsiderOp = await person("outsider-op", { deploymentAdmin: true });
  member = await person("member");
  await db.insert(workspaceMembers).values([
    { workspaceId: orgId, userId: operator.id, role: "admin" },
    { workspaceId: orgId, userId: member.id, role: "member" },
    { workspaceId: otherWsId, userId: outsiderOp.id, role: "admin" },
  ]);
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

beforeEach(() => {
  vi.stubEnv("LDAP_URL", "ldaps://ldap.example.test:636");
  vi.stubEnv("LDAP_BIND_DN", SVC);
  vi.stubEnv("LDAP_BIND_PASSWORD", "svc-pw");
  vi.stubEnv("LDAP_USER_BASE_DN", PEOPLE);
  vi.stubEnv("LDAP_REQUIRED_GROUPS", "optio-users");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "optio@example.test");
});

describe("who may", () => {
  it("is deployment admins only, a workspace admin included", async () => {
    const asMember = await appAs(member);
    for (const [method, url] of [
      ["GET", "/api/admin/directory-sync"],
      ["PUT", "/api/admin/directory-sync"],
      ["POST", "/api/admin/directory-sync/run"],
      ["POST", "/api/admin/users/disable"],
      ["POST", `/api/admin/users/${randomUUID()}/enable`],
    ] as const) {
      const res = await asMember.inject({
        method,
        url,
        payload: method === "GET" ? undefined : url.endsWith("disable") ? { email: "x@y" } : {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const wsAdmin = await person("ws-admin");
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: orgId, userId: wsAdmin.id, role: "admin" });
    expect((await (await appAs(wsAdmin)).inject("/api/admin/directory-sync")).statusCode).toBe(403);

    // The 403 stops the handler: the person stays enabled (deployment-admin-gates.ts).
    const target = await person("not-disabled");
    const refused = await (
      await appAs(wsAdmin)
    ).inject({
      method: "POST",
      url: "/api/admin/users/disable",
      payload: { userId: target.id },
    });
    expect(refused.statusCode).toBe(403);
    await new Promise((r) => setTimeout(r, 300));
    const [after] = await db.select().from(users).where(eq(users.id, target.id));
    expect(after.disabledAt).toBeNull();
  });
});

describe("settings and Run now", () => {
  it("shows the settings, saves them within bounds, and runs", async () => {
    const app = await appAs(operator);
    const view = (await app.inject("/api/admin/directory-sync")).json();
    expect(view).toMatchObject({
      ldapConfigured: true,
      note: null,
      settings: { enabled: false, intervalMinutes: 30, source: { enabled: "environment" } },
    });

    const tooOften = await app.inject({
      method: "PUT",
      url: "/api/admin/directory-sync",
      payload: { enabled: true, intervalMinutes: 5 },
    });
    expect(tooOften.statusCode).toBe(400);
    const saved = await app.inject({
      method: "PUT",
      url: "/api/admin/directory-sync",
      payload: { enabled: true, intervalMinutes: 60 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings).toMatchObject({
      enabled: true,
      intervalMinutes: 60,
      source: { enabled: "app", intervalMinutes: "app" },
    });
    const back = await app.inject({
      method: "PUT",
      url: "/api/admin/directory-sync",
      payload: { enabled: null, intervalMinutes: null },
    });
    expect(back.json().settings.source).toEqual({
      enabled: "environment",
      intervalMinutes: "environment",
    });

    const p = await ldapPerson("rina");
    const ran = await app.inject({ method: "POST", url: "/api/admin/directory-sync/run" });
    expect(ran.statusCode, ran.body).toBe(200);
    expect(ran.json()).toMatchObject({ trigger: "manual", status: "ok", startedBy: operator.id });
    expect(ran.json().checked).toBeGreaterThanOrEqual(1);
    expect((await app.inject("/api/admin/directory-sync")).json().lastRun.id).toBe(ran.json().id);
    void p;
  });

  it("answers 409 while another instance runs it", async () => {
    const app = await appAs(operator);
    expect(await acquireLease("directory-sync", 60_000, "another-instance")).toBe(true);
    try {
      const res = await app.inject({ method: "POST", url: "/api/admin/directory-sync/run" });
      expect(res.statusCode).toBe(409);
      expect((await app.inject("/api/admin/directory-sync")).json().running).toBe(true);
    } finally {
      await releaseLease("directory-sync", "another-instance");
    }
  });

  it("says the sync needs LDAP on a deployment with OpenID Connect only", async () => {
    vi.stubEnv("LDAP_URL", "");
    const app = await appAs(operator);
    const view = (await app.inject("/api/admin/directory-sync")).json();
    expect(view.ldapConfigured).toBe(false);
    expect(view.note).toMatch(/OpenID Connect/);
    const res = await app.inject({ method: "POST", url: "/api/admin/directory-sync/run" });
    expect(res.statusCode).toBe(400);
  });
});

describe("Disable and sign out everywhere", () => {
  it("disables by email, revokes keys, pauses automations, and names them only to their workspace's admins", async () => {
    const p = await ldapPerson("sam");
    const key = await createApiKey(p.user.id, "CLI");
    const job = await insertWorkflow({
      name: `sam's nightly ${uniq()}`,
      workspaceId: orgId,
      ownerUserId: p.user.id,
    });
    await insertWorkflowTrigger(job.id, { type: "schedule", config: { cron: "0 1 * * *" } });

    const app = await appAs(operator);
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users/disable",
      payload: { email: p.user.email.toUpperCase() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ disabled: true, revokedApiKeys: 1, paused: 1 });
    expect(await validateApiKey(key.token)).toBeNull();
    const [row] = await db.select().from(users).where(eq(users.id, p.user.id));
    expect(row).toMatchObject({ disabledReason: "admin", disabledBy: operator.id });

    const again = await app.inject({
      method: "POST",
      url: "/api/admin/users/disable",
      payload: { userId: p.user.id },
    });
    expect(again.statusCode).toBe(409);

    // The org workspace's admin sees the automation; a deployment admin of another workspace doesn't.
    const seen = (await app.inject("/api/admin/directory-sync"))
      .json()
      .disabledPeople.find((d: { id: string }) => d.id === p.user.id);
    expect(seen).toMatchObject({ byHand: true, pausedHidden: 0 });
    expect(seen.paused).toEqual([
      expect.objectContaining({ name: job.name, path: `/jobs/${job.id}` }),
    ]);
    const fromOutside = (
      await (await appAs(outsiderOp, otherWsId)).inject("/api/admin/directory-sync")
    )
      .json()
      .disabledPeople.find((d: { id: string }) => d.id === p.user.id);
    expect(fromOutside).toMatchObject({ paused: [], pausedHidden: 1 });

    // The directory sync doesn't undo an admin's hand.
    const ran = await app.inject({ method: "POST", url: "/api/admin/directory-sync/run" });
    expect(ran.statusCode).toBe(200);
    expect(
      (await db.select().from(users).where(eq(users.id, p.user.id)))[0]!.disabledAt,
    ).not.toBeNull();

    const enabled = await app.inject({
      method: "POST",
      url: `/api/admin/users/${p.user.id}/enable`,
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ disabled: false, resumed: 1 });
    const missing = await app.inject({
      method: "POST",
      url: `/api/admin/users/${p.user.id}/enable`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses the caller's own account and someone unknown", async () => {
    const app = await appAs(operator);
    const self = await app.inject({
      method: "POST",
      url: "/api/admin/users/disable",
      payload: { userId: operator.id },
    });
    expect(self.statusCode).toBe(400);
    const nobody = await app.inject({
      method: "POST",
      url: "/api/admin/users/disable",
      payload: { email: "nobody@example.test" },
    });
    expect(nobody.statusCode).toBe(404);
    const both = await app.inject({
      method: "POST",
      url: "/api/admin/users/disable",
      payload: { email: "a@b.c", userId: operator.id },
    });
    expect(both.statusCode).toBe(400);
  });
});

describe("signing in with the directory", () => {
  it("refuses a disabled account with a clear message", async () => {
    const p = await ldapPerson("tom");
    await (
      await appAs(operator)
    ).inject({
      method: "POST",
      url: "/api/admin/users/disable",
      payload: { userId: p.user.id },
    });
    const anon = await appAs(null);
    const res = await anon.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      payload: { username: p.name, password: p.password, cli: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(ACCOUNT_DISABLED_MESSAGE);
  });

  it("lets someone the sync disabled back in once the directory does", async () => {
    const p = await ldapPerson("uma");
    const admin = await appAs(operator);
    h.dir!.removeFromGroup(USERS_GROUP, p.dn);
    await admin.inject({ method: "POST", url: "/api/admin/directory-sync/run" });
    const [off] = await db.select().from(users).where(eq(users.id, p.user.id));
    expect(off!.disabledReason).toBe("not_in_required_group");

    const anon = await appAs(null);
    const refused = await anon.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      payload: { username: p.name, password: p.password, cli: true },
    });
    // Still outside the required group: the group rule says so first.
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/group allowed to use Optio/);

    h.dir!.addToGroup(USERS_GROUP, p.dn);
    const back = await anon.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      payload: { username: p.name, password: p.password, cli: true },
    });
    expect(back.statusCode).toBe(200);
    expect(await validateApiKey(back.json().token)).toMatchObject({ id: p.user.id });
    const [on] = await db.select().from(users).where(eq(users.id, p.user.id));
    expect(on!.disabledAt).toBeNull();
  });
});
