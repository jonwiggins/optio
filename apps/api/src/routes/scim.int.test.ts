import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import authPlugin from "../plugins/auth.js";
import { db } from "../db/client.js";
import {
  scimTokens,
  scimUsers,
  scimGroupMembers,
  users,
  sessions,
  userIdentities,
  workDefinitions,
} from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import {
  insertWorkspace,
  insertWorkflow,
  insertWorkflowTrigger,
} from "../test-utils/integration/fixtures.js";
import { createApiKey, validateApiKey } from "../services/api-key-service.js";
import { createSession, validateSession } from "../services/session-service.js";
import {
  LastDeploymentAdminError,
  disableUser,
  signInAccountCheck,
} from "../services/offboarding.js";
import { saveSignInConfig } from "../services/sign-in-config-service.js";
import * as signInConfig from "../services/sign-in-config-service.js";
import {
  createScimToken,
  saveScimSignInProvider,
  scimSignInProvider,
  scimAccountFor,
  scimGroupsForSignIn,
} from "../services/scim.js";
import { scimRoutes } from "./scim.js";

let app: FastifyInstance;
let anonymous: FastifyInstance;
let member: FastifyInstance;
let authenticated: FastifyInstance;
let adminId: string;
let token: string;
let tokenId: string;
let wsId: string;
const path = "/api/scim/v2";
const userSchema = "urn:ietf:params:scim:schemas:core:2.0:User";
const patchSchema = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const headers = () => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/scim+json",
});
const send = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  suffix: string,
  payload?: unknown,
) =>
  anonymous.inject({
    method,
    url: path + suffix,
    headers: headers(),
    ...(payload ? { payload: JSON.stringify(payload) } : {}),
  });

beforeAll(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  authenticated = Fastify();
  authenticated.setValidatorCompiler(validatorCompiler);
  authenticated.setSerializerCompiler(serializerCompiler);
  await authenticated.register(authPlugin);
  await authenticated.register(scimRoutes);
  await authenticated.ready();
  const [admin] = await db
    .insert(users)
    .values({
      provider: "google",
      externalId: randomUUID(),
      email: "operator@example.test",
      displayName: "Operator",
      deploymentAdmin: true,
    })
    .returning();
  adminId = admin.id;
  wsId = (await insertWorkspace()).id;
  app = await buildRouteTestApp(scimRoutes, {
    user: { id: adminId, workspaceId: wsId, workspaceRole: "admin" },
  });
  anonymous = await buildRouteTestApp(scimRoutes, { user: null, logger: true });
  const [other] = await db
    .insert(users)
    .values({
      provider: "google",
      externalId: randomUUID(),
      email: "member@example.test",
      displayName: "Member",
    })
    .returning();
  member = await buildRouteTestApp(scimRoutes, {
    user: { id: other.id, workspaceId: wsId, workspaceRole: "admin" },
  });
});
afterAll(async () => {
  await Promise.all([app.close(), anonymous.close(), member.close(), authenticated.close()]);
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.stubEnv("OPTIO_SCIM_ALLOW_ADMIN_GROUPS", "false");
});

async function provision(name: string, extra = {}) {
  const res = await send("POST", "/Users", {
    schemas: [userSchema],
    userName: `${name}@example.test`,
    displayName: name,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; userName: string; active: boolean };
}

describe("SCIM 2.0 provisioning", () => {
  it("is off until a deployment admin creates a hashed bearer token", async () => {
    expect((await anonymous.inject({ method: "GET", url: path + "/Users" })).statusCode).toBe(401);
    expect(
      (
        await member.inject({
          method: "POST",
          url: "/api/admin/scim/tokens",
          payload: { name: "IdP" },
        })
      ).statusCode,
    ).toBe(403);
    const off = await app.inject({ method: "GET", url: "/api/admin/scim" });
    expect(off.json().enabled).toBe(false);
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/scim/tokens",
      payload: { name: "IdP" },
    });
    expect(res.statusCode, res.body).toBe(201);
    token = res.json().token;
    tokenId = res.json().view.id;
    const [stored] = await db.select().from(scimTokens).where(eq(scimTokens.id, tokenId));
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.tokenHash).not.toContain(token);
    expect((await app.inject({ method: "GET", url: "/api/admin/scim" })).body).not.toContain(token);
    expect((await send("GET", "/ServiceProviderConfig")).json().patch.supported).toBe(true);
  });
  it("authenticates SCIM bearer tokens through the real session-auth plugin on both protocol paths", async () => {
    for (const base of ["/api/scim/v2", "/scim/v2"]) {
      const authorized = await authenticated.inject({
        method: "GET",
        url: `${base}/Users`,
        headers: headers(),
      });
      expect(authorized.statusCode, authorized.body).toBe(200);
      const missing = await authenticated.inject({ method: "GET", url: `${base}/Users` });
      expect(missing.statusCode).toBe(401);
      expect(missing.json().schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
      const invalid = await authenticated.inject({
        method: "POST",
        url: `${base}/Users`,
        headers: { ...headers(), authorization: "Bearer optio_scim_invalid" },
        payload: JSON.stringify({ userName: "intruder" }),
      });
      expect(invalid.statusCode).toBe(401);
    }
    const admin = await authenticated.inject({
      method: "GET",
      url: "/api/admin/scim",
      headers: headers(),
    });
    expect(admin.statusCode).toBe(401);
  });
  it("creates, filters, pages, replaces and patches Users with SCIM error responses", async () => {
    const user = await provision("alice", { externalId: "directory-alice" });
    const duplicate = await send("POST", "/Users", { userName: "ALICE@example.test" });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().scimType).toBe("uniqueness");
    const filter = await send(
      "GET",
      `/Users?filter=${encodeURIComponent('userName eq "alice@example.test"')}&count=1&startIndex=1`,
    );
    expect(filter.json()).toMatchObject({
      totalResults: 1,
      itemsPerPage: 1,
      startIndex: 1,
      Resources: [{ id: user.id }],
    });
    const invalid = await send("GET", "/Users?filter=invalid");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().scimType).toBe("invalidFilter");
    const replaced = await send("PUT", `/Users/${user.id}`, {
      userName: "alice@example.test",
      displayName: "Alice Updated",
      active: true,
    });
    expect(replaced.json().displayName).toBe("Alice Updated");
    const patched = await send("PATCH", `/Users/${user.id}`, {
      schemas: [patchSchema],
      Operations: [
        { op: "replace", path: 'emails[type eq "work"].value', value: "alice.new@example.test" },
      ],
    });
    expect(patched.json().emails[0].value).toBe("alice.new@example.test");
  });
  it("applies SCIM admin groups, including PATCH removals", async () => {
    vi.stubEnv("OPTIO_SCIM_ALLOW_ADMIN_GROUPS", "true");
    await saveSignInConfig(
      "oidc",
      {
        clientId: "client",
        clientSecret: "secret",
        settings: { issuerUrl: "https://idp.example.test", adminGroups: ["Admins"] },
      },
      adminId,
    );
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/admin/scim",
          payload: { signInProvider: "oidc" },
        })
      ).statusCode,
    ).toBe(200);
    const user = await provision("bob");
    const { workspaceMembers } = await import("../db/schema.js");
    await db
      .insert(workspaceMembers)
      .values({ userId: user.id, workspaceId: wsId, role: "member" });
    const group = await send("POST", "/Groups", {
      displayName: "Admins",
      members: [{ value: user.id }],
    });
    expect(group.statusCode, group.body).toBe(201);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].deploymentAdmin).toBe(
      true,
    );
    expect(await scimGroupsForSignIn("oidc", "subject-bob", user.id)).toEqual(["Admins"]);
    const removed = await send("PATCH", `/Groups/${group.json().id}`, {
      schemas: [patchSchema],
      Operations: [{ op: "remove", path: `members[value eq "${user.id}"]` }],
    });
    expect(removed.statusCode).toBe(200);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].deploymentAdmin).toBe(
      false,
    );
    const renamed = await send("PUT", `/Groups/${group.json().id}`, {
      displayName: "Readers",
      members: [{ value: user.id }],
    });
    expect(renamed.json().displayName).toBe("Readers");
    expect((await send("DELETE", `/Groups/${group.json().id}`)).statusCode).toBe(204);
  });
  it("only lets the configured sign-in provider claim a provisioned account, without replacing its identity", async () => {
    const user = await provision("carol");
    const profile = {
      externalId: "oidc-carol",
      email: "carol@example.test",
      emailVerified: true,
      displayName: "Carol",
    };
    expect(await scimAccountFor("saml", profile)).toBeNull();
    const claimAccount = await scimAccountFor("oidc", profile);
    expect(claimAccount).toBe(user.id);
    const session = await createSession("oidc", profile, { claimAccount });
    expect(session.user.id).toBe(user.id);
    expect(session.user.provider).toBe("scim");
    expect(
      (await db.select().from(userIdentities).where(eq(userIdentities.userId, user.id)))[0]
        .externalId,
    ).toBe("oidc-carol");
    expect((await createSession("oidc", profile)).user.id).toBe(user.id);
  });
  it("does not claim accounts using an administrator's trustEmail override, and clears verification when SCIM changes email", async () => {
    const user = await provision("verified-claim");
    const profile = {
      externalId: "verified-claim-subject",
      email: "verified-claim@example.test",
      emailVerified: true,
      emailVerifiedByProvider: false,
      displayName: "Claim",
    };
    expect(await scimAccountFor("oidc", profile)).toBeNull();
    const verified = { ...profile, emailVerifiedByProvider: true };
    expect(await scimAccountFor("oidc", verified)).toBe(user.id);
    await createSession("oidc", verified, { claimAccount: user.id });
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].emailVerified).toBe(
      true,
    );
    const unchanged = await send("PATCH", `/Users/${user.id}`, {
      Operations: [{ op: "replace", path: "displayName", value: "Renamed" }],
    });
    expect(unchanged.statusCode, unchanged.body).toBe(200);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].emailVerified).toBe(
      true,
    );
    const changed = await send("PATCH", `/Users/${user.id}`, {
      Operations: [
        {
          op: "replace",
          path: "emails",
          value: [{ value: "changed@example.test", primary: true }],
        },
      ],
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].emailVerified).toBe(
      false,
    );
  });
  it("deprovisions through the LDAP leaver path: sessions and keys revoked, own automations paused, and reactivation restores them", async () => {
    const user = await provision("dave");
    const profile = {
      externalId: "dave-oidc",
      email: "dave@example.test",
      displayName: "Dave",
      emailVerified: true,
    };
    const session = await createSession("oidc", profile, { claimAccount: user.id });
    const key = await createApiKey(user.id, "CLI");
    const work = await insertWorkflow({ workspaceId: wsId, ownerUserId: user.id });
    await insertWorkflowTrigger(work.id, { type: "schedule", config: { cron: "0 * * * *" } });
    expect(await validateSession(session.token)).not.toBeNull();
    const res = await send("PATCH", `/Users/${user.id}`, {
      schemas: [patchSchema],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().active).toBe(false);
    expect(await validateSession(session.token)).toBeNull();
    expect(await validateApiKey(key.token)).toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
    expect(
      (await db.select().from(workDefinitions).where(eq(workDefinitions.id, work.id)))[0].enabled,
    ).toBe(false);
    expect(await signInAccountCheck("oidc", profile)).toBe("account_disabled");
    await expect(createSession("oidc", profile)).rejects.toThrow("disabled");
    await send("PATCH", `/Users/${user.id}`, {
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].disabledAt).toBeNull();
    expect(
      (await db.select().from(workDefinitions).where(eq(workDefinitions.id, work.id)))[0].enabled,
    ).toBe(true);
    await disableUser(user.id, { reason: "admin", byUserId: adminId });
    await send("PATCH", `/Users/${user.id}`, {
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].disabledReason).toBe(
      "admin",
    );
  });
  it("DELETE disables the account while removing its SCIM resource", async () => {
    const user = await provision("erin");
    expect((await send("DELETE", `/Users/${user.id}`)).statusCode).toBe(204);
    expect((await send("GET", `/Users/${user.id}`)).statusCode).toBe(404);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].disabledReason).toBe(
      "deprovisioned",
    );
  });
  it("disables lost required-group members and re-enables only after the group returns", async () => {
    await saveSignInConfig(
      "oidc",
      {
        clientId: "client",
        settings: { issuerUrl: "https://idp.example.test", requiredGroups: ["Allowed"] },
      },
      adminId,
    );
    const user = await provision("frank");
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].disabledReason).toBe(
      "scim_not_in_required_group",
    );
    const group = await send("POST", "/Groups", {
      displayName: "Allowed",
      members: [{ value: user.id }],
    });
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].disabledAt).toBeNull();
    await send("PATCH", `/Groups/${group.json().id}`, {
      Operations: [{ op: "remove", path: "members" }],
    });
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].disabledReason).toBe(
      "scim_not_in_required_group",
    );
    await send("DELETE", `/Groups/${group.json().id}`);
  });
  it("revoking the last token turns SCIM off", async () => {
    expect(
      (await app.inject({ method: "DELETE", url: `/api/admin/scim/tokens/${tokenId}` })).statusCode,
    ).toBe(204);
    expect((await send("GET", "/Users")).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/scim" })).json().enabled).toBe(
      false,
    );
  });
});

describe("SCIM review trust and safety boundaries", () => {
  beforeAll(async () => {
    token = (await createScimToken("Review regression token", adminId)).token;
  });
  beforeEach(async () => {
    vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
    await saveScimSignInProvider("oidc", adminId);
    await saveSignInConfig(
      "oidc",
      {
        clientId: "client",
        clientSecret: "secret",
        allowedDomains: [],
        settings: { issuerUrl: "https://idp.example.test", requiredGroups: [], adminGroups: [] },
      },
      adminId,
    );
  });

  it("authenticates before JSON parsing and schema validation", async () => {
    for (const payload of ["{not-json", JSON.stringify({ Operations: "invalid" })]) {
      const response = await anonymous.inject({
        method: "PATCH",
        url: path + "/Users/not-a-uuid",
        headers: { "content-type": "application/scim+json" },
        payload,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().status).toBe("401");
    }
  });

  it("passes the rate limiter's 429 through", async () => {
    const limited = Fastify();
    limited.setValidatorCompiler(validatorCompiler);
    limited.setSerializerCompiler(serializerCompiler);
    await limited.register(rateLimit, { max: 1, timeWindow: "1 minute" });
    await limited.register(scimRoutes);
    try {
      const first = await limited.inject({ url: path + "/Users", headers: headers() });
      expect(first.statusCode).toBe(200);
      const response = await limited.inject({ url: path + "/Users", headers: headers() });
      expect(response.statusCode).toBe(429);
      expect(response.json().status).toBe("429");
    } finally {
      await limited.close();
    }
  });

  it("persists None over an environment provider", async () => {
    vi.stubEnv("OPTIO_SCIM_SIGN_IN_PROVIDER", "oidc");
    await saveScimSignInProvider(null, adminId);
    expect(await scimSignInProvider()).toBeNull();
  });

  it.each(["flag", "manual", "environment", "another provider's admin group"])(
    "refuses adoption of a deployment admin granted by %s",
    async (kind) => {
      const email = `protected-${kind}-${randomUUID()}@example.test`;
      const [protectedUser] = await db
        .insert(users)
        .values({
          provider: "oidc",
          externalId: randomUUID(),
          email,
          emailVerified: true,
          displayName: "Protected administrator",
          deploymentAdmin: kind === "flag" || kind.endsWith("group"),
          deploymentAdminSources:
            kind === "manual"
              ? { manual: true, groups: {} }
              : kind.endsWith("group")
                ? { manual: false, groups: { ["oidc:" + "b".repeat(64)]: true } }
                : null,
        })
        .returning();
      if (kind === "environment") vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", email);
      const response = await send("POST", "/Users", {
        userName: email,
        displayName: "Attacker supplied name",
        active: false,
      });
      expect(response.statusCode).toBe(409);
      const [unchanged] = await db.select().from(users).where(eq(users.id, protectedUser.id));
      expect(unchanged.displayName).toBe("Protected administrator");
      expect(unchanged.disabledAt).toBeNull();
      expect(
        await db.select().from(scimUsers).where(eq(scimUsers.userId, protectedUser.id)),
      ).toHaveLength(0);
    },
  );

  it.each(["github", "gitlab"])(
    "does not claim a provisioned account through a public %s handle",
    async (provider) => {
      const handle = "handle-" + randomUUID();
      const email = handle + "@example.test";
      const resource = await provision(handle, {
        userName: handle,
        emails: [{ value: email, primary: true }],
      });
      await saveScimSignInProvider(provider, adminId);
      const profile = {
        externalId: randomUUID(),
        username: handle,
        email,
        emailVerified: false,
        emailVerifiedByProvider: false,
      };
      expect(await scimAccountFor(provider, profile)).toBeNull();
      expect(
        await scimAccountFor(provider, {
          ...profile,
          emailVerified: true,
          emailVerifiedByProvider: true,
        }),
      ).toBe(resource.id);
    },
  );

  it("does not grant admin groups unless the deployment operator enables them", async () => {
    await saveSignInConfig(
      "oidc",
      {
        clientId: "client",
        settings: { issuerUrl: "https://idp.example.test", adminGroups: ["Review administrators"] },
      },
      adminId,
    );
    const resource = await provision("opt-in-" + randomUUID());
    const group = await send("POST", "/Groups", {
      displayName: "Review administrators",
      allowAdminGroups: true,
      members: [{ value: resource.id }],
    });
    expect(group.statusCode).toBe(201);
    expect(
      (await db.select().from(users).where(eq(users.id, resource.id)))[0].deploymentAdmin,
    ).toBe(false);
    vi.stubEnv("OPTIO_SCIM_ALLOW_ADMIN_GROUPS", "true");
    expect(
      (
        await send("PATCH", `/Groups/${group.json().id}`, {
          Operations: [{ op: "replace", path: "displayName", value: "review ADMINISTRATORS" }],
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await db.select().from(users).where(eq(users.id, resource.id)))[0].deploymentAdmin,
    ).toBe(true);
  });

  it("holds required-group bulk removals before changing memberships or accounts", async () => {
    const prior = await db.select().from(scimUsers);
    const members = [];
    for (let index = 0; index < Math.max(4, prior.length); index++)
      members.push(await provision("bulk-" + randomUUID()));
    const name = "Required " + randomUUID();
    const group = await send("POST", "/Groups", {
      displayName: name,
      members: members.map((entry) => ({ value: entry.id })),
    });
    await saveSignInConfig(
      "oidc",
      {
        clientId: "client",
        settings: { issuerUrl: "https://idp.example.test", requiredGroups: [name] },
      },
      adminId,
    );
    const response = await send("PATCH", `/Groups/${group.json().id}`, {
      Operations: [{ op: "remove", path: "members" }],
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(
      await db.select().from(scimGroupMembers).where(eq(scimGroupMembers.groupId, group.json().id)),
    ).toHaveLength(members.length);
    for (const resource of members)
      expect(
        (await db.select().from(users).where(eq(users.id, resource.id)))[0].disabledAt,
      ).toBeNull();
  });

  it("rejects oversized pagination as a client error", async () => {
    const response = await send(
      "GET",
      "/Users?startIndex=9999999999999999999999999999999999999999",
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().status).toBe("400");
  });

  it("reuses a deprovisioned account when the same person is provisioned again", async () => {
    const name = "reprovision-" + randomUUID();
    const first = await provision(name);
    expect((await send("DELETE", `/Users/${first.id}`)).statusCode).toBe(204);
    const again = await provision(name);
    expect(again.id).toBe(first.id);
  });

  it("checks provisioned email domains without manufacturing interactive email verification", async () => {
    await saveSignInConfig(
      "oidc",
      {
        clientId: "client",
        allowedDomains: ["example.test"],
        settings: { issuerUrl: "https://idp.example.test" },
      },
      adminId,
    );
    const allowed = await provision("domain-allowed-" + randomUUID());
    const [allowedRow] = await db.select().from(users).where(eq(users.id, allowed.id));
    expect(allowedRow.emailVerified).toBe(false);
    expect(allowedRow.disabledAt).toBeNull();
    const denied = await provision("domain-denied-" + randomUUID(), {
      emails: [{ value: "blocked@outside.test", primary: true }],
    });
    const [deniedRow] = await db.select().from(users).where(eq(users.id, denied.id));
    expect(deniedRow.emailVerified).toBe(false);
    expect(deniedRow.disabledReason).toBe("scim_domain_not_allowed");
  });

  it("serializes simultaneous deactivations so the last deployment admin survives", async () => {
    const first = await provision("concurrent-first-" + randomUUID());
    const second = await provision("concurrent-second-" + randomUUID());
    const previousAdmins = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.deploymentAdmin, true));
    const previousIds = previousAdmins.map((entry) => entry.id);
    await db.update(users).set({ deploymentAdmin: false }).where(inArray(users.id, previousIds));
    await db
      .update(users)
      .set({
        deploymentAdmin: true,
        deploymentAdminSources: { manual: false, groups: { ["scim:" + "a".repeat(64)]: true } },
      })
      .where(inArray(users.id, [first.id, second.id]));
    const original = signInConfig.listDeploymentAdmins;
    let arrivals = 0;
    let release!: () => void;
    const bothChecked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(signInConfig, "listDeploymentAdmins")
      .mockImplementation(async (options) => {
        const result = await original(options);
        if (++arrivals <= 2) {
          if (arrivals === 2) release();
          await bothChecked;
        }
        return result;
      });
    try {
      const responses = await Promise.all(
        [first, second].map((entry) =>
          send("PATCH", `/Users/${entry.id}`, {
            Operations: [{ op: "replace", path: "active", value: false }],
          }),
        ),
      );
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      const survivors = await db
        .select()
        .from(users)
        .where(
          and(
            inArray(users.id, [first.id, second.id]),
            eq(users.deploymentAdmin, true),
            isNull(users.disabledAt),
          ),
        );
      expect(survivors).toHaveLength(1);
    } finally {
      spy.mockRestore();
      await db.update(users).set({ deploymentAdmin: true }).where(inArray(users.id, previousIds));
    }
  });

  it("refuses to change or deactivate a provisioned account that became a deployment admin", async () => {
    const resource = await provision("made-admin-" + randomUUID());
    const required = "Required " + randomUUID();
    const group = await send("POST", "/Groups", {
      displayName: required,
      members: [{ value: resource.id }],
    });
    await db
      .update(users)
      .set({ deploymentAdmin: true, deploymentAdminSources: { manual: true, groups: {} } })
      .where(eq(users.id, resource.id));
    const deactivate = await send("PATCH", `/Users/${resource.id}`, {
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(deactivate.statusCode).toBe(403);
    const rewrite = await send("PUT", `/Users/${resource.id}`, {
      userName: resource.userName,
      emails: [{ value: "elsewhere@outside.test", primary: true }],
    });
    expect(rewrite.statusCode).toBe(403);
    expect((await send("DELETE", `/Users/${resource.id}`)).statusCode).toBe(403);
    // Losing a required group doesn't deactivate them either.
    await saveSignInConfig(
      "oidc",
      {
        clientId: "client",
        settings: { issuerUrl: "https://idp.example.test", requiredGroups: [required] },
      },
      adminId,
    );
    await send("PATCH", `/Groups/${group.json().id}`, {
      Operations: [{ op: "remove", path: `members[value eq "${resource.id}"]` }],
    });
    const [row] = await db.select().from(users).where(eq(users.id, resource.id));
    expect(row.disabledAt).toBeNull();
    expect(row.email).toBe(resource.userName);
    expect(await db.select().from(scimUsers).where(eq(scimUsers.userId, resource.id))).toHaveLength(
      1,
    );
  });

  it("still deactivates someone whose only admin grant is SCIM's own admin group", async () => {
    const resource = await provision("scim-admin-" + randomUUID());
    await db
      .update(users)
      .set({
        deploymentAdmin: true,
        deploymentAdminSources: { manual: false, groups: { ["scim:" + "c".repeat(64)]: true } },
      })
      .where(eq(users.id, resource.id));
    const response = await send("PATCH", `/Users/${resource.id}`, {
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((await db.select().from(users).where(eq(users.id, resource.id)))[0].disabledReason).toBe(
      "deprovisioned",
    );
  });

  it("does not adopt a GitHub account by its public login", async () => {
    await saveScimSignInProvider("github", adminId);
    const login = "octo-" + randomUUID();
    const [account] = await db
      .insert(users)
      .values({
        provider: "github",
        externalId: randomUUID(),
        email: login + "@users.example.test",
        username: login,
        displayName: "GitHub person",
      })
      .returning();
    const resource = await provision(login, {
      userName: login,
      emails: [{ value: "someone-else@example.test", primary: true }],
    });
    expect(resource.id).not.toBe(account.id);
    expect((await db.select().from(users).where(eq(users.id, account.id)))[0].email).toBe(
      login + "@users.example.test",
    );
  });

  it("reuses the account it made when someone is provisioned again without an email", async () => {
    await saveScimSignInProvider("github", adminId);
    const login = "no-email-" + randomUUID();
    const first = await provision(login, { userName: login });
    expect((await send("DELETE", `/Users/${first.id}`)).statusCode).toBe(204);
    const again = await provision(login, { userName: login });
    expect(again.id).toBe(first.id);
    expect(await db.select().from(users).where(eq(users.username, login))).toHaveLength(1);
  });

  it("refuses a disable that would leave no enabled deployment admin", async () => {
    const resource = await provision("sole-admin-" + randomUUID());
    const others = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.deploymentAdmin, true));
    const otherIds = others.map((entry) => entry.id);
    await db.update(users).set({ deploymentAdmin: false }).where(inArray(users.id, otherIds));
    await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, resource.id));
    try {
      await expect(
        disableUser(resource.id, { reason: "admin", protectLastAdmin: true }),
      ).rejects.toBeInstanceOf(LastDeploymentAdminError);
      expect(
        (await db.select().from(users).where(eq(users.id, resource.id)))[0].disabledAt,
      ).toBeNull();
    } finally {
      await db.update(users).set({ deploymentAdmin: true }).where(inArray(users.id, otherIds));
      await db.update(users).set({ deploymentAdmin: false }).where(eq(users.id, resource.id));
    }
  });
});
