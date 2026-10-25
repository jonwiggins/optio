/**
 * OpenID Connect and LDAP configured in the app, against real Postgres +
 * Redis: a stored OIDC client (secret encrypted, never returned) takes
 * precedence over the environment, the first sign-in after the wizard
 * completes the bootstrap (deployment admin + organization workspace, which
 * a provider with `autoJoinOrganization` then adds everyone to), admin groups
 * grant and take back the role, and groups open workspaces. Without the
 * setting no provider adds anyone to the organization workspace, and a new
 * identity is a new account unless linking by email is switched on. The
 * Google flow itself is covered by sign-in-config.int.test.ts.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  authProviderConfigs,
  userIdentities,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { getRedisClient } from "./event-bus.js";
import {
  SignInConfigError,
  addDeploymentAdminByEmail,
  completeSignIn,
  deleteSignInConfig,
  hasDeploymentAdmin,
  isBootstrapMode,
  isDeploymentAdmin,
  listDeploymentAdmins,
  listSignInProviders,
  pendingBootstrapClaim,
  recordBootstrapClaim,
  removeDeploymentAdmin,
  resolveProviderConfig,
  saveSignInConfig,
  setupToken,
  setupTokenUsable,
  verifySetupToken,
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
      displayName: name,
    })
    .returning();
  return row;
}

describe("sign-in configuration: OIDC and LDAP", () => {
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
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const oidc = { issuerUrl: "https://sso.example.com/realms/optio" };

  it("stores an OIDC client encrypted, resolves it over the environment, and never returns the secret", async () => {
    process.env.OIDC_ISSUER_URL = "https://env.example";
    process.env.OIDC_CLIENT_ID = "env-id";
    process.env.OIDC_CLIENT_SECRET = "env-secret";
    expect(await resolveProviderConfig("oidc")).toMatchObject({
      clientId: "env-id",
      source: "environment",
      settings: { issuerUrl: "https://env.example" },
    });

    await expect(
      saveSignInConfig("oidc", { clientId: "db-id", settings: oidc }, null),
    ).rejects.toThrow(/client secret is required/);
    await expect(
      saveSignInConfig("oidc", { clientId: "db-id", clientSecret: "x" }, null),
    ).rejects.toThrow(/Settings are required/);
    await expect(
      saveSignInConfig(
        "oidc",
        { clientId: "db-id", clientSecret: "x", settings: { issuerUrl: "not a url" } },
        null,
      ),
    ).rejects.toThrow(/issuerUrl/);
    const view = await saveSignInConfig(
      "oidc",
      {
        clientId: "db-id",
        clientSecret: "db-secret",
        allowedDomains: ["Acme.com"],
        settings: { ...oidc, adminGroups: ["platform-admins"], preset: "keycloak" },
      },
      null,
    );
    expect(view).toMatchObject({
      provider: "oidc",
      source: "database",
      enabled: true,
      clientId: "db-id",
      hasClientSecret: true,
      allowedDomains: ["acme.com"],
      settings: { issuerUrl: oidc.issuerUrl, adminGroups: ["platform-admins"], preset: "keycloak" },
    });
    expect(JSON.stringify(view)).not.toContain("db-secret");
    expect(view.callbackUrl).toMatch(/\/api\/auth\/oidc\/callback$/);

    const [row] = await db.select().from(authProviderConfigs);
    expect(row.encryptedClientSecret?.toString("utf8")).not.toContain("db-secret");
    expect(await resolveProviderConfig("oidc")).toMatchObject({
      clientId: "db-id",
      clientSecret: "db-secret",
      allowedDomains: ["acme.com"],
      source: "database",
    });

    // A later save without a secret or settings keeps the stored ones; disabling falls back to the environment.
    await saveSignInConfig("oidc", { clientId: "db-id-2" }, null);
    expect((await resolveProviderConfig("oidc"))?.clientSecret).toBe("db-secret");
    expect((await resolveProviderConfig("oidc"))?.settings).toMatchObject({ preset: "keycloak" });
    await saveSignInConfig("oidc", { clientId: "db-id-2", enabled: false }, null);
    expect((await resolveProviderConfig("oidc"))?.source).toBe("environment");
    await deleteSignInConfig("oidc");
    expect((await resolveProviderConfig("oidc"))?.clientId).toBe("env-id");

    await expect(
      saveSignInConfig("github", { clientId: "x", clientSecret: "y" }, null),
    ).rejects.toThrow(SignInConfigError);
    await expect(
      saveSignInConfig(
        "oidc",
        { clientId: "x", clientSecret: "y", settings: oidc, allowedDomains: ["gmail.com"] },
        null,
      ),
    ).rejects.toThrow(/Anyone can get a gmail.com address/);
  });

  it("stores an LDAP directory with its bind password as the secret (none needed for an anonymous bind)", async () => {
    const ldap = { url: "ldaps://ad.example.com:636", userBaseDn: "DC=corp,DC=example" };
    await expect(
      saveSignInConfig(
        "ldap",
        { settings: { ...ldap, bindDn: "CN=optio,DC=corp,DC=example" } },
        null,
      ),
    ).rejects.toThrow(/bind password is required/);
    const view = await saveSignInConfig("ldap", { settings: ldap }, null);
    expect(view).toMatchObject({
      provider: "ldap",
      enabled: true,
      clientId: null,
      hasClientSecret: false,
      callbackUrl: null,
      settings: ldap,
    });
    await saveSignInConfig(
      "ldap",
      { clientSecret: "bind-pw", settings: { ...ldap, bindDn: "CN=optio,DC=corp,DC=example" } },
      null,
    );
    expect(await resolveProviderConfig("ldap")).toMatchObject({
      clientSecret: "bind-pw",
      settings: { bindDn: "CN=optio,DC=corp,DC=example" },
    });
    expect((await listSignInProviders()).find((p) => p.provider === "ldap")?.hasClientSecret).toBe(
      true,
    );
  });

  it("is in bootstrap mode until a provider exists anywhere; the setup token is shared and exact", async () => {
    expect(await isBootstrapMode()).toBe(true);
    expect(await setupTokenUsable()).toBe(true);
    const token = await setupToken();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(await setupToken()).toBe(token); // every replica reads the same one
    expect(await verifySetupToken(token)).toBe(true);
    // Change the last character to one it is not (a token can end in "0").
    const wrong = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    expect(await verifySetupToken(wrong)).toBe(false);
    expect(await verifySetupToken("")).toBe(false);

    process.env.OPTIO_SETUP_TOKEN = "chosen-by-the-deployer";
    expect(await verifySetupToken("chosen-by-the-deployer")).toBe(true);
    delete process.env.OPTIO_SETUP_TOKEN;

    await saveSignInConfig("oidc", { clientId: "id", clientSecret: "s", settings: oidc }, null);
    expect(await isBootstrapMode()).toBe(false);
    expect((await listSignInProviders()).find((p) => p.provider === "oidc")?.enabled).toBe(true);
    // Still usable: nobody is a deployment admin yet (an upgrade can claim the role)…
    expect(await setupTokenUsable()).toBe(true);
    const ada = await insertUser("Ada");
    await addDeploymentAdminByEmail(ada.email.toUpperCase());
    // …and useless once someone is.
    expect(await setupTokenUsable()).toBe(false);
    expect(await isDeploymentAdmin(ada)).toBe(true);
  });

  it("completes the bootstrap on the first sign-in: deployment admin and the organization's workspace, which everyone then joins", async () => {
    await saveSignInConfig(
      "oidc",
      {
        clientId: "id",
        clientSecret: "s",
        allowedDomains: ["acme.com"],
        settings: { ...oidc, autoJoinOrganization: true },
      },
      null,
    );
    await recordBootstrapClaim({
      provider: "oidc",
      organizationName: "Acme Corp",
      domains: ["acme.com"],
    });
    expect(await pendingBootstrapClaim()).toMatchObject({ organizationName: "Acme Corp" });

    const alice = await insertUser("Alice");
    const result = await completeSignIn(alice, { provider: "oidc" });
    expect(result).toMatchObject({ deploymentAdmin: true, bootstrapped: true });
    expect(await hasDeploymentAdmin()).toBe(true);
    const wsId = await ensureUserHasWorkspace(alice.id);
    expect(result.organizationWorkspaceId).toBe(wsId);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
    expect(ws).toMatchObject({
      name: "Acme Corp",
      slug: "acme-corp",
      organization: true,
      autoJoinDomains: ["acme.com"],
      autoJoinRole: "member",
    });
    expect(await pendingBootstrapClaim()).toBeNull();

    // The next person is no second bootstrap — but joins the organization as a member.
    const bob = await insertUser("Bob");
    expect(await completeSignIn(bob, { provider: "oidc" })).toEqual({
      deploymentAdmin: false,
      bootstrapped: false,
      organizationWorkspaceId: wsId,
    });
    expect(await isDeploymentAdmin(bob)).toBe(false);
    const [bobRow] = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, bob.id)));
    expect(bobRow?.role).toBe("member");
    expect(await ensureUserHasWorkspace(bob.id)).toBe(wsId);
  });

  it("without a bootstrap, the first LDAP sign-in with auto-join makes an organization workspace that everyone joins", async () => {
    // Sign-in from the deployment's environment: no setup wizard, no claim.
    process.env.LDAP_URL = "ldaps://ldap.example.com";
    process.env.LDAP_USER_BASE_DN = "ou=people,dc=corp,dc=example";
    process.env.LDAP_AUTO_JOIN_ORGANIZATION = "true";
    const first = await insertUser("Fiona");
    const second = await insertUser("Gus");
    const a = await completeSignIn(first, { provider: "ldap" });
    const b = await completeSignIn(second, { provider: "ldap" });
    expect(a.organizationWorkspaceId).toBeTruthy();
    expect(b.organizationWorkspaceId).toBe(a.organizationWorkspaceId);
    const orgs = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.organization, true));
    expect(orgs.map((w) => w.id)).toEqual([a.organizationWorkspaceId]);
    for (const u of [first, second]) {
      const [m] = await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, a.organizationWorkspaceId!),
            eq(workspaceMembers.userId, u.id),
          ),
        );
      expect(m).toBeTruthy();
      const [row] = await db.select().from(users).where(eq(users.id, u.id));
      expect(row.defaultWorkspaceId).toBe(a.organizationWorkspaceId);
    }
  });

  it("adds nobody to the organization workspace through Google, GitHub, GitLab or the environment's OIDC unless told to", async () => {
    const [org] = await db
      .insert(workspaces)
      .values({ name: "Org", slug: `org-${randomBytes(3).toString("hex")}`, organization: true })
      .returning();
    process.env.OIDC_ISSUER_URL = "https://env.example";
    process.env.OIDC_CLIENT_ID = "env-id";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "g-id";
    const memberOfOrg = async (userId: string) =>
      (
        await db
          .select()
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, org.id), eq(workspaceMembers.userId, userId)))
      ).length > 0;
    for (const provider of ["google", "github", "gitlab", "oidc"]) {
      const u = await insertUser(`Via-${provider}`);
      expect(await completeSignIn(u, { provider })).toEqual({
        deploymentAdmin: false,
        bootstrapped: false,
      });
      expect(await memberOfOrg(u.id)).toBe(false);
    }

    process.env.OIDC_AUTO_JOIN_ORGANIZATION = "true";
    const joiner = await insertUser("Joiner");
    expect(await completeSignIn(joiner, { provider: "oidc" })).toEqual({
      deploymentAdmin: false,
      bootstrapped: false,
      organizationWorkspaceId: org.id,
    });
    expect(await memberOfOrg(joiner.id)).toBe(true);
  });

  it("lists Google from the app beside OIDC and LDAP, each enabled on its own", async () => {
    await saveSignInConfig("google", { clientId: "g-id", clientSecret: "g-secret" }, null);
    await saveSignInConfig(
      "oidc",
      { clientId: "o-id", clientSecret: "o-secret", settings: oidc },
      null,
    );
    await saveSignInConfig(
      "ldap",
      { settings: { url: "ldaps://ad.example.com:636", userBaseDn: "DC=corp,DC=example" } },
      null,
    );
    const views = await listSignInProviders();
    expect(views.map((v) => [v.provider, v.enabled, v.configurable, v.source])).toEqual([
      ["google", true, true, "database"],
      ["github", false, false, "none"],
      ["gitlab", false, false, "none"],
      ["oidc", true, true, "database"],
      ["ldap", true, true, "database"],
      ["bitbucket", false, true, "none"],
      ["gitea", false, true, "none"],
      ["saml", false, true, "none"],
    ]);
    const google = views.find((v) => v.provider === "google")!;
    expect(google).toMatchObject({ clientId: "g-id", settings: null, hasClientSecret: true });
    expect(google.callbackUrl).toMatch(/\/api\/auth\/google\/callback$/);
    expect(views.find((v) => v.provider === "ldap")).toMatchObject({
      clientId: null,
      callbackUrl: null,
    });
    const { listEnabledProviders } = await import("./oauth/index.js");
    expect(await listEnabledProviders()).toEqual([
      { name: "google", displayName: "Google", method: "redirect" },
      { name: "oidc", displayName: "SSO (OpenID Connect)", method: "redirect" },
      {
        name: "ldap",
        displayName: "LDAP / Active Directory",
        method: "password",
        usernameLabel: null,
      },
    ]);
    // Turning OIDC off leaves Google and LDAP as they were.
    await saveSignInConfig("oidc", { enabled: false }, null);
    expect((await listEnabledProviders()).map((p) => p.name)).toEqual(["google", "ldap"]);
  });

  it("links a sign-in to an existing account by email only when switched on, never re-keying it", async () => {
    const { createSession } = await import("./session-service.js");
    const email = `link-${randomBytes(3).toString("hex")}@acme.com`;
    const original = await insertUser("Linda", email);
    const profile = (externalId: string, asserted = true) => ({
      externalId,
      email,
      displayName: "Linda",
      emailVerified: true,
      emailVerifiedByProvider: asserted,
    });

    // By default (as upstream) a new identity is a new account, whatever the provider.
    for (const provider of ["google", "github", "gitlab", "oidc", "ldap", "saml"]) {
      const s = await createSession(provider, profile(`${provider}-id`));
      expect(s.user.id).not.toBe(original.id);
    }

    // Switched on: the provider must have asserted the email itself — an
    // administrator's trustEmail alone never links.
    const lena = await insertUser("Lena", `lena-${randomBytes(3).toString("hex")}@acme.com`);
    const asLena = (externalId: string, asserted = true) => ({
      ...profile(externalId, asserted),
      email: lena.email,
    });
    const tess = await insertUser("Tess", `tess-${randomBytes(3).toString("hex")}@acme.com`);
    const trusted = await createSession(
      "oidc",
      { ...profile("trusted-only", false), email: tess.email },
      { linkByEmail: true },
    );
    expect(trusted.user.id).not.toBe(tess.id);
    const viaLdap = await createSession("ldap", asLena("ldap-entry"), { linkByEmail: true });
    expect(viaLdap.user.id).toBe(lena.id);
    // The account keeps the identity it was made with; the new one is linked beside it.
    const [kept] = await db.select().from(users).where(eq(users.id, lena.id));
    expect(kept).toMatchObject({ provider: "oidc", externalId: lena.externalId });
    const links = await db.select().from(userIdentities).where(eq(userIdentities.userId, lena.id));
    expect(links.map((l) => [l.provider, l.externalId])).toEqual([["ldap", "ldap-entry"]]);

    // Google then GitHub, alternating: one account, still the provider it was made with.
    const g = await createSession("google", asLena("g-1"), { linkByEmail: true });
    const gh = await createSession("github", asLena("gh-1"), { linkByEmail: true });
    const g2 = await createSession("google", asLena("g-1"));
    const ldapAgain = await createSession("ldap", asLena("ldap-entry"));
    expect(new Set([g.user.id, gh.user.id, g2.user.id, ldapAgain.user.id])).toEqual(
      new Set([lena.id]),
    );
    const [after] = await db.select().from(users).where(eq(users.id, lena.id));
    expect(after.provider).toBe("oidc");
  });

  it("links nobody by email when two accounts share it", async () => {
    const { createSession } = await import("./session-service.js");
    const email = `twin-${randomBytes(3).toString("hex")}@acme.com`;
    const a = await insertUser("Twin A", email);
    const b = await insertUser("Twin B", email.toUpperCase());
    const s = await createSession(
      "ldap",
      { externalId: "twin", email, displayName: "Twin", emailVerified: true },
      { linkByEmail: true },
    );
    expect([a.id, b.id]).not.toContain(s.user.id);
  });

  it("a first page load's parallel requests share one default workspace", async () => {
    const u = await insertUser("Hana");
    const ids = await Promise.all(Array.from({ length: 6 }, () => ensureUserHasWorkspace(u.id)));
    expect(new Set(ids).size).toBe(1);
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
    expect(carolRow.ssoGroups).toEqual(["developers", "platform-admins"]);

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

  it("grants the role from the environment and manages it in the app, never removing the last one", async () => {
    const opsEmail = `ops-${randomBytes(3).toString("hex")}@acme.com`;
    const ops = await insertUser("Ops", opsEmail);
    process.env.OPTIO_DEPLOYMENT_ADMINS = opsEmail.toUpperCase();
    expect(await hasDeploymentAdmin()).toBe(true);
    expect(await isDeploymentAdmin(ops)).toBe(true);
    expect(await completeSignIn(ops)).toMatchObject({ deploymentAdmin: true });
    const admins = await listDeploymentAdmins();
    expect(admins.map((a) => [a.email, a.fromEnvironment])).toEqual([[opsEmail, true]]);
    await expect(removeDeploymentAdmin(ops.id, null)).rejects.toThrow(/OPTIO_DEPLOYMENT_ADMINS/);
    delete process.env.OPTIO_DEPLOYMENT_ADMINS;

    // In-app: add by email (they must exist), and never remove the last one.
    await expect(addDeploymentAdminByEmail("nobody@acme.com")).rejects.toThrow(/signed in yet/);
    await db.update(users).set({ deploymentAdmin: false }).where(eq(users.id, ops.id));
    const ada = await insertUser("Ada");
    await addDeploymentAdminByEmail(ada.email);
    await expect(removeDeploymentAdmin(ada.id, ada.id)).rejects.toThrow(/last deployment admin/);
    await addDeploymentAdminByEmail(opsEmail);
    await removeDeploymentAdmin(ada.id, ops.id);
    expect((await listDeploymentAdmins()).map((a) => a.email)).toEqual([opsEmail]);
  });

  it("admits people to the workspaces their groups open — on sign-in, when the groups are set, and by joining", async () => {
    const tag = randomBytes(3).toString("hex");
    const eng = `Eng-Platform-${tag}`;
    const owner = await insertUser("Owner");
    // Signed in before the workspace existed, with the group spelled differently.
    const early = await insertUser("Early");
    await db
      .update(users)
      .set({ ssoGroups: [eng.toUpperCase()] })
      .where(eq(users.id, early.id));

    const ws = await createWorkspace(
      {
        name: `Platform ${tag}`,
        slug: `platform-${tag}`,
        accessGroups: [eng],
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
    expect(groups.map((g) => g.name.toLowerCase())).toContain(eng.toLowerCase());
    expect(groups.every((g) => g.source === "seen")).toBe(true);
  });
});
