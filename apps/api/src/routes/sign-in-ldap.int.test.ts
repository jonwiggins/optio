import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { authProviderConfigs, optioActions, users } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import * as ldapAuth from "../services/auth/ldap.js";
import { resolveProviderConfig } from "../services/sign-in-config-service.js";
import { authRoutes } from "./auth.js";
import { signInRoutes } from "./sign-in.js";

const trusted = {
  url: "ldaps://trusted.example.com:636",
  userBaseDn: "DC=corp,DC=example",
  bindDn: "CN=optio,DC=corp,DC=example",
};
const STORED_PASSWORD = "stored-private-password";

let app: FastifyInstance;

beforeAll(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_IDP_ALLOW_INSECURE_TLS", "false");
  const [admin] = await db
    .insert(users)
    .values({
      provider: "google",
      externalId: randomUUID(),
      email: `ldap-admin-${randomUUID().slice(0, 8)}@example.test`,
      displayName: "Deployment admin",
      deploymentAdmin: true,
    })
    .returning();
  app = await buildRouteTestApp(
    async (a) => {
      await signInRoutes(a);
      await authRoutes(a);
    },
    { user: { id: admin.id, workspaceId: null, workspaceRole: "admin" } },
  );
});
afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.delete(authProviderConfigs);
  const saved = await save({ settings: trusted, clientSecret: STORED_PASSWORD });
  expect(saved.statusCode, saved.body).toBe(200);
});

const save = (body: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/api/auth/sign-in/ldap", payload: body });
const login = () =>
  app.inject({
    method: "POST",
    url: "/api/auth/ldap/login",
    payload: { username: "anyone", password: "whatever", cli: true },
  });

describe("LDAP bind password stays with its server", () => {
  it("refuses a save that moves the directory without the password, so login never sends it there", async () => {
    const authenticate = vi
      .spyOn(ldapAuth, "ldapAuthenticate")
      .mockRejectedValue(
        new ldapAuth.LdapAuthError("Wrong username or password", "user_not_found"),
      );

    // The oracle: point the saved directory at another server, keep the stored password.
    const moved = await save({ settings: { ...trusted, url: "ldaps://attacker.example:636" } });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error).toMatch(/bind password again/);
    expect((await resolveProviderConfig("ldap"))?.settings).toMatchObject({ url: trusted.url });

    await login();
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate.mock.calls[0][0]).toMatchObject({
      url: trusted.url,
      bindPassword: STORED_PASSWORD,
    });
    for (const [settings] of authenticate.mock.calls) {
      expect(settings.url).not.toContain("attacker");
    }
  });

  it("refuses weaker transport to the same URL without the password", async () => {
    for (const change of [
      { url: "ldap://trusted.example.com:389", startTls: false },
      { caPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" },
    ]) {
      const res = await save({ settings: { ...trusted, ...change } });
      expect(res.statusCode, JSON.stringify(change)).toBe(400);
    }
    expect((await resolveProviderConfig("ldap"))?.settings).toEqual(trusted);
  });

  it("accepts a move that brings its own password, and keeps the password for same-server edits", async () => {
    const authenticate = vi
      .spyOn(ldapAuth, "ldapAuthenticate")
      .mockRejectedValue(
        new ldapAuth.LdapAuthError("Wrong username or password", "user_not_found"),
      );
    const sameServer = await save({ settings: { ...trusted, usernameLabel: "Staff ID" } });
    expect(sameServer.statusCode, sameServer.body).toBe(200);
    expect((await resolveProviderConfig("ldap"))?.clientSecret).toBe(STORED_PASSWORD);

    const other = { ...trusted, url: "ldaps://other.example.com:636" };
    const moved = await save({ settings: other, clientSecret: "other-password" });
    expect(moved.statusCode, moved.body).toBe(200);
    await login();
    expect(authenticate.mock.calls[0][0]).toMatchObject({
      url: other.url,
      bindPassword: "other-password",
    });
  });

  it("drops the stored password when the directory moves to an anonymous bind", async () => {
    const res = await save({
      settings: { url: "ldaps://other.example.com:636", userBaseDn: trusted.userBaseDn },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().provider.hasClientSecret).toBe(false);
    expect((await resolveProviderConfig("ldap"))?.clientSecret).toBe("");
  });

  it("refuses to store insecure LDAP TLS unless the deployment allows it", async () => {
    const res = await save({
      settings: { ...trusted, insecureSkipVerify: true },
      clientSecret: STORED_PASSWORD,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/OPTIO_IDP_ALLOW_INSECURE_TLS/);
  });
});

describe("LDAP sign-ins in the audit trail", () => {
  const entries = (action: string, username: string) =>
    db
      .select()
      .from(optioActions)
      .where(
        and(
          eq(optioActions.action, action),
          sql`${optioActions.params}->>'username' = ${username}`,
        ),
      );

  it("records a refused LDAP sign-in with its reason and the name tried", async () => {
    vi.spyOn(ldapAuth, "ldapAuthenticate").mockRejectedValue(
      new ldapAuth.LdapAuthError("Wrong username or password", "invalid_credentials"),
    );
    const res = await login();
    expect(res.statusCode).toBe(401);
    await vi.waitFor(async () => {
      expect(await entries("auth.sign_in.failure", "anyone")).toContainEqual(
        expect.objectContaining({
          success: false,
          params: { provider: "ldap", reason: "invalid_credentials", username: "anyone" },
        }),
      );
    });
  });

  it("records a successful LDAP sign-in from the CLI", async () => {
    const name = `ldap-${randomUUID().slice(0, 8)}`;
    vi.spyOn(ldapAuth, "ldapAuthenticate").mockResolvedValue({
      externalId: `CN=${name},DC=corp,DC=example`,
      email: `${name}@example.test`,
      displayName: name,
      username: name,
      groups: [],
    } as any);
    const res = await login();
    expect(res.statusCode, res.body).toBe(200);
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, `${name}@example.test`));
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(optioActions)
        .where(and(eq(optioActions.action, "auth.sign_in"), eq(optioActions.userId, user.id)));
      expect(rows).toHaveLength(1);
      expect(rows[0].params).toEqual({ provider: "ldap", via: "cli" });
    });
  });
});
