/**
 * `ensureUserHasWorkspace` against real Postgres: concurrent first requests
 * for a brand-new user (the web app fires several authenticated calls at
 * once, each through the auth hook's fallback) must create exactly one
 * "Default" workspace, also when the sign-in bootstrap claim races them.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { authProviderConfigs, users, workspaceMembers, workspaces } from "../db/schema.js";
import { getRedisClient } from "./event-bus.js";
import {
  completeSignIn,
  recordBootstrapClaim,
  saveSignInConfig,
} from "./sign-in-config-service.js";
import { ensureUserHasWorkspace } from "./workspace-service.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";

async function insertUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "google",
      externalId: randomBytes(6).toString("hex"),
      email: `${name.toLowerCase()}-${randomBytes(3).toString("hex")}@acme.com`,
      emailVerified: true,
      displayName: name,
    })
    .returning();
  return row;
}

async function workspacesCreatedBy(userId: string) {
  return db.select().from(workspaces).where(eq(workspaces.createdBy, userId));
}

async function membershipsOf(userId: string) {
  return db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, userId));
}

async function defaultOf(userId: string) {
  const [row] = await db
    .select({ id: users.defaultWorkspaceId })
    .from(users)
    .where(eq(users.id, userId));
  return row?.id ?? null;
}

describe("ensureUserHasWorkspace", () => {
  const savedAdmins = process.env.OPTIO_DEPLOYMENT_ADMINS;
  beforeEach(async () => {
    delete process.env.OPTIO_DEPLOYMENT_ADMINS;
    await db.delete(authProviderConfigs);
    await db.update(users).set({ deploymentAdmin: false });
    await getRedisClient().del("optio:sign_in_bootstrap_claim");
  });
  afterEach(() => {
    if (savedAdmins === undefined) delete process.env.OPTIO_DEPLOYMENT_ADMINS;
    else process.env.OPTIO_DEPLOYMENT_ADMINS = savedAdmins;
  });

  it("creates exactly one Default workspace when five first requests race", async () => {
    // Several users, so a lucky interleaving can't hide the race.
    for (let round = 0; round < 3; round++) {
      const user = await insertUser(`Racer${round}`);
      const ids = await Promise.all(
        Array.from({ length: 5 }, () => ensureUserHasWorkspace(user.id)),
      );

      const created = await workspacesCreatedBy(user.id);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ name: "Default", slug: `ws-${user.id.slice(0, 8)}` });
      expect(new Set(ids)).toEqual(new Set([created[0].id]));
      expect(await membershipsOf(user.id)).toHaveLength(1);
      expect(await defaultOf(user.id)).toBe(created[0].id);
    }
  });

  it("creates one workspace when the sign-in bootstrap claim races request-time calls", async () => {
    await saveSignInConfig(
      "google",
      { clientId: "id", clientSecret: "s", allowedDomains: ["acme.com"] },
      null,
    );
    await recordBootstrapClaim({
      provider: "google",
      organizationName: "Acme Corp",
      domains: ["acme.com"],
    });
    const alice = await insertUser("Alice");

    const [bootstrap, ...ids] = await Promise.all([
      completeSignIn(alice),
      ensureUserHasWorkspace(alice.id),
      ensureUserHasWorkspace(alice.id),
      ensureUserHasWorkspace(alice.id),
      ensureUserHasWorkspace(alice.id),
    ]);
    expect(bootstrap).toEqual({ deploymentAdmin: true, bootstrapped: true });

    const created = await workspacesCreatedBy(alice.id);
    expect(created).toHaveLength(1);
    expect(new Set(ids)).toEqual(new Set([created[0].id]));
    // The bootstrap turned that one workspace into the organization's.
    expect(created[0]).toMatchObject({
      name: "Acme Corp",
      slug: "acme-corp",
      autoJoinDomains: ["acme.com"],
    });
    expect(await membershipsOf(alice.id)).toHaveLength(1);
    expect(await defaultOf(alice.id)).toBe(created[0].id);
  });

  it("gives a user with no workspace one Default workspace they administer", async () => {
    const user = await insertUser("Solo");
    const id = await ensureUserHasWorkspace(user.id);
    const created = await workspacesCreatedBy(user.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ id, name: "Default", description: "Default workspace" });
    expect(await membershipsOf(user.id)).toEqual([
      expect.objectContaining({ workspaceId: id, role: "admin" }),
    ]);
    expect(await defaultOf(user.id)).toBe(id);
    // A second call returns the same workspace and creates nothing.
    expect(await ensureUserHasWorkspace(user.id)).toBe(id);
    expect(await workspacesCreatedBy(user.id)).toHaveLength(1);
  });

  it("returns an existing membership and saves it as the default", async () => {
    const user = await insertUser("Member");
    const ws = await insertWorkspace();
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: user.id, role: "member" });
    expect(await defaultOf(user.id)).toBeNull();

    expect(await ensureUserHasWorkspace(user.id)).toBe(ws.id);
    expect(await defaultOf(user.id)).toBe(ws.id);
    expect(await workspacesCreatedBy(user.id)).toHaveLength(0);
  });

  it("replaces a stale default with an existing membership", async () => {
    const user = await insertUser("Stale");
    const gone = await insertWorkspace();
    const kept = await insertWorkspace();
    await db.update(users).set({ defaultWorkspaceId: gone.id }).where(eq(users.id, user.id));
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: kept.id, userId: user.id, role: "member" });

    expect(await ensureUserHasWorkspace(user.id)).toBe(kept.id);
    expect(await defaultOf(user.id)).toBe(kept.id);
  });

  it("returns null for an unknown user", async () => {
    expect(await ensureUserHasWorkspace("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
