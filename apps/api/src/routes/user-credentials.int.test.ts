/**
 * A deployment admin lists and revokes one person's sessions and API keys
 * (routes/user-credentials.ts), and sets the session and CLI key lifetimes
 * (routes/deployment-settings.ts). Real Postgres; the caller is set the way
 * the auth plugin would.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { optioActions, users, workspaceMembers } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { createSession, validateSession } from "../services/session-service.js";
import { createApiKey, validateApiKey } from "../services/api-key-service.js";
import { setDeploymentSetting } from "../services/deployment-settings.js";
import {
  CLI_KEY_MAX_DAYS,
  SESSION_IDLE_MINUTES,
  SESSION_MAX_HOURS,
} from "../services/credential-lifetimes.js";
import { userCredentialRoutes } from "./user-credentials.js";
import { deploymentSettingsRoutes } from "./deployment-settings.js";

let admin: FastifyInstance;
let member: FastifyInstance;
let adminId = "";

async function makeUser(deploymentAdmin: boolean, email = `${randomUUID()}@creds.example.test`) {
  const ws = await insertWorkspace();
  const [user] = await db
    .insert(users)
    .values({
      email,
      provider: "github",
      externalId: randomUUID(),
      displayName: deploymentAdmin ? "Admin" : "Person",
      deploymentAdmin,
    })
    .returning();
  await db.insert(workspaceMembers).values({ userId: user.id, workspaceId: ws.id, role: "admin" });
  return { user, workspaceId: ws.id };
}

const asUser = async ({ user, workspaceId }: Awaited<ReturnType<typeof makeUser>>) =>
  buildRouteTestApp(
    async (app) => {
      await userCredentialRoutes(app);
      await deploymentSettingsRoutes(app);
    },
    { user: { id: user.id, workspaceId, workspaceRole: "admin" } },
  );

/** Someone with two sessions and two keys, all created at runtime. */
async function person() {
  const externalId = randomUUID();
  const email = `${externalId}@creds.example.test`;
  const profile = { externalId, email, displayName: "Leaver" };
  const first = await createSession("github", profile);
  const second = await createSession("github", profile);
  const keyA = await createApiKey(first.user.id, "CLI (laptop)");
  const keyB = await createApiKey(first.user.id, "script");
  return { email, userId: first.user.id, sessions: [first.token, second.token], keyA, keyB };
}

beforeAll(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  const a = await makeUser(true);
  adminId = a.user.id;
  admin = await asUser(a);
  member = await asUser(await makeUser(false));
});
afterAll(async () => {
  await admin?.close();
  await member?.close();
  for (const l of [SESSION_MAX_HOURS, SESSION_IDLE_MINUTES, CLI_KEY_MAX_DAYS])
    await setDeploymentSetting(l.key, null, null);
  vi.unstubAllEnvs();
});

const actions = async (action: string) =>
  db
    .select()
    .from(optioActions)
    .where(and(eq(optioActions.action, action), eq(optioActions.userId, adminId)));

describe("a person's sessions and API keys", () => {
  it("lists them by email without any token, and only for a deployment admin", async () => {
    const p = await person();
    const denied = await member.inject({
      method: "GET",
      url: `/api/admin/user-credentials?email=${encodeURIComponent(p.email)}`,
    });
    expect(denied.statusCode).toBe(403);

    const res = await admin.inject({
      method: "GET",
      url: `/api/admin/user-credentials?email=${encodeURIComponent(p.email.toUpperCase())}`,
    });
    expect(res.statusCode).toBe(200);
    const { accounts } = res.json();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].user.id).toBe(p.userId);
    expect(accounts[0].sessions).toHaveLength(2);
    expect(accounts[0].apiKeys.map((k: { prefix: string }) => k.prefix).sort()).toEqual(
      [p.keyA.prefix, p.keyB.prefix].sort(),
    );
    for (const secret of [...p.sessions, p.keyA.token, p.keyB.token])
      expect(res.body).not.toContain(secret);
    expect(res.body).not.toContain("hashed");
    expect(res.body).not.toContain("tokenHash");
  });

  it("revokes one key, leaving the account, its sessions and its other key working", async () => {
    const p = await person();
    expect(
      (
        await member.inject({
          method: "DELETE",
          url: `/api/admin/users/${p.userId}/api-keys/${p.keyA.tokenId}`,
        })
      ).statusCode,
    ).toBe(403);
    expect(await validateApiKey(p.keyA.token)).not.toBeNull();

    // A key id under the wrong person is not found.
    const other = await person();
    const wrong = await admin.inject({
      method: "DELETE",
      url: `/api/admin/users/${other.userId}/api-keys/${p.keyA.tokenId}`,
    });
    expect(wrong.statusCode).toBe(404);

    const res = await admin.inject({
      method: "DELETE",
      url: `/api/admin/users/${p.userId}/api-keys/${p.keyA.tokenId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(await validateApiKey(p.keyA.token)).toBeNull();
    expect(await validateApiKey(p.keyB.token)).not.toBeNull();
    for (const s of p.sessions) expect(await validateSession(s)).not.toBeNull();

    const logged = (await actions("user_credentials.api_key_revoked")).find(
      (a) => a.params?.id === p.keyA.tokenId,
    );
    expect(logged?.result).toEqual({ userId: p.userId, prefix: p.keyA.prefix });
    expect(JSON.stringify(logged)).not.toContain(p.keyA.token);

    const again = await admin.inject({
      method: "DELETE",
      url: `/api/admin/users/${p.userId}/api-keys/${p.keyA.tokenId}`,
    });
    expect(again.statusCode).toBe(404);
  });

  it("ends one session, then all of them, keeping the API keys", async () => {
    const p = await person();
    const listed = (
      await admin.inject({
        method: "GET",
        url: `/api/admin/user-credentials?email=${encodeURIComponent(p.email)}`,
      })
    ).json().accounts[0].sessions as Array<{ id: string }>;
    const one = await admin.inject({
      method: "DELETE",
      url: `/api/admin/users/${p.userId}/sessions/${listed[0].id}`,
    });
    expect(one.statusCode).toBe(200);
    const still = await Promise.all(p.sessions.map((s) => validateSession(s)));
    expect(still.filter(Boolean)).toHaveLength(1);
    expect((await actions("user_credentials.session_revoked")).map((a) => a.params?.id)).toContain(
      listed[0].id,
    );

    const all = await admin.inject({
      method: "DELETE",
      url: `/api/admin/users/${p.userId}/sessions`,
    });
    expect(all.json()).toEqual({ revoked: 1 });
    for (const s of p.sessions) expect(await validateSession(s)).toBeNull();
    expect(await validateApiKey(p.keyB.token)).not.toBeNull();
    const logged = (await actions("user_credentials.sessions_revoked")).find(
      (a) => (a.result as { userId?: string })?.userId === p.userId,
    );
    expect(logged?.params).toEqual({ count: 1 });
  });

  it("rejects ids that aren't UUIDs", async () => {
    const res = await admin.inject({
      method: "DELETE",
      url: `/api/admin/users/not-a-uuid/sessions/also-not`,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("lifetime settings", () => {
  it("are off by default, set by a deployment admin only, within bounds, and can go back", async () => {
    const initial = (await admin.inject({ method: "GET", url: "/api/deployment-settings" })).json();
    expect(initial.sessionMaxHours).toMatchObject({ value: null, source: "environment" });
    expect(initial.sessionIdleMinutes).toMatchObject({ value: null, min: 5, max: 10_080 });
    expect(initial.cliKeyMaxDays).toMatchObject({ value: null });

    const denied = await member.inject({
      method: "PUT",
      url: "/api/deployment-settings",
      payload: { sessionMaxHours: 8 },
    });
    expect(denied.statusCode).toBe(403);

    const tooLong = await admin.inject({
      method: "PUT",
      url: "/api/deployment-settings",
      payload: { sessionMaxHours: 721 },
    });
    expect(tooLong.statusCode).toBe(400);

    const saved = await admin.inject({
      method: "PUT",
      url: "/api/deployment-settings",
      payload: { sessionMaxHours: 8, sessionIdleMinutes: 30, cliKeyMaxDays: 0 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().sessionMaxHours).toMatchObject({ value: 8, source: "app" });
    expect(saved.json().sessionIdleMinutes).toMatchObject({ value: 30, source: "app" });
    expect(saved.json().cliKeyMaxDays).toMatchObject({ value: null, source: "app" });
    // That log write is not awaited by the route.
    await vi.waitFor(async () =>
      expect(
        (await actions("deployment_settings.update")).some(
          (a) => (a.result as { key?: string })?.key === SESSION_IDLE_MINUTES.key,
        ),
      ).toBe(true),
    );

    const back = await admin.inject({
      method: "PUT",
      url: "/api/deployment-settings",
      payload: { sessionMaxHours: null, sessionIdleMinutes: null, cliKeyMaxDays: null },
    });
    expect(back.json().sessionMaxHours).toMatchObject({ value: null, source: "environment" });
    expect(back.json().cliKeyMaxDays).toMatchObject({ source: "environment" });
  });
});
