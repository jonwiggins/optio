/**
 * Gateway keys made by Optio (services/gateway-keys.ts, gateway-key-check.ts)
 * against real Postgres and an in-process LiteLLM (test-utils/fake-litellm.ts):
 * the admin's modes and admin key, "Get my token" / Rotate / revoke, a team's
 * key and budget, the pasting refusal, deactivation, the housekeeping check's
 * revocations and budget warnings, and usage per team.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  gatewayIssuedKeys,
  modelProviders,
  optioActions,
  secrets,
  teamMembers,
  teams,
  users,
  workspaceMembers,
} from "../db/schema.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { startFakeLiteLLM, type FakeLiteLLM } from "../test-utils/fake-litellm.js";
import { createModelProvider } from "./model-provider-service.js";
import { resolveGatewayToken, setDefaultGateway } from "./model-gateway-service.js";
import { retrieveSecret, storeSecret } from "./secret-service.js";
import {
  GatewayKeyError,
  adminKeyOf,
  createTeamKey,
  getKeyIssuing,
  issuePersonalKey,
  myGatewayKeyStatus,
  pastedTokenRefusal,
  revokeIssuedGatewayKeys,
  revokePersonalKey,
  revokeProviderKeys,
  saveKeyIssuing,
  setTeamBudget,
  spendToCarry,
  teamGatewayKeyStatus,
  type KeyActor,
} from "./gateway-keys.js";
import { checkGatewayKeys, warningDue } from "./gateway-key-check.js";
import { disableUser } from "./offboarding.js";
import { teamUsage } from "./team-usage-service.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "./notify/email.js";

// These tests run with teams on and gateway-only model access (both off by default).
vi.hoisted(() => {
  process.env.OPTIO_TEAMS_ENABLED = "true";
  process.env.OPTIO_MODEL_ACCESS = "gateway";
});

const uniq = () => randomBytes(4).toString("hex");
const DAY = 86_400_000;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const mail = createMemoryEmailTransport();
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

/**
 * The newest `action` entry in the workspace (one whose params `match`, when
 * given). Audit writes don't block the call that makes them, so an earlier
 * entry of the same action can be there first: wait for the one meant.
 */
async function waitForAction(
  action: string,
  workspaceId: string,
  match: (params: Record<string, unknown>) => boolean = () => true,
) {
  for (let i = 0; i < 40; i++) {
    const rows = await db
      .select()
      .from(optioActions)
      .where(and(eq(optioActions.action, action), eq(optioActions.workspaceId, workspaceId)))
      .orderBy(desc(optioActions.createdAt))
      .limit(20);
    const row = rows.find((r) => match((r.params ?? {}) as Record<string, unknown>));
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no ${action} audit entry`);
}

interface World {
  ws: string;
  gatewayId: string;
  admin: KeyActor;
  alice: KeyActor & { email: string };
  bob: KeyActor & { email: string };
  carol: KeyActor;
  outsider: KeyActor;
  teamId: string;
  otherTeamId: string;
}

async function world(opts: { issuing?: boolean } = {}): Promise<World> {
  const ws = (await insertWorkspace({ workVisibility: "teams" })).id;
  const [a, al, b, c, o] = await Promise.all(
    ["admin", "alice", "bob", "carol", "outsider"].map(person),
  );
  await db.insert(workspaceMembers).values([
    { workspaceId: ws, userId: a.id, role: "admin" },
    { workspaceId: ws, userId: al.id, role: "member" },
    { workspaceId: ws, userId: b.id, role: "member" },
    { workspaceId: ws, userId: c.id, role: "member" },
    { workspaceId: ws, userId: o.id, role: "member" },
  ]);
  const [team, other] = await db
    .insert(teams)
    .values([
      { workspaceId: ws, name: "Platform", slug: `platform-${uniq()}` },
      { workspaceId: ws, name: "Data", slug: `data-${uniq()}` },
    ])
    .returning();
  await db.insert(teamMembers).values([
    { teamId: team.id, userId: c.id, role: "admin" },
    { teamId: team.id, userId: b.id, role: "member" },
    { teamId: other.id, userId: o.id, role: "admin" },
  ]);
  const admin: KeyActor = {
    workspaceId: ws,
    userId: a.id,
    isAdmin: true,
    teamIds: [],
    adminTeamIds: [],
  };
  const gw = await createModelProvider(
    {
      name: "LiteLLM",
      owner: "workspace",
      kind: "gateway",
      agents: ["claude-code"],
      baseUrl: litellm.url,
      models: { "claude-code": [{ id: "qwen-internal" }, { id: "claude-sonnet-internal" }] },
    },
    admin,
  );
  await setDefaultGateway(ws, gw.id, admin);
  if (opts.issuing !== false) {
    await saveKeyIssuing(
      gw.id,
      {
        modes: { personalPasted: true, optioIssued: true },
        adminKey: litellm.masterKey,
        defaults: { maxBudget: 5, budgetDuration: "30d", keyDuration: "90d", teamMaxBudget: 50 },
      },
      admin,
    );
  }
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
    bob: {
      workspaceId: ws,
      userId: b.id,
      isAdmin: false,
      teamIds: [team.id],
      adminTeamIds: [],
      email: b.email,
    },
    carol: {
      workspaceId: ws,
      userId: c.id,
      isAdmin: false,
      teamIds: [team.id],
      adminTeamIds: [team.id],
    },
    outsider: {
      workspaceId: ws,
      userId: o.id,
      isAdmin: false,
      teamIds: [other.id],
      adminTeamIds: [other.id],
    },
    teamId: team.id,
    otherTeamId: other.id,
  };
}

const gatewayRow = async (id: string) =>
  (await db.select().from(modelProviders).where(eq(modelProviders.id, id)))[0];

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
  litellm = await startFakeLiteLLM();
  setEmailTransportForTests(mail);
});
afterAll(async () => {
  setEmailTransportForTests(null);
  await litellm?.close();
});
beforeEach(() => {
  mail.sent.length = 0;
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "optio@example.test");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
});

describe("the admin's choice: modes, the admin key, defaults", () => {
  it("starts as pasting only, and keeps at least one way on", async () => {
    const w = await world({ issuing: false });
    const s = await getKeyIssuing(w.gatewayId, w.admin);
    expect(s.modes).toEqual({ personalPasted: true, optioIssued: false });
    expect(s.hasAdminKey).toBe(false);
    expect(s.catalogModels).toEqual(["qwen-internal", "claude-sonnet-internal"]);
    await expect(
      saveKeyIssuing(w.gatewayId, { modes: { personalPasted: false } }, w.admin),
    ).rejects.toThrow(/at least one way/);
    await expect(
      saveKeyIssuing(w.gatewayId, { modes: { optioIssued: true } }, w.admin),
    ).rejects.toThrow(/admin key/);
  });

  it("seals the admin key, tries it, and records what changed", async () => {
    const w = await world({ issuing: false });
    const saved = await saveKeyIssuing(
      w.gatewayId,
      {
        modes: { optioIssued: true },
        adminKey: litellm.masterKey,
        defaults: { maxBudget: 10, models: ["qwen-internal"] },
      },
      w.admin,
    );
    expect(saved.adminKeyTest).toEqual({ ok: true });
    expect(saved.settings).toMatchObject({
      modes: { personalPasted: true, optioIssued: true },
      hasAdminKey: true,
      defaults: { maxBudget: 10, models: ["qwen-internal"], budgetDuration: "30d" },
    });
    expect(saved.changed).toEqual(
      expect.arrayContaining(["optioIssued", "adminKey", "maxBudget", "models"]),
    );
    const row = await gatewayRow(w.gatewayId);
    expect(row.encryptedAdminKey?.toString("utf8")).not.toContain(litellm.masterKey);
    expect(adminKeyOf(row)).toBe(litellm.masterKey);
    const entry = await waitForAction("model_provider.key_issuing", w.ws);
    expect(JSON.stringify(entry.params)).not.toContain(litellm.masterKey);
    await waitForAction("budget.set", w.ws);

    const wrong = await saveKeyIssuing(w.gatewayId, { adminKey: "sk-not-admin" }, w.admin);
    expect(wrong.adminKeyTest?.ok).toBe(false);
  });

  it("refuses a model the catalog doesn't serve, a bad period, a member and a shared-token gateway", async () => {
    const w = await world({ issuing: false });
    await expect(
      saveKeyIssuing(w.gatewayId, { defaults: { models: ["gpt-9"] } }, w.admin),
    ).rejects.toThrow(/Not in the gateway's catalog: gpt-9/);
    await expect(
      saveKeyIssuing(w.gatewayId, { defaults: { budgetDuration: "monthly" } }, w.admin),
    ).rejects.toThrow(/30d or 1mo/);
    await expect(saveKeyIssuing(w.gatewayId, {}, w.alice)).rejects.toMatchObject({ status: 403 });
    await db
      .update(modelProviders)
      .set({ tokenSource: "stored" })
      .where(eq(modelProviders.id, w.gatewayId));
    await expect(
      saveKeyIssuing(
        w.gatewayId,
        { modes: { optioIssued: true }, adminKey: litellm.masterKey },
        w.admin,
      ),
    ).rejects.toThrow(/shared token/);
  });
});

describe("a person's key", () => {
  it("Get my token: LiteLLM makes it with the person's email, alias, models and budget; runs use it", async () => {
    const w = await world();
    const before = litellm.callsTo("POST /key/generate").length;
    const r = await issuePersonalKey(w.alice);
    expect(r.action).toBe("issue");
    expect(r.test.ok).toBe(true);
    const call = litellm.callsTo("POST /key/generate")[before];
    const local = w.alice.email.split("@")[0];
    expect(call.body).toMatchObject({
      user_id: w.alice.email,
      key_alias: `optio-${local}`,
      models: ["qwen-internal", "claude-sonnet-internal"],
      max_budget: 5,
      budget_duration: "30d",
      duration: "90d",
    });
    expect(call.auth).toBe(litellm.masterKey);
    const value = await mySecret(w.alice.userId!);
    expect(value).toMatch(/^sk-/);
    expect(r.key).toMatchObject({
      keyAlias: `optio-${local}`,
      keyHint: value!.slice(-4),
      maxBudget: 5,
    });
    const [row] = await db
      .select()
      .from(gatewayIssuedKeys)
      .where(eq(gatewayIssuedKeys.id, r.key.id));
    expect(row.keyHash).toBe(sha(value!));
    expect(JSON.stringify(row)).not.toContain(value!);
    // The person's work runs with it, exactly like a pasted token.
    const gw = await gatewayRow(w.gatewayId);
    expect(
      await resolveGatewayToken({ provider: gw, workspaceId: w.ws, ownerUserId: w.alice.userId }),
    ).toBe(value);
    expect((await myGatewayKeyStatus(w.alice)).issued?.id).toBe(r.key.id);
    // Only the person's own: bob sees none.
    expect((await myGatewayKeyStatus(w.bob)).issued).toBeNull();
    const entry = await waitForAction("gateway_key.issue", w.ws);
    expect(entry.params).toMatchObject({ scope: "user", keyAlias: `optio-${local}`, maxBudget: 5 });
  });

  it("Rotate: a new key under the same alias, the old one deleted in LiteLLM", async () => {
    const w = await world();
    const first = await issuePersonalKey(w.alice);
    const oldValue = (await mySecret(w.alice.userId!))!;
    const second = await issuePersonalKey(w.alice, { rotate: true });
    expect(second.action).toBe("rotate");
    const newValue = (await mySecret(w.alice.userId!))!;
    expect(newValue).not.toBe(oldValue);
    expect(litellm.keys.has(sha(oldValue))).toBe(false);
    expect(litellm.keys.get(sha(newValue))?.alias).toBe(first.key.keyAlias);
    const [old] = await db
      .select()
      .from(gatewayIssuedKeys)
      .where(eq(gatewayIssuedKeys.id, first.key.id));
    expect(old).toMatchObject({ status: "revoked", revokedReason: "rotated" });
    await expect(issuePersonalKey(w.bob, { rotate: true })).rejects.toMatchObject({ status: 404 });
  });

  it("a new key keeps what the old one spent this period: Rotate, or Give up then Get my token", async () => {
    const w = await world();
    await issuePersonalKey(w.alice);
    const v1 = (await mySecret(w.alice.userId!))!;
    litellm.setSpend(sha(v1), 3.25);
    const rotated = await issuePersonalKey(w.alice, { rotate: true });
    const v2 = (await mySecret(w.alice.userId!))!;
    expect(litellm.callsTo("POST /key/generate").at(-1)?.body).toMatchObject({ spend: 3.25 });
    expect(litellm.keys.get(sha(v2))?.spend).toBe(3.25);
    expect(rotated.key.spendUsd).toBe(3.25);

    // Given up: its last spend is kept on the row, and the next key starts there.
    litellm.setSpend(sha(v2), 4);
    await revokePersonalKey(w.alice);
    const [gone] = await db
      .select()
      .from(gatewayIssuedKeys)
      .where(eq(gatewayIssuedKeys.id, rotated.key.id));
    expect(Number(gone.spendUsd)).toBe(4);
    expect(gone.budgetResetAt).not.toBeNull();
    const again = await issuePersonalKey(w.alice);
    expect(again.action).toBe("issue");
    expect(litellm.keys.get(sha((await mySecret(w.alice.userId!))!))?.spend).toBe(4);
    // Each amount keeps the end of the period it was spent in: the first
    // key's 3.25, and the 0.75 the second key spent itself.
    const carried = (await issuedRow(again.key.id)).carriedSpend ?? [];
    expect(carried.map((c) => c.usd)).toEqual([3.25, 0.75]);
    expect(carried.every((c) => c.until && Date.parse(c.until) > Date.now())).toBe(true);

    // Once those periods are over, a new key starts at nothing.
    await revokePersonalKey(w.alice);
    const admin = { base: litellm.url, adminKey: litellm.masterKey };
    expect(
      await spendToCarry(admin, w.gatewayId, w.alice.userId!, new Date(Date.now() + 31 * DAY)),
    ).toEqual([]);
    await db
      .update(gatewayIssuedKeys)
      .set({ budgetResetAt: new Date(Date.now() - 60_000), carriedSpend: null })
      .where(eq(gatewayIssuedKeys.id, again.key.id));
    await issuePersonalKey(w.alice);
    expect(litellm.callsTo("POST /key/generate").at(-1)?.body).not.toHaveProperty("spend");
  });

  it("a carried amount comes off once its period is over, so rotating never piles spend up", async () => {
    const w = await world();
    await issuePersonalKey(w.alice);
    const v1 = (await mySecret(w.alice.userId!))!;
    // The first key's period ends in ten days; it has spent 4.9 of 5.
    const firstReset = new Date(Date.now() + 10 * DAY);
    litellm.keys.get(sha(v1))!.budgetResetAt = firstReset.toISOString();
    litellm.setSpend(sha(v1), 4.9);
    const second = await issuePersonalKey(w.alice, { rotate: true });
    const v2 = (await mySecret(w.alice.userId!))!;
    expect(litellm.keys.get(sha(v2))?.spend).toBe(4.9);
    expect((await issuedRow(second.key.id)).carriedSpend).toEqual([
      { usd: 4.9, until: firstReset.toISOString() },
    ]);
    litellm.setSpend(sha(v2), 5); // 0.1 of it the new key's own

    // Before the first key's period ends, nothing comes off.
    await checkGatewayKeys({ force: true, now: new Date(firstReset.getTime() - 60_000) });
    expect(litellm.keys.get(sha(v2))?.spend).toBe(5);
    // After, the 4.9 does; the new key keeps only what it spent itself.
    await checkGatewayKeys({ force: true, now: new Date(firstReset.getTime() + 60_000) });
    expect(litellm.keys.get(sha(v2))?.spend).toBeCloseTo(0.1);
    const row = await issuedRow(second.key.id);
    expect(row.carriedSpend).toBeNull();
    expect(Number(row.spendUsd)).toBeCloseTo(0.1);
    expect(
      litellm.callsTo("POST /key/update").some((c) => c.body?.key === sha(v2) && "spend" in c.body),
    ).toBe(true);

    // Rotating again carries only that 0.1, not the 5.
    const third = await issuePersonalKey(w.alice, { rotate: true });
    const v3 = (await mySecret(w.alice.userId!))!;
    expect(litellm.keys.get(sha(v3))?.spend).toBeCloseTo(0.1);
    expect((await issuedRow(third.key.id)).carriedSpend?.map((c) => c.usd)).toEqual([
      expect.closeTo(0.1, 6),
    ]);
  });

  it("an alias someone else's key holds gets a suffix", async () => {
    const w = await world();
    const local = w.alice.email.split("@")[0];
    litellm.keys.set("x".repeat(64), {
      key: "sk-someone",
      hash: "x".repeat(64),
      alias: `optio-${local}`,
      userId: null,
      teamId: null,
      models: [],
      maxBudget: null,
      budgetDuration: null,
      duration: null,
      spend: 0,
      blocked: false,
      metadata: {},
    });
    const r = await issuePersonalKey(w.alice);
    expect(r.key.keyAlias).toMatch(
      new RegExp(`^optio-${local.replace(/\./g, "\\.")}-[0-9a-f]{4}$`),
    );
    litellm.keys.delete("x".repeat(64));
  });

  it("is refused while the gateway doesn't make keys, and says LiteLLM's reason", async () => {
    const w = await world({ issuing: false });
    await expect(issuePersonalKey(w.alice)).rejects.toThrow(/doesn't make keys/);
    const w2 = await world();
    litellm.failNext("POST /key/generate", 400, "Budget exceeds the user's max");
    await expect(issuePersonalKey(w2.alice)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("Budget exceeds"),
    });
    expect(await mySecret(w2.alice.userId!)).toBeNull();
  });

  it("revoke: deleted in LiteLLM, gone from the person's tokens", async () => {
    const w = await world();
    await issuePersonalKey(w.alice);
    const value = (await mySecret(w.alice.userId!))!;
    await revokePersonalKey(w.alice);
    expect(litellm.keys.has(sha(value))).toBe(false);
    expect(await mySecret(w.alice.userId!)).toBeNull();
    await expect(revokePersonalKey(w.alice)).rejects.toMatchObject({ status: 404 });
    await waitForAction("gateway_key.revoke", w.ws);
  });
});

describe("models the catalog stopped serving", () => {
  it("saving still works with one picked, new keys leave it out, and all gone is refused", async () => {
    const w = await world();
    const both = ["qwen-internal", "claude-sonnet-internal"];
    await saveKeyIssuing(w.gatewayId, { defaults: { models: both } }, w.admin);
    // A catalog sync flags one as no longer served.
    const flag = (missing: string[]) =>
      db
        .update(modelProviders)
        .set({
          models: { "claude-code": both.map((id) => ({ id, missing: missing.includes(id) })) },
        })
        .where(eq(modelProviders.id, w.gatewayId));
    await flag(["claude-sonnet-internal"]);
    const s = await getKeyIssuing(w.gatewayId, w.admin);
    expect(s.catalogModels).toEqual(["qwen-internal"]);
    expect(s.staleModels).toEqual(["claude-sonnet-internal"]);
    expect(s.defaults.models).toEqual(both);

    // The form sends the picks it shows; saving another field still works.
    const saved = await saveKeyIssuing(
      w.gatewayId,
      { defaults: { maxBudget: 7, models: s.defaults.models } },
      w.admin,
    );
    expect(saved.settings.defaults).toMatchObject({ maxBudget: 7, models: both });
    // A new pick must still be one the catalog serves.
    await expect(
      saveKeyIssuing(w.gatewayId, { defaults: { models: [...both, "gpt-9"] } }, w.admin),
    ).rejects.toThrow(/Not in the gateway's catalog: gpt-9/);

    // A new key gets only what is served.
    await issuePersonalKey(w.alice);
    expect(litellm.callsTo("POST /key/generate").at(-1)?.body?.models).toEqual(["qwen-internal"]);

    // Unticked, it is gone; and it can't be picked again while not served.
    const unticked = await saveKeyIssuing(
      w.gatewayId,
      { defaults: { models: ["qwen-internal"] } },
      w.admin,
    );
    expect(unticked.settings.staleModels).toEqual([]);
    await expect(
      saveKeyIssuing(w.gatewayId, { defaults: { models: both } }, w.admin),
    ).rejects.toThrow(/claude-sonnet-internal/);

    // Every pick gone: refused, rather than a key for every model.
    await flag(both);
    const before = litellm.callsTo("POST /key/generate").length;
    await expect(issuePersonalKey(w.bob)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("picks again"),
    });
    await expect(createTeamKey(w.teamId, w.carol)).rejects.toMatchObject({ status: 409 });
    expect(litellm.callsTo("POST /key/generate").length).toBe(before);
  });
});

describe("pasting", () => {
  it("is refused for people and teams only when the gateway takes Optio's keys alone", async () => {
    const w = await world();
    expect(await pastedTokenRefusal("ANTHROPIC_AUTH_TOKEN", "user", w.ws)).toBeNull();
    await saveKeyIssuing(w.gatewayId, { modes: { personalPasted: false } }, w.admin);
    expect(await pastedTokenRefusal("ANTHROPIC_AUTH_TOKEN", "user", w.ws)).toMatch(/Get my token/);
    expect(await pastedTokenRefusal(null, "user", w.ws)).toMatch(/Get my token/);
    expect(await pastedTokenRefusal("ANTHROPIC_AUTH_TOKEN", "team", w.ws)).toMatch(
      /Create team key/,
    );
    // The organization's token, and other secrets, are not pasted tokens.
    expect(await pastedTokenRefusal("ANTHROPIC_AUTH_TOKEN", "global", w.ws)).toBeNull();
    expect(await pastedTokenRefusal("GITLAB_TOKEN", "user", w.ws)).toBeNull();
    // Optio's own key still goes in.
    expect((await issuePersonalKey(w.alice)).action).toBe("issue");
  });
});

describe("deactivation", () => {
  it("revokeIssuedGatewayKeys blocks the key in LiteLLM and removes the token", async () => {
    const w = await world();
    await issuePersonalKey(w.bob);
    const value = (await mySecret(w.bob.userId!))!;
    const r = await revokeIssuedGatewayKeys(w.bob.userId!, { workspaceId: w.ws, reason: "left" });
    expect(r).toEqual({ revoked: 1, failed: 0 });
    expect(litellm.keys.get(sha(value))?.blocked).toBe(true);
    expect(await mySecret(w.bob.userId!)).toBeNull();
    const entry = await waitForAction("gateway_key.revoke", w.ws);
    expect(entry.userId).toBeNull();
    expect(entry.params).toMatchObject({ targetUserId: w.bob.userId, reason: "left" });
  });

  it("disabling an account (offboarding) blocks the keys Optio made for them", async () => {
    const w = await world();
    await issuePersonalKey(w.bob);
    const value = (await mySecret(w.bob.userId!))!;
    const account = await disableUser(w.bob.userId!, { reason: "gone" });
    expect(account?.revokedGatewayKeys).toBe(1);
    expect(litellm.keys.get(sha(value))?.blocked).toBe(true);
    expect(await mySecret(w.bob.userId!)).toBeNull();
  });

  it("deletes the key where LiteLLM has no /key/block", async () => {
    const w = await world();
    await issuePersonalKey(w.alice);
    const value = (await mySecret(w.alice.userId!))!;
    const fake = await startFakeLiteLLM({ masterKey: litellm.masterKey });
    fake.disable("POST /key/block");
    fake.keys.set(sha(value), { ...litellm.keys.get(sha(value))! });
    await db
      .update(modelProviders)
      .set({ baseUrl: fake.url })
      .where(eq(modelProviders.id, w.gatewayId));
    const r = await revokeIssuedGatewayKeys(w.alice.userId!);
    expect(r.revoked).toBe(1);
    expect(fake.keys.has(sha(value))).toBe(false);
    await fake.close();
  });

  it("a LiteLLM that can't be reached leaves the key active for the next check", async () => {
    const w = await world();
    const issued = await issuePersonalKey(w.alice);
    await db
      .update(modelProviders)
      .set({ baseUrl: "http://127.0.0.1:9" })
      .where(eq(modelProviders.id, w.gatewayId));
    const r = await revokeIssuedGatewayKeys(w.alice.userId!);
    expect(r).toEqual({ revoked: 0, failed: 1 });
    const [row] = await db
      .select()
      .from(gatewayIssuedKeys)
      .where(eq(gatewayIssuedKeys.id, issued.key.id));
    expect(row.status).toBe("active");
  });

  it("deleting the gateway deletes its keys in LiteLLM first, and the tokens that held them", async () => {
    const w = await world();
    await issuePersonalKey(w.alice);
    const value = (await mySecret(w.alice.userId!))!;
    expect(await revokeProviderKeys(w.gatewayId, w.alice)).toEqual({ revoked: 0, refusal: null });
    expect(litellm.keys.has(sha(value))).toBe(true);
    expect(await revokeProviderKeys(w.gatewayId, w.admin)).toEqual({ revoked: 1, refusal: null });
    expect(litellm.keys.has(sha(value))).toBe(false);
    expect(await mySecret(w.alice.userId!)).toBeNull();
    const entry = await waitForAction("gateway_key.revoke", w.ws);
    expect(entry.params).toMatchObject({
      targetUserId: w.alice.userId,
      reason: "gateway removed",
    });
  });

  it("deleting the gateway is refused while LiteLLM can't delete its keys, unless forced", async () => {
    const w = await world();
    await issuePersonalKey(w.alice);
    await createTeamKey(w.teamId, w.carol);
    const value = (await mySecret(w.alice.userId!))!;
    const teamValue = (await teamSecret(w.ws, w.teamId))!;
    const keysOf = () =>
      db.select().from(gatewayIssuedKeys).where(eq(gatewayIssuedKeys.providerId, w.gatewayId));

    litellm.failNext("POST /key/delete", 500, "database is down");
    const refused = await revokeProviderKeys(w.gatewayId, w.admin);
    expect(refused.revoked).toBe(0);
    expect(refused.refusal).toMatch(/couldn't delete the 2 keys it made on LiteLLM/);
    expect(refused.refusal).toMatch(/database is down/);
    // Nothing changed: the keys, the tokens and the rows are as they were.
    expect(litellm.keys.has(sha(value)) && litellm.keys.has(sha(teamValue))).toBe(true);
    expect(await mySecret(w.alice.userId!)).toBe(value);
    expect((await keysOf()).every((r) => r.status === "active")).toBe(true);

    // No admin key stored: the same.
    const sealed = await gatewayRow(w.gatewayId);
    await db
      .update(modelProviders)
      .set({ encryptedAdminKey: null })
      .where(eq(modelProviders.id, w.gatewayId));
    expect((await revokeProviderKeys(w.gatewayId, w.admin)).refusal).toMatch(
      /no LiteLLM admin key/,
    );
    await db
      .update(modelProviders)
      .set({ encryptedAdminKey: sealed.encryptedAdminKey })
      .where(eq(modelProviders.id, w.gatewayId));

    // Forced: it goes on, the tokens go, and the trail says the keys are still in LiteLLM.
    litellm.failNext("POST /key/delete", 500, "database is down");
    expect(await revokeProviderKeys(w.gatewayId, w.admin, { force: true })).toEqual({
      revoked: 2,
      refusal: null,
    });
    expect(await mySecret(w.alice.userId!)).toBeNull();
    expect(await teamSecret(w.ws, w.teamId)).toBeNull();
    const rows = await keysOf();
    expect(rows.map((r) => [r.status, r.revokedReason])).toEqual([
      ["revoked", "gateway removed; still in LiteLLM"],
      ["revoked", "gateway removed; still in LiteLLM"],
    ]);
    const entry = await waitForAction("gateway_key.revoke", w.ws);
    expect(entry.params).toMatchObject({ reason: "gateway removed; still in LiteLLM" });
    // The keys are still in LiteLLM; someone deletes them there (the later
    // tests want the aliases free).
    expect(rows.every((r) => litellm.keys.has(r.keyHash))).toBe(true);
    for (const r of rows) litellm.keys.delete(r.keyHash);
  });
});

describe("a team's key and budget", () => {
  it("a team admin creates it: a LiteLLM team with the budget, a key bound to it, the team's token", async () => {
    const w = await world();
    const r = await createTeamKey(w.teamId, w.carol, { maxBudget: 20, budgetDuration: "1mo" });
    expect(r.action).toBe("issue");
    const teamCall = litellm.callsTo("POST /team/new").at(-1)!;
    expect(teamCall.body).toMatchObject({
      team_alias: "optio-platform",
      max_budget: 20,
      budget_duration: "1mo",
      models: ["qwen-internal", "claude-sonnet-internal"],
    });
    const keyCall = litellm.callsTo("POST /key/generate").at(-1)!;
    expect(keyCall.body).toMatchObject({ key_alias: "optio-team-platform" });
    const litellmTeam = keyCall.body?.team_id as string;
    expect(litellm.teams.get(litellmTeam)?.maxBudget).toBe(20);
    const value = await retrieveSecret("ANTHROPIC_AUTH_TOKEN", "team", w.ws, undefined, w.teamId);
    const gw = await gatewayRow(w.gatewayId);
    expect(
      await resolveGatewayToken({
        provider: gw,
        workspaceId: w.ws,
        ownerUserId: w.bob.userId,
        ownerTeamId: w.teamId,
      }),
    ).toBe(value);
    await waitForAction("team_key.create", w.ws);
    const status = await teamGatewayKeyStatus(w.teamId, w.bob);
    expect(status).toMatchObject({
      canManage: false,
      hasToken: true,
      issued: { keyAlias: "optio-team-platform" },
      budget: { maxBudget: 20, spend: 0, source: "gateway" },
    });

    // Rotating keeps the LiteLLM team.
    const before = litellm.callsTo("POST /team/new").length;
    const rotated = await createTeamKey(w.teamId, w.admin);
    expect(rotated.action).toBe("rotate");
    expect(litellm.callsTo("POST /team/new").length).toBe(before);
    expect(litellm.callsTo("POST /key/generate").at(-1)!.body?.team_id).toBe(litellmTeam);
    expect(litellm.keys.has(sha(value))).toBe(false);
  });

  it("only the team's admins and workspace admins change it; others don't see it", async () => {
    const w = await world();
    await expect(createTeamKey(w.teamId, w.bob)).rejects.toMatchObject({ status: 403 });
    await expect(createTeamKey(w.teamId, w.outsider)).rejects.toMatchObject({ status: 404 });
    await expect(teamGatewayKeyStatus(w.teamId, w.alice)).rejects.toMatchObject({ status: 404 });
    await expect(teamGatewayKeyStatus(w.teamId, w.outsider)).rejects.toMatchObject({ status: 404 });
    expect((await teamGatewayKeyStatus(w.teamId, w.admin)).canManage).toBe(true);
  });

  it("a team admin's budget is capped by the gateway's team budget; a workspace admin's isn't", async () => {
    const w = await world();
    await expect(createTeamKey(w.teamId, w.carol, { maxBudget: 51 })).rejects.toMatchObject({
      status: 403,
    });
    await expect(createTeamKey(w.teamId, w.carol, { maxBudget: null })).rejects.toBeInstanceOf(
      GatewayKeyError,
    );
    await createTeamKey(w.teamId, w.carol);
    const t = [...litellm.teams.values()].at(-1)!;
    expect(t.maxBudget).toBe(50);
    await expect(setTeamBudget(w.teamId, w.carol, { maxBudget: 80 })).rejects.toMatchObject({
      status: 403,
    });
    const budget = await setTeamBudget(w.teamId, w.admin, { maxBudget: 80 });
    expect(budget).toMatchObject({ maxBudget: 80, source: "gateway" });
    expect(t.maxBudget).toBe(80);
    const entry = await waitForAction("budget.set", w.ws, (p) => p.maxBudget === 80);
    expect(entry.params).toMatchObject({ scope: "team", teamId: w.teamId, maxBudget: 80 });

    // Above the cap by a workspace admin's hand, the team admin still rotates
    // (Rotate sends no budget), changes only the period, and may lower it —
    // but not raise it past the cap again.
    const rotated = await createTeamKey(w.teamId, w.carol);
    expect(rotated).toMatchObject({ action: "rotate", budget: { maxBudget: 80 } });
    expect(t.maxBudget).toBe(80);
    expect(
      await setTeamBudget(w.teamId, w.carol, { maxBudget: 80, budgetDuration: "7d" }),
    ).toMatchObject({ maxBudget: 80, budgetDuration: "7d" });
    expect(await setTeamBudget(w.teamId, w.carol, { maxBudget: 70 })).toMatchObject({
      maxBudget: 70,
    });
    await expect(setTeamBudget(w.teamId, w.carol, { maxBudget: 75 })).rejects.toMatchObject({
      status: 403,
    });
    await expect(setTeamBudget(w.teamId, w.carol, { maxBudget: null })).rejects.toMatchObject({
      status: 403,
    });
    // With no cap at all (a workspace admin's null), the same.
    await setTeamBudget(w.teamId, w.admin, { maxBudget: null });
    expect((await createTeamKey(w.teamId, w.carol)).action).toBe("rotate");
    expect(await setTeamBudget(w.teamId, w.carol, { maxBudget: 40 })).toMatchObject({
      maxBudget: 40,
    });
  });

  it("a LiteLLM team someone removed is made again when the key is rotated", async () => {
    const w = await world();
    await createTeamKey(w.teamId, w.carol, { maxBudget: 20 });
    const first = litellm.callsTo("POST /key/generate").at(-1)!.body?.team_id as string;
    litellm.teams.delete(first);
    // What Rotate sends: no budget.
    const rotated = await createTeamKey(w.teamId, w.carol);
    expect(rotated.action).toBe("rotate");
    const second = litellm.callsTo("POST /key/generate").at(-1)!.body?.team_id as string;
    expect(second).not.toBe(first);
    expect(litellm.teams.get(second)).toMatchObject({ maxBudget: 20, alias: "optio-platform" });
    expect((await activeTeamRow(w.teamId)).litellmTeamId).toBe(second);
    const value = (await teamSecret(w.ws, w.teamId))!;
    expect(litellm.keys.get(sha(value))?.teamId).toBe(second);
  });
});

describe("the housekeeping check", () => {
  it("blocks the key of someone who left the workspace, deletes one replaced by a pasted token", async () => {
    const w = await world();
    await issuePersonalKey(w.alice);
    await issuePersonalKey(w.bob);
    const aliceKey = (await mySecret(w.alice.userId!))!;
    const bobKey = (await mySecret(w.bob.userId!))!;
    await db
      .delete(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, w.ws), eq(workspaceMembers.userId, w.alice.userId!)),
      );
    await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-bob-pasted", "user", null, w.bob.userId);
    const r = await checkGatewayKeys({ force: true });
    expect(r.revoked).toBeGreaterThanOrEqual(2);
    expect(litellm.keys.get(sha(aliceKey))?.blocked).toBe(true);
    expect(litellm.keys.has(sha(bobKey))).toBe(false);
    // bob's own pasted token stays.
    expect(await mySecret(w.bob.userId!)).toBe("sk-bob-pasted");
  });

  it("blocks the key of an owner who was disabled", async () => {
    const w = await world();
    await issuePersonalKey(w.alice);
    const value = (await mySecret(w.alice.userId!))!;
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, w.alice.userId!));
    const r = await checkGatewayKeys({ force: true });
    expect(r.revoked).toBeGreaterThanOrEqual(1);
    expect(litellm.keys.get(sha(value))?.blocked).toBe(true);
  });

  it("a token it can't read is a failed check, never a replaced one: the keys stay", async () => {
    const w = await world();
    await issuePersonalKey(w.alice);
    await createTeamKey(w.teamId, w.carol);
    const value = (await mySecret(w.alice.userId!))!;
    const teamValue = (await teamSecret(w.ws, w.teamId))!;
    // The stored values stop decrypting (as when OPTIO_ENCRYPTION_KEY changed).
    const stored = await db
      .select({ id: secrets.id, authTag: secrets.authTag })
      .from(secrets)
      .where(
        and(
          eq(secrets.name, "ANTHROPIC_AUTH_TOKEN"),
          or(eq(secrets.userId, w.alice.userId!), eq(secrets.teamId, w.teamId)),
        ),
      );
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      await db
        .update(secrets)
        .set({ authTag: Buffer.alloc(16, 7) })
        .where(eq(secrets.id, row.id));
    }

    const r = await checkGatewayKeys({ force: true });
    expect(r.failed).toBeGreaterThanOrEqual(2);
    expect(litellm.keys.get(sha(value))).toMatchObject({ blocked: false });
    expect(litellm.keys.has(sha(teamValue))).toBe(true);
    const rows = await db
      .select()
      .from(gatewayIssuedKeys)
      .where(
        or(eq(gatewayIssuedKeys.userId, w.alice.userId!), eq(gatewayIssuedKeys.teamId, w.teamId)),
      );
    expect(rows.map((x) => x.status)).toEqual(["active", "active"]);
    // Revoking stops before LiteLLM too, and says it failed.
    expect(await revokeIssuedGatewayKeys(w.alice.userId!, { workspaceId: w.ws })).toEqual({
      revoked: 0,
      failed: 1,
    });
    expect(litellm.keys.get(sha(value))?.blocked).toBe(false);

    // Readable again: the next check leaves them be.
    for (const row of stored) {
      await db.update(secrets).set({ authTag: row.authTag }).where(eq(secrets.id, row.id));
    }
    await checkGatewayKeys({ force: true });
    expect(await mySecret(w.alice.userId!)).toBe(value);
    expect(litellm.keys.has(sha(value)) && litellm.keys.has(sha(teamValue))).toBe(true);
  });

  it("warns the owner at 80% and at 100% of a key's budget, once each per period", async () => {
    const w = await world();
    const issued = await issuePersonalKey(w.alice);
    const hash = sha((await mySecret(w.alice.userId!))!);
    litellm.setSpend(hash, 4.2);
    await checkGatewayKeys({ force: true });
    const warnings = mail.sent.filter((m) => m.to[0] === w.alice.email);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].subject).toMatch(/80% of its budget/);
    expect(warnings[0].text).toContain("4.20 USD of 5.00 USD");
    await checkGatewayKeys({ force: true });
    expect(mail.sent.filter((m) => m.to[0] === w.alice.email)).toHaveLength(1);
    litellm.setSpend(hash, 5.01);
    await checkGatewayKeys({ force: true });
    const all = mail.sent.filter((m) => m.to[0] === w.alice.email);
    expect(all).toHaveLength(2);
    expect(all[1].subject).toMatch(/whole budget/);
    const [row] = await db
      .select()
      .from(gatewayIssuedKeys)
      .where(eq(gatewayIssuedKeys.id, issued.key.id));
    expect(row).toMatchObject({ warnedLevel: 100, spendUsd: "5.01" });
  });

  it("warns a team's admins (not its members) about the team's budget", async () => {
    const w = await world();
    await createTeamKey(w.teamId, w.carol, { maxBudget: 10 });
    const t = [...litellm.teams.values()].at(-1)!;
    litellm.setSpend(t.id, 8.5);
    await checkGatewayKeys({ force: true });
    const [carol] = await db.select().from(users).where(eq(users.id, w.carol.userId!));
    const sent = mail.sent.filter((m) => /Platform has used 80%/.test(m.subject));
    expect(sent.map((m) => m.to[0])).toEqual([carol.email]);
  });

  it("starts the warnings over in a new budget period", () => {
    const spend = { spend: 9, maxBudget: 10, budgetResetAt: "2026-12-01T00:00:00Z" };
    expect(warningDue({ warnedLevel: 80, warnedPeriod: "2026-12-01T00:00:00Z" }, spend).level).toBe(
      null,
    );
    expect(
      warningDue({ warnedLevel: 100, warnedPeriod: "2026-11-01T00:00:00Z" }, spend).level,
    ).toBe(80);
    expect(
      warningDue({ warnedLevel: 0, warnedPeriod: null }, { ...spend, maxBudget: null }).level,
    ).toBe(null);
  });
});

describe("usage per team", () => {
  it("charges team-owned work to its team; members see their teams, admins all", async () => {
    const w = await world();
    const task = await insertTask({
      workspaceId: w.ws,
      ownerTeamId: w.teamId,
      ownerUserId: w.bob.userId,
    });
    const other = await insertTask({ workspaceId: w.ws, ownerUserId: w.alice.userId });
    await db.execute(
      // Two ledger rows of the team's run, one of alice's own.
      sql`INSERT INTO usage_ledger
        (source_kind, source_id, workspace_id, owner_user_id, subject_id, subject_kind, subject_name, work_id, work_name, href, input_tokens, output_tokens, cost_usd, cost_basis)
        VALUES
        ('tasks', ${task.id}::uuid, ${w.ws}::uuid, ${w.bob.userId}::uuid, ${w.bob.userId}::uuid, 'person', 'bob', ${task.id}::uuid, 'team run', '/tasks/x', 100, 50, 0.5, 'estimated'),
        ('tasks', ${task.id}::uuid, ${w.ws}::uuid, ${w.bob.userId}::uuid, ${w.bob.userId}::uuid, 'person', 'bob', ${task.id}::uuid, 'team run', '/tasks/x', 10, 5, 0.25, 'estimated'),
        ('tasks', ${other.id}::uuid, ${w.ws}::uuid, ${w.alice.userId}::uuid, ${w.alice.userId}::uuid, 'person', 'alice', ${other.id}::uuid, 'own run', '/tasks/y', 1000, 1000, 9, 'estimated')`,
    );
    await createTeamKey(w.teamId, w.carol, { maxBudget: 10 });

    const asBob = await teamUsage(w.bob, 30);
    expect(asBob.teams).toEqual([
      expect.objectContaining({
        teamId: w.teamId,
        name: "Platform",
        tokens: 165,
        costUsd: "0.75",
        runs: 1,
        gatewayBudget: expect.objectContaining({ maxBudget: 10 }),
      }),
    ]);
    expect((await teamUsage(w.alice, 30)).teams).toEqual([]);
    const asAdmin = await teamUsage(w.admin, 30);
    expect(asAdmin.teams.map((t) => t.name)).toEqual(["Platform", "Data"]);
    expect(asAdmin.teams[1]).toMatchObject({
      tokens: 0,
      costUsd: null,
      runs: 0,
      gatewayBudget: null,
    });
  });
});
