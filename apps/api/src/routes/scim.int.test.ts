import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import {
  scimTokens,
  users,
  sessions,
  userIdentities,
  teams,
  teamMembers,
  teamGroupMappings,
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
import { disableUser, signInAccountCheck } from "../services/offboarding.js";
import { saveSignInConfig } from "../services/sign-in-config-service.js";
import { scimAccountFor, scimGroupsForSignIn } from "../services/scim.js";
import { scimRoutes } from "./scim.js";

let app: FastifyInstance;
let anonymous: FastifyInstance;
let member: FastifyInstance;
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
  anonymous = await buildRouteTestApp(scimRoutes, { user: null });
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
  await Promise.all([app.close(), anonymous.close(), member.close()]);
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
  it("applies SCIM group admin and team mappings, including PATCH removals", async () => {
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
    const [team] = await db
      .insert(teams)
      .values({ workspaceId: wsId, name: "Developers", slug: "developers" })
      .returning();
    await db
      .insert(teamGroupMappings)
      .values({ teamId: team.id, groupName: "Admins", role: "member" });
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
    expect(
      (
        await db
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, user.id), eq(teamMembers.teamId, team.id)))
      )[0].status,
    ).toBe("active");
    expect(await scimGroupsForSignIn("oidc", "subject-bob", user.id)).toEqual(["Admins"]);
    const removed = await send("PATCH", `/Groups/${group.json().id}`, {
      schemas: [patchSchema],
      Operations: [{ op: "remove", path: `members[value eq "${user.id}"]` }],
    });
    expect(removed.statusCode).toBe(200);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].deploymentAdmin).toBe(
      false,
    );
    expect(
      await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, user.id), eq(teamMembers.teamId, team.id))),
    ).toHaveLength(0);
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
