/**
 * Gateway keys through the real auth plugin (plugins/auth.ts) and real
 * sessions, against real Postgres and an in-process LiteLLM: who may choose
 * the modes (workspace admins), get / rotate / give up a key (only the
 * person, for their own; not a viewer), create a team's key and set its
 * budget (its admins and workspace admins; members read, others get 404),
 * the pasting refusal on every door a token comes in by, the revocation
 * when an admin removes someone from the workspace, and usage per team.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { db } from "../db/client.js";
import {
  gatewayIssuedKeys,
  modelProviders,
  teamMembers,
  teams,
  workspaceMembers,
} from "../db/schema.js";
import authPlugin from "../plugins/auth.js";
import { createSession } from "../services/session-service.js";
import { createModelProvider } from "../services/model-provider-service.js";
import { setDefaultGateway } from "../services/model-gateway-service.js";
import { saveKeyIssuing } from "../services/gateway-keys.js";
import { retrieveSecret } from "../services/secret-service.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { startFakeLiteLLM, type FakeLiteLLM } from "../test-utils/fake-litellm.js";
import { activityRoutes } from "./activity.js";
import { agentCredentialRoutes } from "./agent-credentials.js";
import { modelGatewayRoutes } from "./model-gateway.js";
import { modelProviderRoutes } from "./model-providers.js";
import { secretRoutes } from "./secrets.js";
import { workspaceRoutes } from "./workspaces.js";

// These tests run with teams on and gateway-only model access (both off by default).
vi.hoisted(() => {
  process.env.OPTIO_TEAMS_ENABLED = "true";
  process.env.OPTIO_MODEL_ACCESS = "gateway";
});

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
let app: FastifyInstance;
let litellm: FakeLiteLLM;
let workspaceId: string;
let gatewayId: string;
let teamId: string;

type Who = { userId: string; headers: Record<string, string> };
let admin: Who, lead: Who, member: Who, viewer: Who, stranger: Who;

async function signedIn(
  role: "admin" | "member" | "viewer",
  ws: string = workspaceId,
): Promise<Who> {
  const externalId = `gwkey-${randomBytes(4).toString("hex")}`;
  const { token, user } = await createSession("oidc", {
    externalId,
    email: `${externalId}@example.test`,
    displayName: externalId,
  });
  await db.insert(workspaceMembers).values({ workspaceId: ws, userId: user.id, role });
  return {
    userId: user.id,
    headers: { authorization: `Bearer ${token}`, "x-workspace-id": ws },
  };
}

/** The same person, signed in to another workspace they belong to. */
const inWorkspace = (who: Who, ws: string): Who => ({
  ...who,
  headers: { ...who.headers, "x-workspace-id": ws },
});

const call = (who: Who, method: string, url: string, payload?: unknown) =>
  app.inject({
    method: method as "GET",
    url,
    headers: who.headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const personalToken = (userId: string) =>
  retrieveSecret("ANTHROPIC_AUTH_TOKEN", "user", undefined, userId).catch(() => null);

beforeAll(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  litellm = await startFakeLiteLLM();
  workspaceId = (await insertWorkspace()).id;
  [admin, lead, member, viewer, stranger] = [
    await signedIn("admin"),
    await signedIn("member"),
    await signedIn("member"),
    await signedIn("viewer"),
    await signedIn("member"),
  ];
  const [team] = await db
    .insert(teams)
    .values({ workspaceId, name: "Platform", slug: `platform-${randomBytes(3).toString("hex")}` })
    .returning();
  teamId = team.id;
  await db.insert(teamMembers).values([
    { teamId, userId: lead.userId, role: "admin" },
    { teamId, userId: member.userId, role: "member" },
  ]);
  const actor = { workspaceId, userId: admin.userId, isAdmin: true };
  const gw = await createModelProvider(
    {
      name: "LiteLLM",
      owner: "workspace",
      kind: "gateway",
      agents: ["claude-code"],
      baseUrl: litellm.url,
      models: { "claude-code": [{ id: "qwen-internal" }] },
    },
    actor,
  );
  gatewayId = gw.id;
  await setDefaultGateway(workspaceId, gw.id, actor);

  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(modelGatewayRoutes);
  await app.register(modelProviderRoutes);
  await app.register(secretRoutes);
  await app.register(workspaceRoutes);
  await app.register(agentCredentialRoutes);
  await app.register(activityRoutes);
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await litellm?.close();
  vi.unstubAllEnvs();
});

describe("the gateway's modes are a workspace admin's", () => {
  it("refuses a member and a viewer, takes an admin's", async () => {
    const body = { modes: { optioIssued: true }, adminKey: litellm.masterKey };
    expect(
      (await call(member, "PUT", `/api/model-providers/${gatewayId}/key-issuing`, body)).statusCode,
    ).toBe(403);
    expect(
      (await call(viewer, "PUT", `/api/model-providers/${gatewayId}/key-issuing`, body)).statusCode,
    ).toBe(403);
    expect(
      (await call(member, "GET", `/api/model-providers/${gatewayId}/key-issuing`)).statusCode,
    ).toBe(403);
    const res = await call(admin, "PUT", `/api/model-providers/${gatewayId}/key-issuing`, {
      ...body,
      defaults: { maxBudget: 5, teamMaxBudget: 25 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().settings).toMatchObject({ hasAdminKey: true, modes: { optioIssued: true } });
    expect(res.body).not.toContain(litellm.masterKey);
    const read = await call(admin, "GET", `/api/model-providers/${gatewayId}/key-issuing`);
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain(litellm.masterKey);
  });
});

describe("a person's key is their own", () => {
  it("a member gets, rotates and gives up their own; a viewer may not get one", async () => {
    expect((await call(viewer, "POST", "/api/gateway/me/key", {})).statusCode).toBe(403);

    const got = await call(member, "POST", "/api/gateway/me/key", {});
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json()).toMatchObject({ action: "issue", secretName: "ANTHROPIC_AUTH_TOKEN" });
    const value = (await personalToken(member.userId))!;
    expect(got.body).not.toContain(value);
    expect(got.json().key.keyHint).toBe(value.slice(-4));

    // Nobody else's view or key changes.
    const mine = await call(member, "GET", "/api/gateway/me/key");
    expect(mine.json()).toMatchObject({ canIssue: true, issued: { id: got.json().key.id } });
    const theirs = await call(stranger, "GET", "/api/gateway/me/key");
    expect(theirs.json().issued).toBeNull();
    expect(await personalToken(stranger.userId)).toBeNull();
    expect((await call(stranger, "POST", "/api/gateway/me/key/rotate", {})).statusCode).toBe(404);
    expect((await call(stranger, "DELETE", "/api/gateway/me/key")).statusCode).toBe(404);

    const rotated = await call(member, "POST", "/api/gateway/me/key/rotate", {});
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(litellm.keys.has(sha(value))).toBe(false);

    const gone = await call(member, "DELETE", "/api/gateway/me/key");
    expect(gone.statusCode).toBe(200);
    expect(await personalToken(member.userId)).toBeNull();
  });
});

describe("the key and budget entries of the audit trail", () => {
  it("stay out of a member's Activity feed and are in an admin's", async () => {
    const got = await call(member, "POST", "/api/gateway/me/key", {});
    expect(got.statusCode, got.body).toBe(200);
    const actions = async (who: Who) =>
      ((await call(who, "GET", "/api/activity?days=1&type=action&limit=200")).json().items ?? [])
        .map((i: { action?: string }) => i.action ?? "")
        .filter((a: string) =>
          /^(gateway_key|team_key|budget|model_provider\.key_issuing)/.test(a),
        );
    // auditEvent is written in the background.
    await vi.waitFor(async () => expect(await actions(admin)).toContain("gateway_key.issue"), {
      timeout: 5000,
    });
    expect((await actions(admin)).some((a: string) => a === "budget.set")).toBe(true);
    const seen = await actions(member);
    expect(seen.filter((a: string) => !a.startsWith("model_provider."))).toEqual([]);
    expect((await call(member, "DELETE", "/api/gateway/me/key")).statusCode).toBe(200);
  });
});

describe("a team's key and budget", () => {
  it("members read it, others get 404; the team admin and workspace admins change it", async () => {
    expect((await call(stranger, "GET", `/api/gateway/teams/${teamId}`)).statusCode).toBe(404);
    const read = await call(member, "GET", `/api/gateway/teams/${teamId}`);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ canManage: false, hasToken: false, budgetCap: 25 });

    expect((await call(member, "POST", `/api/gateway/teams/${teamId}/key`, {})).statusCode).toBe(
      403,
    );
    expect((await call(stranger, "POST", `/api/gateway/teams/${teamId}/key`, {})).statusCode).toBe(
      404,
    );
    expect(
      (await call(lead, "POST", `/api/gateway/teams/${teamId}/key`, { maxBudget: 30 })).statusCode,
    ).toBe(403);
    const made = await call(lead, "POST", `/api/gateway/teams/${teamId}/key`, { maxBudget: 20 });
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().budget).toMatchObject({ maxBudget: 20, source: "gateway" });
    expect((await call(member, "DELETE", `/api/gateway/teams/${teamId}/key`)).statusCode).toBe(403);
    expect((await call(stranger, "DELETE", `/api/gateway/teams/${teamId}/key`)).statusCode).toBe(
      404,
    );

    expect(
      (await call(member, "PUT", `/api/gateway/teams/${teamId}/budget`, { maxBudget: 1 }))
        .statusCode,
    ).toBe(403);
    const raised = await call(admin, "PUT", `/api/gateway/teams/${teamId}/budget`, {
      maxBudget: 100,
    });
    expect(raised.statusCode, raised.body).toBe(200);
    expect(raised.json().budget.maxBudget).toBe(100);
    // Above the cap (25) by the workspace admin's hand: the team admin still
    // rotates and changes the period, but can't raise it further.
    const rotated = await call(lead, "POST", `/api/gateway/teams/${teamId}/key`, {});
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.json()).toMatchObject({ action: "rotate", budget: { maxBudget: 100 } });
    const period = await call(lead, "PUT", `/api/gateway/teams/${teamId}/budget`, {
      maxBudget: 100,
      budgetDuration: "7d",
    });
    expect(period.statusCode, period.body).toBe(200);
    expect(
      (await call(lead, "PUT", `/api/gateway/teams/${teamId}/budget`, { maxBudget: 150 }))
        .statusCode,
    ).toBe(403);
    const after = await call(member, "GET", `/api/gateway/teams/${teamId}`);
    expect(after.json()).toMatchObject({ hasToken: true, budget: { maxBudget: 100 } });
  });

  it("usage per team: a member sees their team, a non-member none, an admin every team", async () => {
    const asMember = await call(member, "GET", "/api/usage/teams?days=7");
    expect(asMember.statusCode).toBe(200);
    expect(asMember.json().teams.map((t: { teamId: string }) => t.teamId)).toEqual([teamId]);
    expect((await call(stranger, "GET", "/api/usage/teams")).json().teams).toEqual([]);
    expect((await call(admin, "GET", "/api/usage/teams")).json().teams).toHaveLength(1);
    expect((await call(viewer, "GET", "/api/usage/teams")).statusCode).toBe(403);
  });
});

describe("pasting, when the gateway takes only keys Optio makes", () => {
  it("is refused on My tokens, the secrets route and agent credentials; other secrets still go in", async () => {
    const off = await call(admin, "PUT", `/api/model-providers/${gatewayId}/key-issuing`, {
      modes: { personalPasted: false, optioIssued: true },
    });
    expect(off.statusCode, off.body).toBe(200);

    const pasted = await call(stranger, "PUT", "/api/gateway/me/token", { token: "sk-mine" });
    expect(pasted.statusCode).toBe(400);
    expect(pasted.json().error).toMatch(/Get my token/);
    const viaSecrets = await call(stranger, "POST", "/api/secrets", {
      name: "ANTHROPIC_AUTH_TOKEN",
      value: "sk-mine",
      scope: "user",
    });
    expect(viaSecrets.statusCode).toBe(400);
    const teamPaste = await call(lead, "POST", "/api/secrets", {
      name: "ANTHROPIC_AUTH_TOKEN",
      value: "sk-team",
      scope: "team",
      teamId,
    });
    expect(teamPaste.statusCode).toBe(400);
    expect(teamPaste.json().error).toMatch(/Create team key/);
    expect(await personalToken(stranger.userId)).toBeNull();
    // A gateway reading x-api-key stores the token as ANTHROPIC_API_KEY, which
    // the agent-credentials route also writes.
    await db
      .update(modelProviders)
      .set({ authHeader: "api-key" })
      .where(eq(modelProviders.id, gatewayId));
    const viaCredentials = await call(stranger, "POST", "/api/agents/credentials", {
      agentType: "claude-code",
      secretName: "ANTHROPIC_API_KEY",
      value: "sk-mine",
      owner: "me",
      verify: false,
    });
    expect(viaCredentials.statusCode).toBe(400);
    expect(viaCredentials.json().error).toMatch(/Get my token/);
    await db
      .update(modelProviders)
      .set({ authHeader: "bearer" })
      .where(eq(modelProviders.id, gatewayId));

    const other = await call(stranger, "POST", "/api/secrets", {
      name: "MY_NOTES_TOKEN",
      value: "x",
      scope: "user",
    });
    expect(other.statusCode).toBe(201);

    await call(admin, "PUT", `/api/model-providers/${gatewayId}/key-issuing`, {
      modes: { personalPasted: true },
    });
    const back = await call(stranger, "PUT", "/api/gateway/me/token", { token: "sk-mine" });
    expect(back.statusCode, back.body).toBe(200);
  });
});

describe("removing someone from the workspace", () => {
  it("blocks the key Optio made them in LiteLLM", async () => {
    const leaving = await signedIn("member");
    const got = await call(leaving, "POST", "/api/gateway/me/key", {});
    expect(got.statusCode, got.body).toBe(200);
    const value = (await personalToken(leaving.userId))!;
    const res = await call(
      admin,
      "DELETE",
      `/api/workspaces/${workspaceId}/members/${leaving.userId}`,
    );
    expect(res.statusCode).toBe(204);
    expect(litellm.keys.get(sha(value))?.blocked).toBe(true);
    expect(await personalToken(leaving.userId)).toBeNull();
  });
});

describe("another workspace", () => {
  let otherWs: string;
  let otherAdmin: Who;
  let otherGatewayId: string;

  beforeAll(async () => {
    otherWs = (await insertWorkspace()).id;
    otherAdmin = await signedIn("admin", otherWs);
    const actor = { workspaceId: otherWs, userId: otherAdmin.userId, isAdmin: true };
    const gw = await createModelProvider(
      {
        name: "Second LiteLLM",
        owner: "workspace",
        kind: "gateway",
        agents: ["claude-code"],
        baseUrl: litellm.url,
        models: { "claude-code": [{ id: "qwen-internal" }] },
      },
      actor,
    );
    otherGatewayId = gw.id;
    await setDefaultGateway(otherWs, gw.id, actor);
    await saveKeyIssuing(
      gw.id,
      { modes: { optioIssued: true }, adminKey: litellm.masterKey, defaults: { maxBudget: 3 } },
      actor,
    );
  });

  it("its admin gets 404 on this workspace's gateway settings, teams and team keys", async () => {
    const url = `/api/model-providers/${gatewayId}/key-issuing`;
    expect((await call(otherAdmin, "GET", url)).statusCode).toBe(404);
    expect(
      (await call(otherAdmin, "PUT", url, { modes: { personalPasted: false, optioIssued: true } }))
        .statusCode,
    ).toBe(404);
    expect((await call(otherAdmin, "GET", `/api/gateway/teams/${teamId}`)).statusCode).toBe(404);
    expect(
      (await call(otherAdmin, "POST", `/api/gateway/teams/${teamId}/key`, {})).statusCode,
    ).toBe(404);
    expect(
      (await call(otherAdmin, "PUT", `/api/gateway/teams/${teamId}/budget`, { maxBudget: 1 }))
        .statusCode,
    ).toBe(404);
    expect((await call(otherAdmin, "DELETE", `/api/gateway/teams/${teamId}/key`)).statusCode).toBe(
      404,
    );
    // Deleting this workspace's gateway: refused, and its keys stay.
    const before = await db
      .select()
      .from(gatewayIssuedKeys)
      .where(
        and(eq(gatewayIssuedKeys.providerId, gatewayId), eq(gatewayIssuedKeys.status, "active")),
      );
    expect(before.length).toBeGreaterThan(0);
    expect(
      (await call(otherAdmin, "DELETE", `/api/model-providers/${gatewayId}?force=true`)).statusCode,
    ).toBe(404);
    for (const k of before) expect(litellm.keys.has(k.keyHash)).toBe(true);
    // Nothing changed here: the settings still allow pasting, the team keeps its key.
    const settings = await call(admin, "GET", url);
    expect(settings.json().modes).toEqual({ personalPasted: true, optioIssued: true });
    expect(
      (await call(member, "GET", `/api/gateway/teams/${teamId}`)).json().issued,
    ).not.toBeNull();
  });

  it("its usage per team shows none of this workspace's teams", async () => {
    const res = await call(otherAdmin, "GET", "/api/usage/teams");
    expect(res.statusCode).toBe(200);
    expect(res.json().teams.map((t: { teamId: string }) => t.teamId)).not.toContain(teamId);
  });

  it("removing someone from one workspace leaves the key Optio made them in another", async () => {
    const both = await signedIn("member");
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: otherWs, userId: both.userId, role: "member" });
    const here = await call(both, "POST", "/api/gateway/me/key", {});
    expect(here.statusCode, here.body).toBe(200);
    const hereRow = (
      await db.select().from(gatewayIssuedKeys).where(eq(gatewayIssuedKeys.id, here.json().key.id))
    )[0];
    const there = await call(inWorkspace(both, otherWs), "POST", "/api/gateway/me/key", {});
    expect(there.statusCode, there.body).toBe(200);
    // Tokens are a person's, across workspaces: theirs is now the second key.
    const value = (await personalToken(both.userId))!;
    expect(sha(value)).not.toBe(hereRow.keyHash);

    const res = await call(
      admin,
      "DELETE",
      `/api/workspaces/${workspaceId}/members/${both.userId}`,
    );
    expect(res.statusCode).toBe(204);
    expect(litellm.keys.get(hereRow.keyHash)?.blocked).toBe(true);
    expect(litellm.keys.get(sha(value))?.blocked).toBe(false);
    const rows = await db
      .select()
      .from(gatewayIssuedKeys)
      .where(eq(gatewayIssuedKeys.userId, both.userId));
    expect(Object.fromEntries(rows.map((r) => [r.providerId, r.status]))).toEqual({
      [gatewayId]: "revoked",
      [otherGatewayId]: "active",
    });
    // Their token (the other workspace's key) stays.
    expect(await personalToken(both.userId)).toBe(value);
  });

  it("a gateway whose keys LiteLLM can't delete: 409, then deleted with force", async () => {
    const someone = await signedIn("member", otherWs);
    expect((await call(someone, "POST", "/api/gateway/me/key", {})).statusCode).toBe(200);
    litellm.failNext("POST /key/delete", 500, "database is down");
    const refused = await call(otherAdmin, "DELETE", `/api/model-providers/${otherGatewayId}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/couldn't delete the \d+ keys? it made on Second LiteLLM/);
    expect(
      (await db.select().from(modelProviders).where(eq(modelProviders.id, otherGatewayId))).length,
    ).toBe(1);
    litellm.failNext("POST /key/delete", 500, "database is down");
    const forced = await call(
      otherAdmin,
      "DELETE",
      `/api/model-providers/${otherGatewayId}?force=true`,
    );
    expect(forced.statusCode, forced.body).toBe(204);
    expect(
      (await db.select().from(modelProviders).where(eq(modelProviders.id, otherGatewayId))).length,
    ).toBe(0);
    expect(await personalToken(someone.userId)).toBeNull();
  });
});
