/**
 * The organization workspace with `autoJoinOrganization` (opt-in for every
 * provider), against real Postgres + Redis: a deployment without the setup
 * wizard's bootstrap gets a new one on its first sign-ins
 * (createOrganizationWorkspace) — people who sign in at the same moment end
 * in one organization, and its first member runs it only when they may —
 * and never has someone's existing workspace adopted. Without the setting,
 * everyone keeps a workspace of their own, as upstream. Every test starts
 * with no workspace at all, as a fresh deployment does.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { authProviderConfigs, users, workspaceMembers, workspaces } from "../db/schema.js";
import { getRedisClient } from "./event-bus.js";
import { completeSignIn, saveSignInConfig } from "./sign-in-config-service.js";

const ENV_KEYS = [
  "OIDC_ISSUER_URL",
  "OIDC_AUTO_JOIN_ORGANIZATION",
  "LDAP_URL",
  "LDAP_USER_BASE_DN",
  "LDAP_AUTO_JOIN_ORGANIZATION",
  "OPTIO_DEPLOYMENT_ADMINS",
  "OPTIO_AUTH_DISABLED",
];

/** LDAP from the environment, with the organization workspace switched on. */
function oidcWithAutoJoin() {
  process.env.OIDC_ISSUER_URL = "https://sso.example.com";

  process.env.OIDC_AUTO_JOIN_ORGANIZATION = "true";
}

async function insertUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: randomBytes(6).toString("hex"),
      email: `${name.toLowerCase()}-${randomBytes(3).toString("hex")}@acme.com`,
      emailVerified: true,
      displayName: name,
    })
    .returning();
  return row;
}

async function roleIn(workspaceId: string, userId: string) {
  const [m] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return m?.role ?? null;
}

describe("the organization workspace on first sign-ins", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    await db.delete(authProviderConfigs);
    await db.delete(workspaces);
    await db.update(users).set({ defaultWorkspaceId: null, deploymentAdmin: false });
    await getRedisClient().del("optio:sign_in_bootstrap_claim");
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("by default nobody joins one: each person keeps a workspace of their own", async () => {
    process.env.OIDC_ISSUER_URL = "https://sso.example.com";

    await saveSignInConfig(
      "oidc",
      { clientId: "id", clientSecret: "s", settings: { issuerUrl: "https://sso.example.com" } },
      null,
    );
    for (const provider of ["oidc", "github", "gitlab", "google"]) {
      const u = await insertUser(`P-${provider}`);
      expect(await completeSignIn(u, { provider, groups: ["developers"] })).toEqual({
        deploymentAdmin: false,
        bootstrapped: false,
      });
    }
    expect(await db.select().from(workspaces)).toEqual([]);
  });

  it("never adopts an existing workspace: a new one becomes the organization's", async () => {
    oidcWithAutoJoin();
    const owner = await insertUser("Owner");
    const { createWorkspace } = await import("./workspace-service.js");
    const theirs = await createWorkspace({ name: "Owner's", slug: "organization" }, owner.id);
    const newcomer = await insertUser("Newcomer");
    const r = await completeSignIn(newcomer, { provider: "oidc", groups: [] });
    expect(r.organizationWorkspaceId).toBeTruthy();
    expect(r.organizationWorkspaceId).not.toBe(theirs.id);
    const [kept] = await db.select().from(workspaces).where(eq(workspaces.id, theirs.id));
    expect(kept!.organization).toBe(false);
    expect(await roleIn(theirs.id, newcomer.id)).toBeNull();
  });

  it("lands people in the workspace a deployment admin marked", async () => {
    oidcWithAutoJoin();
    const owner = await insertUser("Marker");
    const { createWorkspace } = await import("./workspace-service.js");
    const ws = await createWorkspace(
      { name: "Acme", slug: `acme-${owner.id.slice(0, 6)}` },
      owner.id,
    );
    const { markOrganizationWorkspace } = await import("./sign-in-config-service.js");
    await markOrganizationWorkspace(ws.id);
    const kim = await insertUser("Kim");
    const r = await completeSignIn(kim, { provider: "oidc", groups: [] });
    expect(r.organizationWorkspaceId).toBe(ws.id);
    expect(await roleIn(ws.id, kim.id)).toBe("member");
  });

  it("people signing in at the same moment share one organization workspace", async () => {
    oidcWithAutoJoin();
    const people = await Promise.all(
      ["Ada", "Ben", "Cy", "Dee", "Eli"].map((name) => insertUser(name)),
    );
    const results = await Promise.all(
      people.map((u) => completeSignIn(u, { provider: "oidc", groups: [] })),
    );

    const ids = new Set(results.map((r) => r.organizationWorkspaceId));
    expect(ids.size).toBe(1);
    const [orgId] = [...ids];
    expect(orgId).toBeTruthy();
    const all = await db.select().from(workspaces);
    expect(all.map((w) => w.id)).toEqual([orgId]);
    expect(all[0]).toMatchObject({ organization: true, slug: "organization" });
    for (const u of people) {
      expect(await roleIn(orgId!, u.id)).toBeTruthy();
      const [row] = await db.select().from(users).where(eq(users.id, u.id));
      expect(row.defaultWorkspaceId).toBe(orgId);
    }
  });

  it("its first member is only a member when admin groups are set and they aren't in one", async () => {
    await saveSignInConfig(
      "oidc",
      {
        clientId: "id",
        clientSecret: "s",
        settings: {
          issuerUrl: "https://sso.example.com/realms/optio",
          adminGroups: ["platform-admins"],
          autoJoinOrganization: true,
        },
      },
      null,
    );
    const first = await insertUser("Fay");
    const a = await completeSignIn(first, { provider: "oidc", groups: ["developers"] });
    expect(a.organizationWorkspaceId).toBeTruthy();
    expect(await roleIn(a.organizationWorkspaceId!, first.id)).toBe("member");

    // An admin group's member who signs in next runs it.
    const admin = await insertUser("Gil");
    const b = await completeSignIn(admin, { provider: "oidc", groups: ["Platform-Admins"] });
    expect(b.organizationWorkspaceId).toBe(a.organizationWorkspaceId);
    expect(await roleIn(a.organizationWorkspaceId!, admin.id)).toBe("admin");
  });

  it("with no admin groups, the first ordinary person joins as a member", async () => {
    oidcWithAutoJoin();
    const first = await insertUser("Hal");
    const a = await completeSignIn(first, { provider: "oidc", groups: ["developers"] });
    expect(await roleIn(a.organizationWorkspaceId!, first.id)).toBe("member");
    expect(a.deploymentAdmin).toBe(false);
  });

  it("an ordinary first joiner's organization workspace is run by the deployment admins", async () => {
    // Environment OIDC with autoJoinOrganization and no admin groups.
    oidcWithAutoJoin();
    const root = await insertUser("Root");
    await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, root.id));
    const first = await insertUser("Hal");
    const a = await completeSignIn(first, { provider: "oidc", groups: ["developers"] });
    const orgWs = a.organizationWorkspaceId!;
    expect(await roleIn(orgWs, first.id)).toBe("member");
    expect(await roleIn(orgWs, root.id)).toBe("admin");

    // Someone made a deployment admin later runs it too, at once…
    const later = await insertUser("Later");
    await completeSignIn(later, { provider: "oidc", groups: [] });
    expect(await roleIn(orgWs, later.id)).toBe("member");
    const { addDeploymentAdminByEmail } = await import("./sign-in-config-service.js");
    await addDeploymentAdminByEmail(later.email);
    expect(await roleIn(orgWs, later.id)).toBe("admin");

    // …and so does one named by the environment, on their next sign-in.
    const envAdmin = await insertUser("Env admin");
    process.env.OPTIO_DEPLOYMENT_ADMINS = envAdmin.email;
    await completeSignIn(envAdmin, { provider: "oidc", groups: [] });
    expect(await roleIn(orgWs, envAdmin.id)).toBe("admin");
    expect(await roleIn(orgWs, first.id)).toBe("member");
  });

  it("makes none for the environment's OIDC unless OIDC_AUTO_JOIN_ORGANIZATION is on", async () => {
    process.env.OIDC_ISSUER_URL = "https://sso.example.com/realms/optio";
    const ivy = await insertUser("Ivy");
    expect(await completeSignIn(ivy, { provider: "oidc", groups: [] })).toEqual({
      deploymentAdmin: false,
      bootstrapped: false,
    });
    expect(await db.select().from(workspaces)).toEqual([]);

    process.env.OIDC_AUTO_JOIN_ORGANIZATION = "true";
    const jo = await insertUser("Jo");
    const joined = await completeSignIn(jo, { provider: "oidc", groups: [] });
    expect(joined.organizationWorkspaceId).toBeTruthy();
  });
});
