/**
 * Sign-in configured in the app, against real Postgres + Redis: a stored
 * Google client (secret encrypted, never returned) takes precedence over the
 * environment, bootstrap mode ends when a provider exists, the setup token is
 * shared and constant-time checked, and the first sign-in after the wizard
 * completes the bootstrap (deployment admin + organization workspace).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { authProviderConfigs, users, workspaces } from "../db/schema.js";
import { getRedisClient } from "./event-bus.js";
import {
  SignInConfigError,
  addDeploymentAdmin,
  addDeploymentAdminByEmail,
  completeSignIn,
  dropStoredEnvironmentGrants,
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
import { ensureUserHasWorkspace } from "./workspace-service.js";
import { createSession } from "./session-service.js";

const ENV_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITLAB_OAUTH_CLIENT_ID",
  "OIDC_ISSUER_URL",
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
      provider: "google",
      externalId: randomBytes(6).toString("hex"),
      email,
      emailVerified: true,
      displayName: name,
    })
    .returning();
  return row;
}

describe("sign-in configuration", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    await db.delete(authProviderConfigs);
    await db.update(users).set({ deploymentAdmin: false });
    const redis = getRedisClient();
    await redis.del("optio:setup_token", "optio:sign_in_bootstrap_claim");
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("stores a Google client encrypted, resolves it over the environment, and never returns the secret", async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "env-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "env-secret";
    expect(await resolveProviderConfig("google")).toMatchObject({
      clientId: "env-id",
      source: "environment",
    });

    await expect(saveSignInConfig("google", { clientId: "db-id" }, null)).rejects.toThrow(
      /client secret is required/,
    );
    const view = await saveSignInConfig(
      "google",
      { clientId: "db-id", clientSecret: "db-secret", allowedDomains: ["Acme.com"] },
      null,
    );
    expect(view).toMatchObject({
      provider: "google",
      source: "database",
      enabled: true,
      clientId: "db-id",
      hasClientSecret: true,
      allowedDomains: ["acme.com"],
    });
    expect(JSON.stringify(view)).not.toContain("db-secret");
    expect(view.callbackUrl).toMatch(/\/api\/auth\/google\/callback$/);

    const [row] = await db.select().from(authProviderConfigs);
    expect(row.encryptedClientSecret?.toString("utf8")).not.toContain("db-secret");
    expect(await resolveProviderConfig("google")).toEqual({
      clientId: "db-id",
      clientSecret: "db-secret",
      allowedDomains: ["acme.com"],
      source: "database",
    });

    // A later save without a secret keeps the stored one; disabling falls back to the environment.
    await saveSignInConfig("google", { clientId: "db-id-2" }, null);
    expect((await resolveProviderConfig("google"))?.clientSecret).toBe("db-secret");
    await saveSignInConfig("google", { clientId: "db-id-2", enabled: false }, null);
    expect((await resolveProviderConfig("google"))?.source).toBe("environment");
    await deleteSignInConfig("google");
    expect((await resolveProviderConfig("google"))?.clientId).toBe("env-id");

    await expect(
      saveSignInConfig("github", { clientId: "x", clientSecret: "y" }, null),
    ).rejects.toThrow(SignInConfigError);
    await expect(
      saveSignInConfig(
        "google",
        { clientId: "x", clientSecret: "y", allowedDomains: ["gmail.com"] },
        null,
      ),
    ).rejects.toThrow(/Anyone can get a gmail.com address/);
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

    await saveSignInConfig("google", { clientId: "id", clientSecret: "s" }, null);
    expect(await isBootstrapMode()).toBe(false);
    expect((await listSignInProviders()).find((p) => p.provider === "google")?.enabled).toBe(true);
    // Still usable: nobody is a deployment admin yet (an upgrade can claim the role)…
    expect(await setupTokenUsable()).toBe(true);
    const ada = await insertUser("Ada");
    await addDeploymentAdminByEmail(ada.email.toUpperCase());
    // …and useless once someone is.
    expect(await setupTokenUsable()).toBe(false);
    expect(await isDeploymentAdmin(ada)).toBe(true);
  });

  it("completes the bootstrap on the first sign-in: deployment admin and the organization's workspace", async () => {
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
    expect(await pendingBootstrapClaim()).toMatchObject({ organizationName: "Acme Corp" });

    const alice = await insertUser("Alice");
    const result = await completeSignIn(alice);
    expect(result).toEqual({ deploymentAdmin: true, bootstrapped: true });
    expect(await hasDeploymentAdmin()).toBe(true);
    const wsId = await ensureUserHasWorkspace(alice.id);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId!));
    expect(ws).toMatchObject({
      name: "Acme Corp",
      slug: "acme-corp",
      autoJoinDomains: ["acme.com"],
      autoJoinRole: "member",
    });
    expect(await pendingBootstrapClaim()).toBeNull();

    // The next person is a plain member of nothing new: no second bootstrap.
    const bob = await insertUser("Bob");
    expect(await completeSignIn(bob)).toEqual({ deploymentAdmin: false, bootstrapped: false });
    expect(await isDeploymentAdmin(bob)).toBe(false);
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

  it("an OPTIO_DEPLOYMENT_ADMINS grant lasts only while the environment lists the email", async () => {
    const email = `ops-${randomBytes(3).toString("hex")}@acme.com`;
    const ops = await insertUser("EnvOps", email);
    process.env.OPTIO_DEPLOYMENT_ADMINS = email;
    expect(await completeSignIn({ ...ops, provider: "google" })).toMatchObject({
      deploymentAdmin: true,
    });
    // Nothing is stored for it…
    const [row] = await db.select().from(users).where(eq(users.id, ops.id));
    expect(row.deploymentAdmin).toBe(false);
    expect(await isDeploymentAdmin(ops)).toBe(true);
    // …so taking the email off the list takes the role away.
    delete process.env.OPTIO_DEPLOYMENT_ADMINS;
    expect(await isDeploymentAdmin(ops)).toBe(false);
    expect(await listDeploymentAdmins()).toEqual([]);
  });

  it("leaves a disabled account out of the enabled admins, also when the environment lists it", async () => {
    const email = `gone-${randomBytes(3).toString("hex")}@acme.com`;
    const gone = await insertUser("Gone", email);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, gone.id));
    process.env.OPTIO_DEPLOYMENT_ADMINS = email;
    expect((await listDeploymentAdmins()).map((a) => a.id)).toContain(gone.id);
    expect((await listDeploymentAdmins({ enabledOnly: true })).map((a) => a.id)).not.toContain(
      gone.id,
    );
    delete process.env.OPTIO_DEPLOYMENT_ADMINS;
  });

  it("at boot, drops the copies earlier versions stored for listed emails, and only those", async () => {
    const listedEmail = `listed-${randomBytes(3).toString("hex")}@acme.com`;
    const listed = await insertUser("Listed", listedEmail);
    const granted = await insertUser("GrantedInApp");
    // What completeSignIn used to store for an environment match, and an app grant.
    await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, listed.id));
    await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, granted.id));
    process.env.OPTIO_DEPLOYMENT_ADMINS = listedEmail.toUpperCase();
    expect(await dropStoredEnvironmentGrants()).toBe(1);
    expect(await isDeploymentAdmin(listed)).toBe(true); // through the list
    expect(await isDeploymentAdmin(granted)).toBe(true); // the app grant stays
    delete process.env.OPTIO_DEPLOYMENT_ADMINS;
    expect(await dropStoredEnvironmentGrants()).toBe(0);
    expect(await isDeploymentAdmin(listed)).toBe(false);
    expect(await isDeploymentAdmin(granted)).toBe(true);
  });

  it("refuses to grant by an email several accounts verified, and grants the one chosen by id", async () => {
    const email = `alice-${randomBytes(3).toString("hex")}@acme.com`;
    const impostor = await insertUser("Impostor", email);
    await db.update(users).set({ provider: "gitea" }).where(eq(users.id, impostor.id));
    const alice = await insertUser("Alice", email);
    const refused = await addDeploymentAdmin({ email }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(SignInConfigError);
    expect(refused).toMatchObject({ status: 409 });
    expect(
      (refused as SignInConfigError).candidates?.map((c) => [c.id, c.displayName, c.provider]),
    ).toEqual([
      [impostor.id, "Impostor", "gitea"],
      [alice.id, "Alice", "google"],
    ]);
    expect(await isDeploymentAdmin(impostor)).toBe(false);
    expect(await isDeploymentAdmin(alice)).toBe(false);

    expect(await addDeploymentAdmin({ userId: alice.id })).toMatchObject({ id: alice.id });
    expect(await isDeploymentAdmin(alice)).toBe(true);
    expect(await isDeploymentAdmin(impostor)).toBe(false);
    await expect(addDeploymentAdmin({ userId: randomUUID() })).rejects.toThrow(/No such user/);
  });

  it("a directory address nobody declared authoritative can bootstrap, but never matches OPTIO_DEPLOYMENT_ADMINS", async () => {
    const person = await insertUser("DirectoryPerson");
    await db
      .update(users)
      .set({ emailVerified: false, provider: "ldap" })
      .where(eq(users.id, person.id));
    const signIn = {
      id: person.id,
      email: person.email,
      emailVerified: false,
      directoryEmail: true,
      provider: "ldap",
    };
    process.env.OPTIO_DEPLOYMENT_ADMINS = person.email;
    expect(await completeSignIn(signIn)).toEqual({ deploymentAdmin: false, bootstrapped: false });
    expect(await isDeploymentAdmin(person)).toBe(false);
    delete process.env.OPTIO_DEPLOYMENT_ADMINS;
    // The first sign-in after the wizard saved LDAP: the directory's own
    // address answers the claim's domains, as it answers LDAP's allowed domains.
    await recordBootstrapClaim({ provider: "ldap", organizationName: null, domains: ["acme.com"] });
    expect(await completeSignIn(signIn)).toEqual({ deploymentAdmin: true, bootstrapped: true });
  });

  it("never grants email-based privileges to an unverified identity", async () => {
    const attacker = await insertUser("Unverified");
    await db.update(users).set({ emailVerified: false }).where(eq(users.id, attacker.id));
    process.env.OPTIO_DEPLOYMENT_ADMINS = attacker.email;
    expect(await isDeploymentAdmin(attacker)).toBe(false);
    expect(await completeSignIn({ ...attacker, emailVerified: false })).toEqual({
      deploymentAdmin: false,
      bootstrapped: false,
    });
    expect(await listDeploymentAdmins()).toEqual([]);
    await expect(addDeploymentAdminByEmail(attacker.email)).rejects.toThrow(/verified email/);
  });

  it("refreshes email verification from the provider on every sign-in", async () => {
    const profile = {
      externalId: randomBytes(8).toString("hex"),
      email: "provider-admin@acme.com",
      displayName: "Provider admin",
    };
    process.env.OPTIO_DEPLOYMENT_ADMINS = profile.email;
    const first = await createSession("oidc", profile);
    expect(await isDeploymentAdmin(first.user)).toBe(false);
    await createSession("oidc", { ...profile, emailVerified: true });
    expect(await isDeploymentAdmin(first.user)).toBe(true);
    await createSession("oidc", { ...profile, emailVerified: false });
    expect(await isDeploymentAdmin(first.user)).toBe(false);
  });

  it("only the configured provider and verified allowed domain may complete bootstrap", async () => {
    const person = await insertUser("WrongProvider");
    await recordBootstrapClaim({
      provider: "google",
      organizationName: "Acme",
      domains: ["acme.com"],
    });
    expect(await completeSignIn({ ...person, provider: "oidc" })).toMatchObject({
      bootstrapped: false,
    });
    expect(await completeSignIn({ ...person, emailVerified: false })).toMatchObject({
      bootstrapped: false,
    });
    expect(await completeSignIn({ ...person, email: "outside@example.net" })).toMatchObject({
      bootstrapped: false,
    });
    expect(await isDeploymentAdmin(person)).toBe(false);
    expect(await pendingBootstrapClaim()).not.toBeNull();
  });

  it("allows only one simultaneous first sign-in to become the deployment admin", async () => {
    const alice = await insertUser("ConcurrentAlice");
    const bob = await insertUser("ConcurrentBob");
    await recordBootstrapClaim({
      provider: "google",
      organizationName: "Acme",
      domains: ["acme.com"],
    });
    const results = await Promise.all([completeSignIn(alice), completeSignIn(bob)]);
    expect(results.filter((result) => result.bootstrapped)).toHaveLength(1);
    expect(await listDeploymentAdmins()).toHaveLength(1);
  });
});
