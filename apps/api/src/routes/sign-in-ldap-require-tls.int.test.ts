import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { authProviderConfigs, users } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import * as ldapAuth from "../services/auth/ldap.js";
import { authRoutes } from "./auth.js";
import { signInRoutes } from "./sign-in.js";

const plain = {
  url: "ldap://ad.example.com:389",
  userBaseDn: "DC=example,DC=com",
  bindDn: "CN=optio,DC=example,DC=com",
};
const BIND_PASSWORD = ["bind", "password", randomUUID().slice(0, 8)].join("-");

let app: FastifyInstance;

beforeAll(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  const [admin] = await db
    .insert(users)
    .values({
      provider: "google",
      externalId: randomUUID(),
      email: `ldap-tls-admin-${randomUUID().slice(0, 8)}@example.com`,
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
  await db.delete(authProviderConfigs);
});
afterEach(() => vi.stubEnv("OPTIO_LDAP_REQUIRE_TLS", ""));

const save = (settings: Record<string, unknown>) =>
  app.inject({
    method: "PUT",
    url: "/api/auth/sign-in/ldap",
    payload: { settings, clientSecret: BIND_PASSWORD },
  });

describe("LDAP with OPTIO_LDAP_REQUIRE_TLS", () => {
  it("leaves plain ldap:// alone while the setting is off", async () => {
    const res = await save(plain);
    expect(res.statusCode, res.body).toBe(200);
    const config = await app.inject({ method: "GET", url: "/api/auth/sign-in" });
    expect(config.json().ldapRequireTls).toBe(false);
  });

  it("refuses to save plain ldap:// and says how to fix it", async () => {
    vi.stubEnv("OPTIO_LDAP_REQUIRE_TLS", "true");
    const res = await save(plain);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/requires TLS for LDAP.*ldaps:\/\/.*STARTTLS/);
    expect(await db.select().from(authProviderConfigs)).toHaveLength(0);
    const config = await app.inject({ method: "GET", url: "/api/auth/sign-in" });
    expect(config.json().ldapRequireTls).toBe(true);
  });

  it("saves ldap:// with STARTTLS and ldaps://", async () => {
    vi.stubEnv("OPTIO_LDAP_REQUIRE_TLS", "true");
    expect((await save({ ...plain, startTls: true })).statusCode).toBe(200);
    expect((await save({ ...plain, url: "ldaps://ad.example.com:636" })).statusCode).toBe(200);
  });

  it("refuses a plain directory saved before the setting was turned on", async () => {
    expect((await save(plain)).statusCode).toBe(200);
    vi.stubEnv("OPTIO_LDAP_REQUIRE_TLS", "true");

    const tested = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/ldap/test",
      payload: {},
    });
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json()).toMatchObject({ ok: false });
    expect(tested.json().error).toMatch(/OPTIO_LDAP_REQUIRE_TLS/);

    const authenticate = vi.spyOn(ldapAuth, "ldapAuthenticate");
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      payload: { username: "alice", password: "whatever", cli: true },
    });
    expect(login.statusCode).toBe(403);
    // Refused by the policy before any connection, not by an unreachable server.
    await expect(authenticate.mock.results[0].value).rejects.toMatchObject({
      code: "config",
      message: expect.stringMatching(/OPTIO_LDAP_REQUIRE_TLS/),
    });
    authenticate.mockRestore();
  });
});
