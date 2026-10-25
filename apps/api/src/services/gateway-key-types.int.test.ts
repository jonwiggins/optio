/**
 * Gateway types other than LiteLLM (docs/model-gateway.md "Gateway types"),
 * against real Postgres and in-process stand-ins for OpenRouter
 * (test-utils/fake-openrouter.ts) and Portkey (test-utils/fake-portkey.ts):
 * the catalog sync, the token test and budget read, keys Optio makes with
 * each one's admin API (a person's and a team's, rotation, budgets, the
 * housekeeping check, revocation), and a generic gateway that has none of
 * those and says so.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  gatewayIssuedKeys,
  modelProviders,
  teamMembers,
  teams,
  users,
  workspaceMembers,
} from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { startFakeOpenRouter, type FakeOpenRouter } from "../test-utils/fake-openrouter.js";
import { startFakePortkey, type FakePortkey } from "../test-utils/fake-portkey.js";
import { startFakeLiteLLM, type FakeLiteLLM } from "../test-utils/fake-litellm.js";
import {
  createModelProvider,
  getModelProviderRow,
  updateModelProvider,
} from "./model-provider-service.js";
import {
  gatewayKeyInfo,
  gatewayKeyInfoRaw,
  gatewayTest,
  resolveGatewayToken,
  setDefaultGateway,
  syncGatewayCatalog,
} from "./model-gateway-service.js";
import { retrieveSecret, storeSecret } from "./secret-service.js";
import {
  createTeamKey,
  getKeyIssuing,
  issuePersonalKey,
  myGatewayKeyStatus,
  revokeIssuedGatewayKeys,
  revokePersonalKey,
  revokeProviderKeys,
  saveKeyIssuing,
  setTeamBudget,
  teamGatewayKeyStatus,
  type KeyActor,
} from "./gateway-keys.js";
import { checkGatewayKeys } from "./gateway-key-check.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "./notify/email.js";
import type { ModelGatewayType } from "@optio/shared";

const uniq = () => randomBytes(4).toString("hex");
const DAY = 86_400_000;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const mail = createMemoryEmailTransport();
let openrouter: FakeOpenRouter;
let portkey: FakePortkey;
let litellm: FakeLiteLLM;

async function person(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `${name}.${uniq()}@example.test`,
      displayName: name,
    })
    .returning();
  return row;
}

interface World {
  ws: string;
  gatewayId: string;
  admin: KeyActor;
  alice: KeyActor & { email: string };
  carol: KeyActor;
  teamId: string;
}

/** A workspace with a gateway of `type`, its admin, alice, and carol who runs the Platform team. */
async function world(
  type: ModelGatewayType,
  opts: { baseUrl: string; models?: string[] },
): Promise<World> {
  const ws = (await insertWorkspace({ workVisibility: "teams" })).id;
  const [a, al, c] = await Promise.all(["admin", "alice", "carol"].map(person));
  await db.insert(workspaceMembers).values([
    { workspaceId: ws, userId: a.id, role: "admin" },
    { workspaceId: ws, userId: al.id, role: "member" },
    { workspaceId: ws, userId: c.id, role: "member" },
  ]);
  const [team] = await db
    .insert(teams)
    .values({ workspaceId: ws, name: "Platform", slug: `platform-${uniq()}` })
    .returning();
  await db.insert(teamMembers).values({ teamId: team.id, userId: c.id, role: "admin" });
  const admin: KeyActor = {
    workspaceId: ws,
    userId: a.id,
    isAdmin: true,
    teamIds: [],
    adminTeamIds: [],
  };
  const gw = await createModelProvider(
    {
      name: `Gateway ${type}`,
      owner: "workspace",
      kind: "gateway",
      gatewayType: type,
      agents: ["claude-code"],
      baseUrl: opts.baseUrl,
      models: { "claude-code": (opts.models ?? []).map((id) => ({ id })) },
    },
    admin,
  );
  expect(gw.gatewayType).toBe(type);
  await setDefaultGateway(ws, gw.id, admin);
  return {
    ws,
    gatewayId: gw.id,
    admin,
    alice: {
      workspaceId: ws,
      userId: al.id,
      isAdmin: false,
      teamIds: [],
      adminTeamIds: [],
      email: al.email,
    },
    carol: {
      workspaceId: ws,
      userId: c.id,
      isAdmin: false,
      teamIds: [team.id],
      adminTeamIds: [team.id],
    },
    teamId: team.id,
  };
}

const gatewayRow = async (id: string) => (await getModelProviderRow(id))!;

const mySecret = (userId: string) =>
  retrieveSecret("ANTHROPIC_AUTH_TOKEN", "user", undefined, userId).catch(() => null);

const teamSecret = (ws: string, teamId: string) =>
  retrieveSecret("ANTHROPIC_AUTH_TOKEN", "team", ws, undefined, teamId).catch(() => null);

const issuedRow = async (id: string) =>
  (await db.select().from(gatewayIssuedKeys).where(eq(gatewayIssuedKeys.id, id)))[0];

const activeTeamRow = async (teamId: string) =>
  (
    await db
      .select()
      .from(gatewayIssuedKeys)
      .where(and(eq(gatewayIssuedKeys.teamId, teamId), eq(gatewayIssuedKeys.status, "active")))
  )[0];

beforeAll(async () => {
  [openrouter, portkey, litellm] = await Promise.all([
    startFakeOpenRouter(),
    startFakePortkey(),
    startFakeLiteLLM(),
  ]);
  setEmailTransportForTests(mail);
});
afterAll(async () => {
  setEmailTransportForTests(null);
  await Promise.all([openrouter?.close(), portkey?.close(), litellm?.close()]);
});
beforeEach(() => {
  mail.sent.length = 0;
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "optio@example.test");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
});

// ── OpenRouter ───────────────────────────────────────────────────────────────

async function openRouterWorld(issuing = true) {
  const w = await world("openrouter", {
    baseUrl: openrouter.baseUrl,
    models: ["anthropic/claude-sonnet-4.5"],
  });
  if (issuing) {
    await saveKeyIssuing(
      w.gatewayId,
      {
        modes: { personalPasted: true, optioIssued: true },
        adminKey: openrouter.managementKey,
        defaults: { maxBudget: 5, budgetDuration: "1mo", keyDuration: "90d", teamMaxBudget: 50 },
      },
      w.admin,
    );
  }
  return w;
}

describe("an OpenRouter gateway", () => {
  it("syncs context lengths and prices for the models the catalog lists, and adds none", async () => {
    const w = await openRouterWorld(false);
    await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-or-any", "user", null, w.admin.userId!);
    const { provider, synced } = await syncGatewayCatalog(w.gatewayId, w.admin);
    expect(synced.models).toBe(3);
    expect(provider.models["claude-code"]).toEqual([
      {
        id: "anthropic/claude-sonnet-4.5",
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
    ]);
    // An empty catalog: Sync says to add ids, rather than adding hundreds.
    await db
      .update(modelProviders)
      .set({ models: { "claude-code": [] } })
      .where(eq(modelProviders.id, w.gatewayId));
    await expect(syncGatewayCatalog(w.gatewayId, w.admin)).rejects.toThrow(
      /OpenRouter serves 3 models: add the ids you want/,
    );
  });

  it("offers what OpenRouter supports: managed keys with budgets, no per-key models, its reset periods", async () => {
    const w = await openRouterWorld(false);
    const s = await getKeyIssuing(w.gatewayId, w.admin);
    expect(s.gatewayType).toBe("openrouter");
    expect(s.capabilities).toMatchObject({ managedKeys: true, spend: true, keyModels: false });
    // The default "30d" reads as OpenRouter's monthly reset.
    expect(s.defaults.budgetDuration).toBe("1mo");
    const saved = await saveKeyIssuing(
      w.gatewayId,
      {
        modes: { optioIssued: true },
        adminKey: openrouter.managementKey,
        defaults: { budgetDuration: "7d", teamBudgetDuration: "12h" },
      },
      w.admin,
    );
    expect(saved.adminKeyTest).toEqual({ ok: true });
    expect(saved.settings.defaults).toMatchObject({
      budgetDuration: "1w",
      teamBudgetDuration: "1d",
    });
    expect(openrouter.callsTo("GET /api/v1/keys").at(-1)?.auth).toBe(openrouter.managementKey);
    await expect(
      saveKeyIssuing(
        w.gatewayId,
        { defaults: { models: ["anthropic/claude-sonnet-4.5"] } },
        w.admin,
      ),
    ).rejects.toThrow(/OpenRouter keys can't be limited to some models/);
    const wrong = await saveKeyIssuing(w.gatewayId, { adminKey: "sk-or-not-mgmt" }, w.admin);
    expect(wrong.adminKeyTest?.ok).toBe(false);
  });

  it("Get my token: a key with a monthly limit and an expiry, kept by OpenRouter's hash; runs use it", async () => {
    const w = await openRouterWorld();
    const before = openrouter.callsTo("POST /api/v1/keys").length;
    const r = await issuePersonalKey(w.alice);
    expect(r.test).toMatchObject({ ok: true, modelCount: 3 });
    const call = openrouter.callsTo("POST /api/v1/keys")[before];
    const local = w.alice.email.split("@")[0];
    expect(call.auth).toBe(openrouter.managementKey);
    expect(call.body).toMatchObject({ name: `optio-${local}`, limit: 5, limit_reset: "monthly" });
    expect(String(call.body?.expires_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const value = (await mySecret(w.alice.userId!))!;
    expect(value).toMatch(/^sk-or-v1-/);
    const row = await issuedRow(r.key.id);
    const fake = [...openrouter.keys.values()].find((k) => k.key === value)!;
    expect(row.gatewayKeyId).toBe(fake.hash);
    expect(row.keyHash).toBe(sha(value));
    expect(row.keyHash).not.toBe(fake.hash);
    expect(row.litellmUserId).toBeNull();
    const gw = await gatewayRow(w.gatewayId);
    expect(
      await resolveGatewayToken({ provider: gw, workspaceId: w.ws, ownerUserId: w.alice.userId }),
    ).toBe(value);
    expect((await myGatewayKeyStatus(w.alice)).gateway).toMatchObject({ type: "openrouter" });
  });

  it("reads a token's own limit and usage for the Overview and the pre-flight", async () => {
    const w = await openRouterWorld();
    await issuePersonalKey(w.alice);
    const value = (await mySecret(w.alice.userId!))!;
    const fake = [...openrouter.keys.values()].find((k) => k.key === value)!;
    openrouter.setUsage(fake.hash, 1.25);
    const gw = await gatewayRow(w.gatewayId);
    const info = await gatewayKeyInfo(gw, value);
    expect(info).toMatchObject({ spend: 1.25, maxBudget: 5, keyAlias: expect.any(String) });
    expect(new Date(info!.budgetResetAt!).getUTCDate()).toBe(1);
    // A wrong token: OpenRouter's 401, as the pre-flight reads it.
    expect((await gatewayKeyInfoRaw(gw, "sk-or-v1-wrong")).status).toBe(401);
    expect(await gatewayTest(gw, "sk-or-v1-wrong")).toMatchObject({ ok: false });
  });

  it("Rotate: the new key's limit is lowered by what the old one spent, until that period ends", async () => {
    const w = await openRouterWorld();
    const first = await issuePersonalKey(w.alice);
    const oldHash = (await issuedRow(first.key.id)).gatewayKeyId!;
    openrouter.setUsage(oldHash, 2);
    const rotated = await issuePersonalKey(w.alice, { rotate: true });
    expect(rotated.action).toBe("rotate");
    // The old key is gone from OpenRouter; the new one starts with 3 of 5 left.
    expect(openrouter.keys.has(oldHash)).toBe(false);
    const row = await issuedRow(rotated.key.id);
    expect(openrouter.keys.get(row.gatewayKeyId!)?.limit).toBe(3);
    expect(row.carriedSpend).toEqual([{ usd: 2, until: expect.any(String) }]);
    const until = new Date(row.carriedSpend![0].until!);
    expect(until.getUTCDate()).toBe(1);
    // Spend and budget read as the person's: 2 carried of 5.
    expect((await myGatewayKeyStatus(w.alice)).issued?.maxBudget).toBe(5);
    // Once that period is over, the check gives the key its whole limit back.
    await checkGatewayKeys({ force: true, now: new Date(until.getTime() + DAY) });
    expect(openrouter.keys.get(row.gatewayKeyId!)?.limit).toBe(5);
    expect((await issuedRow(rotated.key.id)).carriedSpend).toBeNull();
  });

  it("a team's key carries the team's budget as its own limit; a team admin changes it", async () => {
    const w = await openRouterWorld();
    const made = await createTeamKey(w.teamId, w.carol, { maxBudget: 20, budgetDuration: "1w" });
    expect(made.action).toBe("issue");
    const call = openrouter.callsTo("POST /api/v1/keys").at(-1)!;
    expect(call.body).toMatchObject({
      name: "optio-team-platform",
      limit: 20,
      limit_reset: "weekly",
    });
    const value = (await teamSecret(w.ws, w.teamId))!;
    expect(value).toMatch(/^sk-or-v1-/);
    const row = await activeTeamRow(w.teamId);
    expect(row.litellmTeamId).toBeNull();
    openrouter.setUsage(row.gatewayKeyId!, 4);
    const status = await teamGatewayKeyStatus(w.teamId, w.carol);
    expect(status.gateway).toMatchObject({ type: "openrouter" });
    expect(status.budget).toMatchObject({ spend: 4, maxBudget: 20, source: "gateway" });
    const budget = await setTeamBudget(w.teamId, w.carol, { maxBudget: 30 });
    expect(budget).toMatchObject({ maxBudget: 30 });
    expect(openrouter.keys.get(row.gatewayKeyId!)?.limit).toBe(30);
    // A team admin may not raise it past the gateway's team cap (50).
    await expect(setTeamBudget(w.teamId, w.carol, { maxBudget: 80 })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("the check warns at 80% of a key's limit, and disables a leaver's key", async () => {
    const w = await openRouterWorld();
    await issuePersonalKey(w.alice);
    const value = (await mySecret(w.alice.userId!))!;
    const fake = [...openrouter.keys.values()].find((k) => k.key === value)!;
    openrouter.setUsage(fake.hash, 4.2);
    await checkGatewayKeys({ force: true });
    const warnings = mail.sent.filter((m) => m.to[0] === w.alice.email);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].text).toContain("4.20 USD of 5.00 USD");
    const r = await revokeIssuedGatewayKeys(w.alice.userId!, { workspaceId: w.ws, reason: "left" });
    expect(r).toEqual({ revoked: 1, failed: 0 });
    expect(fake.disabled).toBe(true);
    expect(await mySecret(w.alice.userId!)).toBeNull();
  });

  it("deleting the gateway deletes its keys on OpenRouter; its type can't change while they live", async () => {
    const w = await openRouterWorld();
    await issuePersonalKey(w.alice);
    const value = (await mySecret(w.alice.userId!))!;
    const fake = [...openrouter.keys.values()].find((k) => k.key === value)!;
    await expect(
      updateModelProvider(w.gatewayId, { gatewayType: "litellm" }, w.admin),
    ).rejects.toThrow(/revoke them before changing its type/);
    const r = await revokeProviderKeys(w.gatewayId, w.admin);
    expect(r).toEqual({ revoked: 1, refusal: null });
    expect(openrouter.keys.has(fake.hash)).toBe(false);
    const moved = await updateModelProvider(w.gatewayId, { gatewayType: "litellm" }, w.admin);
    expect(moved.gatewayType).toBe("litellm");
  });
});

// ── Portkey ──────────────────────────────────────────────────────────────────

async function portkeyWorld(issuing = true) {
  const w = await world("portkey", { baseUrl: portkey.url });
  if (issuing) {
    await saveKeyIssuing(
      w.gatewayId,
      {
        modes: { personalPasted: true, optioIssued: true },
        adminKey: portkey.adminKey,
        defaults: {
          maxBudget: 5,
          budgetDuration: "30d",
          keyDuration: "90d",
          teamMaxBudget: 50,
          workspace: "ws-optio",
        },
      },
      w.admin,
    );
  }
  return w;
}

describe("a Portkey gateway", () => {
  it("syncs the ids its /v1/models lists, with its own key header", async () => {
    const w = await portkeyWorld(false);
    await storeSecret("ANTHROPIC_AUTH_TOKEN", portkey.adminKey, "user", null, w.admin.userId!);
    const { provider } = await syncGatewayCatalog(w.gatewayId, w.admin);
    expect(provider.models["claude-code"]?.map((m) => m.id)).toEqual([
      "@anthropic-prod/claude-sonnet-4-5",
      "@openai-prod/gpt-5",
    ]);
    expect(portkey.callsTo("GET /v1/models").at(-1)?.auth).toBe(portkey.adminKey);
  });

  it("takes whole-dollar budgets, its reset periods, and the workspace keys are made in", async () => {
    const w = await portkeyWorld(false);
    const s = await getKeyIssuing(w.gatewayId, w.admin);
    expect(s.capabilities).toMatchObject({ managedKeys: true, spend: false, tokenBudget: false });
    await expect(
      saveKeyIssuing(w.gatewayId, { defaults: { maxBudget: 2.5 } }, w.admin),
    ).rejects.toThrow(/whole USD, 1 or more/);
    const saved = await saveKeyIssuing(
      w.gatewayId,
      {
        modes: { optioIssued: true },
        adminKey: portkey.adminKey,
        defaults: { maxBudget: 3, budgetDuration: "1mo", workspace: "ws-optio" },
      },
      w.admin,
    );
    expect(saved.adminKeyTest).toEqual({ ok: true });
    expect(saved.settings.defaults).toMatchObject({ budgetDuration: "1mo", workspace: "ws-optio" });
    expect(portkey.callsTo("GET /v1/api-keys").at(-1)?.path).toContain("workspace_id=ws-optio");
  });

  it("Get my token: a workspace service key with a cost limit, kept by its UUID; runs use it", async () => {
    const w = await portkeyWorld();
    const r = await issuePersonalKey(w.alice);
    expect(r.test).toMatchObject({ ok: true, modelCount: 2 });
    const call = portkey.callsTo("POST /v1/api-keys/workspace/service").at(-1)!;
    expect(call.auth).toBe(portkey.adminKey);
    expect(call.body).toMatchObject({
      name: `optio-${w.alice.email.split("@")[0]}`,
      scopes: ["completions.write"],
      workspace_id: "ws-optio",
      usage_limits: { type: "cost", credit_limit: 5, periodic_reset_days: 30 },
      defaults: { metadata: { _user: w.alice.email, made_by: "optio" } },
    });
    expect(call.body?.expires_at).toEqual(expect.any(String));
    const value = (await mySecret(w.alice.userId!))!;
    const row = await issuedRow(r.key.id);
    const fake = [...portkey.keys.values()].find((k) => k.key === value)!;
    expect(row.gatewayKeyId).toBe(fake.id);
    expect(row.keyHash).toBe(sha(value));
    // Portkey doesn't report a token's budget: no call is made for it.
    const gw = await gatewayRow(w.gatewayId);
    expect(await gatewayKeyInfoRaw(gw, value)).toEqual({ status: 404, body: null });
  });

  it("Rotate gives the same key a new value: nothing deleted, the old row retired", async () => {
    const w = await portkeyWorld();
    const first = await issuePersonalKey(w.alice);
    const firstValue = (await mySecret(w.alice.userId!))!;
    const id = (await issuedRow(first.key.id)).gatewayKeyId!;
    const rotated = await issuePersonalKey(w.alice, { rotate: true });
    expect(rotated.action).toBe("rotate");
    expect(portkey.callsTo(`POST /v1/api-keys/${id}/rotate`)).toHaveLength(1);
    expect(portkey.callsTo(`POST /v1/api-keys/${id}/rotate`)[0].body).toEqual({
      key_transition_period_ms: 1_800_000,
    });
    expect(portkey.callsTo(`DELETE /v1/api-keys/${id}`)).toHaveLength(0);
    const value = (await mySecret(w.alice.userId!))!;
    expect(value).not.toBe(firstValue);
    expect(portkey.keys.get(id)?.key).toBe(value);
    expect(await issuedRow(first.key.id)).toMatchObject({
      status: "revoked",
      revokedReason: "rotated",
    });
    expect(await issuedRow(rotated.key.id)).toMatchObject({ status: "active", gatewayKeyId: id });
    // Give up: deleted on Portkey.
    await revokePersonalKey(w.alice);
    expect(portkey.keys.has(id)).toBe(false);
  });

  it("Rotate makes a new key when someone deleted the old one in Portkey", async () => {
    const w = await portkeyWorld();
    const first = await issuePersonalKey(w.alice);
    const id = (await issuedRow(first.key.id)).gatewayKeyId!;
    portkey.keys.delete(id);
    const before = portkey.callsTo("POST /v1/api-keys/workspace/service").length;
    const rotated = await issuePersonalKey(w.alice, { rotate: true });
    expect(rotated.action).toBe("rotate");
    expect(portkey.callsTo("POST /v1/api-keys/workspace/service")).toHaveLength(before + 1);
    const row = await issuedRow(rotated.key.id);
    expect(row.gatewayKeyId).not.toBe(id);
    expect(portkey.keys.get(row.gatewayKeyId!)?.key).toBe(await mySecret(w.alice.userId!));
    expect(await issuedRow(first.key.id)).toMatchObject({ status: "revoked" });
  });

  it("a team's key has the team's budget as its cost limit; Portkey can't take one off", async () => {
    const w = await portkeyWorld();
    await createTeamKey(w.teamId, w.carol, { maxBudget: 20, budgetDuration: "1w" });
    const row = await activeTeamRow(w.teamId);
    expect(portkey.keys.get(row.gatewayKeyId!)?.usageLimits).toMatchObject({
      credit_limit: 20,
      periodic_reset: "weekly",
    });
    await setTeamBudget(w.teamId, w.carol, { maxBudget: 30 });
    expect(portkey.keys.get(row.gatewayKeyId!)?.usageLimits).toMatchObject({ credit_limit: 30 });
    await expect(setTeamBudget(w.teamId, w.admin, { maxBudget: null })).rejects.toThrow(
      /Portkey can't take a key's budget off/,
    );
    // The budget shows as Optio saved it: Portkey doesn't report spend.
    const status = await teamGatewayKeyStatus(w.teamId, w.carol);
    expect(status.budget).toMatchObject({ maxBudget: 30, source: "saved" });
  });

  it("the check sends no budget warning (no spend to read) and deletes a leaver's key", async () => {
    const w = await portkeyWorld();
    await issuePersonalKey(w.alice);
    const value = (await mySecret(w.alice.userId!))!;
    const fake = [...portkey.keys.values()].find((k) => k.key === value)!;
    const result = await checkGatewayKeys({ force: true });
    expect(result.failed).toBe(0);
    expect(mail.sent.filter((m) => m.to[0] === w.alice.email)).toHaveLength(0);
    await db
      .delete(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, w.ws), eq(workspaceMembers.userId, w.alice.userId!)),
      );
    await checkGatewayKeys({ force: true });
    expect(portkey.keys.has(fake.id)).toBe(false);
    expect(await mySecret(w.alice.userId!)).toBeNull();
  });
});

// ── A generic gateway ────────────────────────────────────────────────────────

describe("a generic OpenAI- / Anthropic-compatible gateway", () => {
  it("syncs /v1/models, takes pasted tokens, and doesn't offer keys Optio makes", async () => {
    const w = await world("generic", { baseUrl: litellm.url });
    await storeSecret("ANTHROPIC_AUTH_TOKEN", litellm.masterKey, "user", null, w.admin.userId!);
    const { provider } = await syncGatewayCatalog(w.gatewayId, w.admin);
    expect(provider.models["claude-code"]?.map((m) => m.id)).toEqual([
      "qwen-internal",
      "claude-sonnet-internal",
    ]);
    // Only /v1/models, never LiteLLM's /model/info.
    expect(litellm.callsTo("GET /model/info").length).toBe(0);
    const s = await getKeyIssuing(w.gatewayId, w.admin);
    expect(s.capabilities).toMatchObject({ managedKeys: false, tokenBudget: false });
    expect(s.modes).toEqual({ personalPasted: true, optioIssued: false });
    await expect(
      saveKeyIssuing(
        w.gatewayId,
        { modes: { optioIssued: true }, adminKey: litellm.masterKey },
        w.admin,
      ),
    ).rejects.toThrow(/Optio doesn't make keys on OpenAI- \/ Anthropic-compatible gateways/);
    await expect(issuePersonalKey(w.alice)).rejects.toThrow(/doesn't make keys/);
    const gw = await gatewayRow(w.gatewayId);
    expect(await gatewayKeyInfoRaw(gw, litellm.masterKey)).toEqual({ status: 404, body: null });
    expect(await gatewayTest(gw, litellm.masterKey)).toMatchObject({ ok: true, modelCount: 2 });
  });
});
