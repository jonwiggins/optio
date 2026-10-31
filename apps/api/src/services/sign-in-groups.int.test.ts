import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { authProviderConfigs, users, workspaceMembers, workspaces } from "../db/schema.js";
import { qualifyGroups } from "./identity-groups.js";
import { getRedisClient } from "./event-bus.js";
import {
  addDeploymentAdminByEmail,
  completeSignIn,
  isDeploymentAdmin,
  saveSignInConfig,
} from "./sign-in-config-service.js";
import { createWorkspace, ensureUserHasWorkspace, removeMember } from "./workspace-service.js";
import { joinDiscoverableWorkspace, listDiscoverableWorkspaces } from "./workspace-groups.js";
import { searchSignInGroups } from "./sign-in-groups.js";
const ENV_KEYS = [
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_AUTO_JOIN_ORGANIZATION",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "LDAP_URL",
  "LDAP_USER_BASE_DN",
  "LDAP_AUTO_JOIN_ORGANIZATION",
  "OPTIO_SETUP_TOKEN",
  "OPTIO_DEPLOYMENT_ADMINS",
  "OPTIO_AUTH_DISABLED",
];

async function insertUser(
  name: string,
  email = `${name.toLowerCase()}-${randomBytes(3).toString("hex")}@acme.com`,
) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: randomBytes(6).toString("hex"),
      email,
      emailVerified: true,
      displayName: name,
    })
    .returning();
  return row;
}

describe("sign-in groups and qualified workspace access", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    await db.delete(authProviderConfigs);
    await db.update(users).set({ deploymentAdmin: false, ssoGroups: [] });
    await db.update(workspaces).set({ organization: false });
    const redis = getRedisClient();
    await redis.del("optio:setup_token", "optio:sign_in_bootstrap_claim");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const oidc = { issuerUrl: "https://sso.example.com/realms/optio" };
  it("warns when last-admin protection prevents a group-grant revocation", async () => {
    await saveSignInConfig(
      "oidc",
      { clientId: "id", clientSecret: "s", settings: { ...oidc, adminGroups: ["administrators"] } },
      null,
    );
    const admin = await insertUser("Last group admin");
    await completeSignIn(admin, { provider: "oidc", groups: ["administrators"] });
    const warn = vi.spyOn(logger, "warn");
    expect(await completeSignIn(admin, { provider: "oidc", groups: [] })).toMatchObject({
      deploymentAdmin: true,
    });
    expect(warn).toHaveBeenCalledWith(
      { userId: admin.id, provider: "oidc" },
      "Group-admin grant revoked but the last deployment admin is retained; appoint another admin to complete revocation",
    );
  });
  it("revokes group-created workspace access at the next sign-in while retaining manual memberships", async () => {
    await saveSignInConfig("oidc", { clientId: "id", clientSecret: "s", settings: oidc }, null);
    const owner = await insertUser("Owner");
    const member = await insertUser("Member");
    const [mapped] = qualifyGroups("oidc", oidc, ["engineering"]);
    const groupWs = await createWorkspace(
      { name: "By group", slug: "group-" + randomBytes(4).toString("hex"), accessGroups: [mapped] },
      owner.id,
    );
    const manualWs = await createWorkspace(
      { name: "Manual", slug: "manual-" + randomBytes(4).toString("hex"), accessGroups: [mapped] },
      owner.id,
    );
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: manualWs.id, userId: member.id, role: "member" });
    await completeSignIn(member, { provider: "oidc", groups: ["engineering"] });
    const membership = async (id: string) =>
      (
        await db
          .select()
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, member.id)))
      )[0];
    expect((await membership(groupWs.id))?.joinedViaGroups).toBe(true);
    expect((await membership(manualWs.id))?.joinedViaGroups).toBeNull();
    await completeSignIn(member, { provider: "oidc", groups: [] });
    expect(await membership(groupWs.id)).toBeUndefined();
    expect((await membership(manualWs.id))?.role).toBe("member");
  });

  it("keeps group access and group-granted admin when a sign-in carries no groups claim", async () => {
    await saveSignInConfig(
      "oidc",
      { clientId: "id", clientSecret: "s", settings: { ...oidc, adminGroups: ["administrators"] } },
      null,
    );
    const root = await insertUser("Root");
    await addDeploymentAdminByEmail(root.email); // so a revocation isn't held for the last admin
    const owner = await insertUser("Owner");
    const member = await insertUser("Member");
    const [mapped] = qualifyGroups("oidc", { ...oidc, adminGroups: ["administrators"] }, [
      "engineering",
    ]);
    const groupWs = await createWorkspace(
      { name: "By group", slug: "group-" + randomBytes(4).toString("hex"), accessGroups: [mapped] },
      owner.id,
    );
    const inGroupWs = async () =>
      (
        await db
          .select()
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, groupWs.id),
              eq(workspaceMembers.userId, member.id),
            ),
          )
      )[0];
    const defaultOf = async () =>
      (await db.select().from(users).where(eq(users.id, member.id)))[0]!.defaultWorkspaceId;

    await completeSignIn(member, { provider: "oidc", groups: ["engineering", "administrators"] });
    expect((await inGroupWs())?.joinedViaGroups).toBe(true);
    expect(await isDeploymentAdmin(member)).toBe(true);
    const defaultBefore = await defaultOf();
    expect(defaultBefore).toBeTruthy();

    // The claim is absent (moved to userinfo, an oversized token): nothing changes.
    expect(await completeSignIn(member, { provider: "oidc" })).toMatchObject({
      deploymentAdmin: true,
    });
    expect((await inGroupWs())?.joinedViaGroups).toBe(true);
    expect(await defaultOf()).toBe(defaultBefore);
    expect(await isDeploymentAdmin(member)).toBe(true);

    // A present, empty claim is a statement: both are revoked.
    expect(await completeSignIn(member, { provider: "oidc", groups: [] })).toMatchObject({
      deploymentAdmin: false,
    });
    expect(await inGroupWs()).toBeUndefined();
  });

  it("does not make the first ordinary organization joiner a workspace admin", async () => {
    const root = await insertUser("Root");
    await addDeploymentAdminByEmail(root.email);
    await saveSignInConfig(
      "oidc",
      { clientId: "id", clientSecret: "s", settings: { ...oidc, autoJoinOrganization: true } },
      null,
    );
    const member = await insertUser("First ordinary member");
    const result = await completeSignIn(member, { provider: "oidc", groups: [] });
    expect(result.deploymentAdmin).toBe(false);
    expect(result.organizationWorkspaceId).toBeDefined();
    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, result.organizationWorkspaceId!),
          eq(workspaceMembers.userId, member.id),
        ),
      );
    expect(membership.role).toBe("member");
  });

  it("bounds remembered provider groups to300 entries", async () => {
    await saveSignInConfig("oidc", { clientId: "id", clientSecret: "s", settings: oidc }, null);
    const member = await insertUser("Many groups");
    await completeSignIn(member, {
      provider: "oidc",
      groups: Array.from({ length: 400 }, (_, i) => "group-" + i),
    });
    const [row] = await db.select().from(users).where(eq(users.id, member.id));
    expect(row.ssoGroups).toHaveLength(300);
    expect(row.ssoGroups.every((group) => group.startsWith("sso:oidc:"))).toBe(true);
  });

  it("admin groups make their members deployment admins and workspace admins, and take it back", async () => {
    await saveSignInConfig(
      "oidc",
      {
        clientId: "id",
        clientSecret: "s",
        settings: { ...oidc, adminGroups: ["Platform-Admins"], autoJoinOrganization: true },
      },
      null,
    );
    const root = await insertUser("Root");
    await addDeploymentAdminByEmail(root.email);
    const wsId = await ensureUserHasWorkspace(root.id);
    await db.update(workspaces).set({ organization: true }).where(eq(workspaces.id, wsId));

    const carol = await insertUser("Carol");
    expect(
      await completeSignIn(carol, { provider: "oidc", groups: ["developers", "platform-admins"] }),
    ).toMatchObject({ deploymentAdmin: true, organizationWorkspaceId: wsId });
    expect(await isDeploymentAdmin(carol)).toBe(true);
    const roleOf = async (userId: string) =>
      (
        await db
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, userId)))
      )[0]?.role;
    expect(await roleOf(carol.id)).toBe("admin");
    const [carolRow] = await db.select().from(users).where(eq(users.id, carol.id));
    expect(carolRow.ssoGroups).toEqual(
      qualifyGroups("oidc", oidc, ["developers", "platform-admins"]),
    );

    // A linked public identity reports no OIDC groups. It must not erase
    // the provenance needed to revoke the OIDC grant on the next refresh.
    expect(await completeSignIn(carol, { provider: "github", groups: [] })).toMatchObject({
      deploymentAdmin: true,
    });
    const [linkedRow] = await db.select().from(users).where(eq(users.id, carol.id));
    expect(Object.values(linkedRow.deploymentAdminSources!.groups)).toContain(true);

    // Removed from the group: the role goes (root still holds it).
    expect(await completeSignIn(carol, { provider: "oidc", groups: ["developers"] })).toMatchObject(
      { deploymentAdmin: false },
    );
    expect(await isDeploymentAdmin(carol)).toBe(false);
    expect(await roleOf(carol.id)).toBe("member");

    // A role given by hand isn't touched by groups.
    const dave = await insertUser("Dave");
    await addDeploymentAdminByEmail(dave.email);
    expect(await completeSignIn(dave, { provider: "oidc", groups: ["developers"] })).toMatchObject({
      deploymentAdmin: true,
    });
  });
  it("admits people to the workspaces their groups open — on sign-in, when the groups are set, and by joining", async () => {
    const tag = randomBytes(3).toString("hex");
    const eng = `Eng-Platform-${tag}`;
    const [mappedGroup] = qualifyGroups("oidc", undefined, [eng]);
    const owner = await insertUser("Owner");
    // Signed in before the workspace existed, with the group spelled differently.
    const early = await insertUser("Early");
    await db
      .update(users)
      .set({ ssoGroups: [mappedGroup.toUpperCase()] })
      .where(eq(users.id, early.id));

    const ws = await createWorkspace(
      {
        name: `Platform ${tag}`,
        slug: `platform-${tag}`,
        accessGroups: [mappedGroup],
        accessGroupsRole: "viewer",
      },
      owner.id,
    );
    const roleIn = async (userId: string) =>
      (
        await db
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, userId)))
      )[0]?.role;
    expect(await roleIn(early.id)).toBe("viewer");

    // Signing in with the group joins it; a person outside it doesn't.
    const erin = await insertUser("Erin");
    await completeSignIn(erin, { provider: "oidc", groups: ["developers", eng.toLowerCase()] });
    expect(await roleIn(erin.id)).toBe("viewer");
    const frank = await insertUser("Frank");
    await completeSignIn(frank, { provider: "oidc", groups: ["developers"] });
    expect(await roleIn(frank.id)).toBeUndefined();

    // Someone removed finds it again under Discoverable, and joins it.
    await removeMember(ws.id, erin.id);
    expect((await listDiscoverableWorkspaces(erin.id)).map((w) => w.id)).toContain(ws.id);
    expect(await joinDiscoverableWorkspace(erin.id, ws.id)).toEqual({ role: "viewer" });
    expect(await roleIn(erin.id)).toBe("viewer");
    expect((await listDiscoverableWorkspaces(erin.id)).map((w) => w.id)).not.toContain(ws.id);
    // Never for someone whose groups don't open it.
    await expect(joinDiscoverableWorkspace(frank.id, ws.id)).rejects.toMatchObject({ status: 403 });

    // The group pickers know the group now (seen on users and workspaces).
    const { groups } = await searchSignInGroups(`platform-${tag}`);
    expect(groups.map((g) => g.name.toLowerCase())).toContain(mappedGroup.toLowerCase());
    expect(groups.every((g) => g.source === "seen")).toBe(true);
  });
  it("binds workspace groups to their provider and issuer, retaining other linked authorities", async () => {
    await saveSignInConfig("oidc", { clientId: "id", clientSecret: "s", settings: oidc }, null);
    const owner = await insertUser("Owner");
    const name = "engineering";
    const [mapped] = qualifyGroups("oidc", oidc, [name]);
    const tag = randomBytes(4).toString("hex");
    const ws = await createWorkspace(
      { name: "Qualified", slug: "qualified-" + tag, accessGroups: [mapped] },
      owner.id,
    );
    const legacy = await createWorkspace(
      { name: "Legacy", slug: "legacy-" + tag, accessGroups: [name] },
      owner.id,
    );
    const hasWorkspace = async (userId: string, workspaceId = ws.id) =>
      (
        await db
          .select()
          .from(workspaceMembers)
          .where(
            and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
          )
      ).length > 0;
    const outsider = await insertUser("Public-provider");
    await completeSignIn(outsider, { provider: "bitbucket", groups: [name] });
    expect(await hasWorkspace(outsider.id)).toBe(false);
    expect(await hasWorkspace(outsider.id, legacy.id)).toBe(false);
    const member = await insertUser("Trusted-provider");
    await completeSignIn(member, { provider: "oidc", groups: [name] });
    expect(await hasWorkspace(member.id)).toBe(true);
    expect(await hasWorkspace(member.id, legacy.id)).toBe(false);
    await saveSignInConfig(
      "oidc",
      {
        clientId: "id",
        clientSecret: "s",
        settings: { ...oidc, issuerUrl: "https://replacement.example.test" },
      },
      null,
    );
    const otherIssuer = await insertUser("Other-issuer");
    await completeSignIn(otherIssuer, { provider: "oidc", groups: [name] });
    expect(await hasWorkspace(otherIssuer.id)).toBe(false);
  });
});
