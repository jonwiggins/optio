/**
 * Sign-in configured in the app, against real Postgres + Redis: a stored
 * Google client (secret encrypted, never returned) takes precedence over the
 * environment, bootstrap mode ends when a provider exists, the setup token is
 * shared and constant-time checked, and the first sign-in after the wizard
 * completes the bootstrap (deployment admin + organization workspace).
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { authProviderConfigs, users, workspaces } from "../db/schema.js";
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
import { ensureUserHasWorkspace } from "./workspace-service.js";

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
    expect(await verifySetupToken(token.slice(0, -1) + "0")).toBe(false);
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
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
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
});
