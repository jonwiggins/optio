/**
 * Gateway keys made by Optio (services/gateway-keys.ts, gateway-key-check.ts)
 * against real Postgres and in-process gateways (test-utils/fake-litellm.ts,
 * fake-openrouter.ts): the admin's modes and admin key, "Get my token",
 * Rotate with spend carried over, revoking, removal from the workspace, the
 * housekeeping check, and what a gateway's type or URL change does.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  gatewayIssuedKeys,
  modelProviders,
  secrets,
  users,
  workspaceMembers,
} from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { startFakeLiteLLM, type FakeLiteLLM } from "../test-utils/fake-litellm.js";
import { startFakeOpenRouter, type FakeOpenRouter } from "../test-utils/fake-openrouter.js";
import { setOutboundDefaults } from "../utils/outbound-url.js";
import {
  createModelProvider,
  deleteModelProvider,
  getModelProviderRow,
  resolveProviderForWork,
  updateModelProvider,
  type ProviderViewer,
} from "./model-provider-service.js";
import {
  personalGatewayToken,
  resolveGatewayToken,
  storePersonalGatewayToken,
} from "./model-gateway-service.js";
import { storeSecret } from "./secret-service.js";
import {
  GatewayKeyError,
  adminKeyOf,
  adminRevokeKey,
  getKeyIssuing,
  issuePersonalKey,
  listIssuedKeys,
  myGatewayKeyStatus,
  revokePersonalKey,
  saveKeyIssuing,
} from "./gateway-keys.js";
import { checkGatewayKeys } from "./gateway-key-check.js";
import { removeMember } from "./workspace-service.js";

const uniq = () => randomBytes(4).toString("hex");
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

let litellm: FakeLiteLLM;
let openrouter: FakeOpenRouter;
let restoreOutbound: () => void;

beforeAll(async () => {
  [litellm, openrouter] = await Promise.all([
    startFakeLiteLLM({ masterKey: "sk-master" }),
    startFakeOpenRouter({ managementKey: "sk-or-mgmt" }),
  ]);
  // The fakes listen on loopback: allowed explicitly, as an admin would.
  restoreOutbound = setOutboundDefaults({
    policy: { allowPrivate: false, allowedHosts: ["127.0.0.1"], allowAll: false },
  });
});

afterAll(async () => {
  restoreOutbound();
  await Promise.all([litellm.close(), openrouter.close()]);
});

async function person(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "google",
      externalId: uniq(),
      email: `${name}.${uniq()}@example.com`,
      displayName: name,
    })
    .returning();
  return row;
}

describe("gateway keys Optio makes", () => {
  let ws: string;
  let admin: ProviderViewer;
  let alice: ProviderViewer & { email: string };
  let bob: ProviderViewer;

  beforeEach(async () => {
    ws = (await insertWorkspace()).id;
    const [a, al, b] = await Promise.all(["admin", "alice", "bob"].map(person));
    await db.insert(workspaceMembers).values([
      { workspaceId: ws, userId: a.id, role: "admin" },
      { workspaceId: ws, userId: al.id, role: "member" },
      { workspaceId: ws, userId: b.id, role: "member" },
    ]);
    admin = { workspaceId: ws, userId: a.id, isAdmin: true };
    alice = { workspaceId: ws, userId: al.id, isAdmin: false, email: al.email! };
    bob = { workspaceId: ws, userId: b.id, isAdmin: false };
  });

  afterEach(() => {
    litellm.keys.clear();
    litellm.calls.length = 0;
    openrouter.keys.clear();
    openrouter.calls.length = 0;
  });

  const liteGateway = async (extra: Record<string, unknown> = {}) =>
    createModelProvider(
      {
        name: "Corp LiteLLM",
        owner: "workspace",
        kind: "gateway",
        gatewayType: "litellm",
        agents: ["claude-code"],
        baseUrl: litellm.url,
        models: { "claude-code": [{ id: "qwen-internal" }, { id: "claude-sonnet-internal" }] },
        ...extra,
      },
      admin,
    );

  const issuing = async (providerId: string, defaults: Record<string, unknown> = {}) =>
    saveKeyIssuing(
      providerId,
      {
        modes: { optioIssued: true },
        adminKey: "sk-master",
        defaults: { maxBudget: 10, budgetDuration: "30d", keyDuration: "90d", ...defaults },
      },
      admin,
    );

  const rowOf = async (id: string, ownerUserId: string) =>
    (await resolveProviderForWork({
      agentType: "claude-code",
      agentOptions: { modelProvider: id },
      workspaceId: ws,
      ownerUserId,
      runsOn: "pod",
    }))!;

  it("lets only admins set it up, never returns the admin key, and tries it", async () => {
    const g = await liteGateway();
    await expect(getKeyIssuing(g.id, alice)).rejects.toMatchObject({ status: 403 });
    await expect(saveKeyIssuing(g.id, { modes: { optioIssued: true } }, admin)).rejects.toThrow(
      /Add the LiteLLM admin key/,
    );
    const saved = await issuing(g.id);
    expect(saved.adminKeyTest).toEqual({ ok: true });
    expect(saved.changed).toEqual(
      expect.arrayContaining(["optioIssued", "adminKey", "maxBudget", "keyDuration"]),
    );
    expect(JSON.stringify(saved.settings)).not.toContain("sk-master");
    expect(saved.settings).toMatchObject({ hasAdminKey: true, modes: { optioIssued: true } });
    // A wrong admin key is kept, and the test says so.
    const wrong = await saveKeyIssuing(g.id, { adminKey: "sk-nope" }, admin);
    expect(wrong.adminKeyTest).toMatchObject({ ok: false });
    await issuing(g.id);

    // Types without managed keys, and a gateway with one shared token, refuse.
    const portkey = await createModelProvider(
      {
        name: "Portkey",
        owner: "workspace",
        kind: "gateway",
        gatewayType: "portkey",
        agents: ["claude-code"],
        baseUrl: "https://api.portkey.ai",
      },
      admin,
    );
    await expect(issuing(portkey.id)).rejects.toThrow(/doesn't make keys on Portkey/);
    const shared = await liteGateway({
      tokenSource: "stored",
      credentials: { type: "bearer-token", bearerToken: "s" },
    });
    await expect(issuing(shared.id)).rejects.toThrow(/one shared token/);
  });

  it("makes a person's key with the admin's budget and models, stored as their gateway token", async () => {
    const g = await liteGateway();
    await expect(issuePersonalKey(alice, { providerId: g.id })).rejects.toThrow(
      /doesn't make keys/,
    );
    await issuing(g.id);
    const res = await issuePersonalKey(alice, { providerId: g.id });
    expect(res.action).toBe("issue");
    expect(JSON.stringify(res)).not.toMatch(/sk-[0-9a-f]{24}/);
    const [fake] = [...litellm.keys.values()];
    expect(fake).toMatchObject({
      alias: `optio-${alice.email.split("@")[0]}`,
      userId: alice.email,
      models: ["qwen-internal", "claude-sonnet-internal"],
      maxBudget: 10,
      budgetDuration: "30d",
      duration: "90d",
      spend: 0,
    });
    expect(res.key).toMatchObject({ keyHint: fake.key.slice(-4), maxBudget: 10 });
    // The run reads it the way it reads a pasted token: through the consent.
    const row = await rowOf(g.id, alice.userId!);
    expect(
      await resolveGatewayToken({ provider: row, workspaceId: ws, ownerUserId: alice.userId }),
    ).toBe(fake.key);
    // Only the key's hash is kept.
    const [issued] = await db
      .select()
      .from(gatewayIssuedKeys)
      .where(eq(gatewayIssuedKeys.providerId, g.id));
    expect(issued.keyHash).toBe(sha(fake.key));
    expect(JSON.stringify(issued)).not.toContain(fake.key);

    // Bob sees his own status only; the admin's list names Alice, never a value.
    expect((await myGatewayKeyStatus(bob, g.id)).issued).toBeNull();
    await expect(listIssuedKeys(g.id, bob)).rejects.toMatchObject({ status: 403 });
    const listed = await listIssuedKeys(g.id, admin);
    expect(listed).toHaveLength(1);
    expect(listed[0].user?.id).toBe(alice.userId);
    expect(JSON.stringify(listed)).not.toContain(fake.key);
  });

  it("refuses an empty catalog rather than make a key for every model", async () => {
    const g = await liteGateway({ models: { "claude-code": [] } });
    await issuing(g.id);
    await expect(issuePersonalKey(alice, { providerId: g.id })).rejects.toMatchObject({
      status: 409,
    });
    expect(litellm.callsTo("POST /key/generate")).toHaveLength(0);
  });

  it("carries what the old key spent over to the rotated one, and deletes the old one", async () => {
    const g = await liteGateway();
    await issuing(g.id);
    await issuePersonalKey(alice, { providerId: g.id });
    const [first] = [...litellm.keys.values()];
    litellm.setSpend(first.hash, 4);
    const res = await issuePersonalKey(alice, { providerId: g.id, rotate: true });
    expect(res.action).toBe("rotate");
    expect(litellm.keys.has(first.hash)).toBe(false);
    const [second] = [...litellm.keys.values()];
    expect(second.spend).toBe(4);
    expect(second.alias).toBe(first.alias?.replace(/-rotated-.*$/, ""));
    expect(await personalGatewayToken(await rowOf(g.id, alice.userId!), alice.userId)).toBe(
      second.key,
    );
    // Giving it up then getting a new one still carries it.
    await revokePersonalKey(alice, g.id);
    expect(litellm.keys.size).toBe(0);
    expect(await personalGatewayToken(await rowOf(g.id, alice.userId!), alice.userId)).toBeNull();
    await issuePersonalKey(alice, { providerId: g.id });
    expect([...litellm.keys.values()][0].spend).toBe(4);
  });

  it("refuses a pasted token once only Optio-made keys are taken", async () => {
    const g = await liteGateway();
    await issuing(g.id);
    await saveKeyIssuing(g.id, { modes: { personalPasted: false } }, admin);
    await expect(storePersonalGatewayToken(alice, "pasted", g.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(saveKeyIssuing(g.id, { modes: { optioIssued: false } }, admin)).rejects.toThrow(
      /at least one way/,
    );
  });

  it("blocks a key on the gateway when its person leaves the workspace", async () => {
    const g = await liteGateway();
    await issuing(g.id);
    await issuePersonalKey(alice, { providerId: g.id });
    const [fake] = [...litellm.keys.values()];
    await removeMember(ws, alice.userId!);
    expect(fake.blocked).toBe(true);
    expect(await personalGatewayToken(await rowOf(g.id, alice.userId!), alice.userId)).toBeNull();
    const [issued] = await db
      .select()
      .from(gatewayIssuedKeys)
      .where(eq(gatewayIssuedKeys.providerId, g.id));
    expect(issued).toMatchObject({ status: "revoked", revokedReason: "left the workspace" });
  });

  it("the check deletes a key pasted over, and blocks a deleted person's", async () => {
    // (A deleted person's row keeps the key with no owner: ON DELETE SET NULL.)
    const g = await liteGateway();
    await issuing(g.id);
    await issuePersonalKey(alice, { providerId: g.id });
    await issuePersonalKey(bob, { providerId: g.id });
    const [aliceKey, bobKey] = [...litellm.keys.values()];
    // Alice pastes her own over it (both modes are on).
    await storePersonalGatewayToken(alice, "alice-own", g.id);
    await db
      .update(gatewayIssuedKeys)
      .set({ userId: null })
      .where(
        and(eq(gatewayIssuedKeys.providerId, g.id), eq(gatewayIssuedKeys.userId, bob.userId!)),
      );
    await checkGatewayKeys({ force: true });
    expect(litellm.keys.has(aliceKey.hash)).toBe(false);
    expect(bobKey.blocked).toBe(true);
    // Her pasted token stays hers.
    expect(await personalGatewayToken(await rowOf(g.id, alice.userId!), alice.userId)).toBe(
      "alice-own",
    );
  });

  it("an admin revokes one key; a key whose token can't be read is never deleted", async () => {
    const g = await liteGateway();
    await issuing(g.id);
    const res = await issuePersonalKey(alice, { providerId: g.id });
    await expect(adminRevokeKey(g.id, res.key.id, bob)).rejects.toMatchObject({ status: 403 });
    // A token that won't decrypt: the check fails, the key stays.
    await db
      .update(secrets)
      .set({ authTag: Buffer.alloc(16) })
      .where(and(eq(secrets.name, `gateway:${g.id}`), eq(secrets.userId, alice.userId!)));
    expect((await checkGatewayKeys({ force: true })).failed).toBeGreaterThanOrEqual(1);
    expect(litellm.keys.size).toBe(1);
    expect((await listIssuedKeys(g.id, admin)).map((k) => k.id)).toEqual([res.key.id]);
    await storeSecret(`gateway:${g.id}`, "x", "user", null, alice.userId);
    await adminRevokeKey(g.id, res.key.id, admin);
    expect([...litellm.keys.values()][0].blocked).toBe(true);
  });

  it("won't move a gateway with live keys, and its admin key never follows a move", async () => {
    const g = await liteGateway();
    await issuing(g.id);
    await issuePersonalKey(alice, { providerId: g.id });
    await expect(
      updateModelProvider(g.id, { baseUrl: "https://elsewhere.example.com" }, admin),
    ).rejects.toMatchObject({ status: 409 });
    await revokePersonalKey(alice, g.id);
    await updateModelProvider(g.id, { baseUrl: "https://elsewhere.example.com" }, admin);
    const moved = (await getModelProviderRow(g.id))!;
    expect(moved.encryptedAdminKey).toBeNull();
    expect(adminKeyOf(moved)).toBeNull();
    // Even a sealed key copied back is bound to the old URL and reads as none.
    const before = await liteGateway();
    await issuing(before.id);
    const sealed = (await getModelProviderRow(before.id))!;
    await db
      .update(modelProviders)
      .set({
        encryptedAdminKey: sealed.encryptedAdminKey,
        adminKeyIv: sealed.adminKeyIv,
        adminKeyAuthTag: sealed.adminKeyAuthTag,
      })
      .where(eq(modelProviders.id, g.id));
    expect(adminKeyOf((await getModelProviderRow(g.id))!)).toBeNull();
    expect((await getKeyIssuing(g.id, admin)).hasAdminKey).toBe(false);
  });

  it("deletes the keys on the gateway before the gateway, or refuses", async () => {
    const g = await liteGateway();
    await issuing(g.id);
    await issuePersonalKey(alice, { providerId: g.id });
    litellm.failNext("POST /key/delete", 500, "down");
    await expect(deleteModelProvider(g.id, admin)).rejects.toMatchObject({ status: 409 });
    expect(litellm.keys.size).toBe(1);
    await deleteModelProvider(g.id, admin);
    expect(litellm.keys.size).toBe(0);
    expect(await getModelProviderRow(g.id)).toBeNull();
  });

  it("refuses a second key being made at the same time", async () => {
    const g = await liteGateway();
    await issuing(g.id);
    const results = await Promise.allSettled([
      issuePersonalKey(alice, { providerId: g.id }),
      issuePersonalKey(alice, { providerId: g.id }),
    ]);
    const refused = results.filter((r) => r.status === "rejected");
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of refused) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(GatewayKeyError);
    }
    const active = await db
      .select()
      .from(gatewayIssuedKeys)
      .where(and(eq(gatewayIssuedKeys.providerId, g.id), eq(gatewayIssuedKeys.status, "active")));
    expect(active).toHaveLength(1);
  });

  it("makes OpenRouter keys with a limit less what a rotated key spent, and an expiry", async () => {
    const g = await createModelProvider(
      {
        name: "OpenRouter",
        owner: "workspace",
        kind: "gateway",
        gatewayType: "openrouter",
        agents: ["claude-code"],
        baseUrl: openrouter.baseUrl,
        models: { "claude-code": [{ id: "anthropic/claude-sonnet-4.5" }] },
      },
      admin,
    );
    const saved = await saveKeyIssuing(
      g.id,
      {
        modes: { optioIssued: true },
        adminKey: "sk-or-mgmt",
        defaults: { maxBudget: 10, budgetDuration: "30d", keyDuration: "90d" },
      },
      admin,
    );
    // OpenRouter resets monthly at most, and limits no models.
    expect(saved.settings.defaults).toMatchObject({ budgetDuration: "1mo", models: [] });
    await expect(
      saveKeyIssuing(g.id, { defaults: { models: ["anthropic/claude-sonnet-4.5"] } }, admin),
    ).rejects.toThrow(/can't be limited to some models/);
    await issuePersonalKey(alice, { providerId: g.id });
    const [first] = [...openrouter.keys.values()];
    expect(first).toMatchObject({ limit: 10, limitReset: "monthly" });
    expect(first.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    openrouter.setUsage(first.hash, 3);
    await issuePersonalKey(alice, { providerId: g.id, rotate: true });
    expect(openrouter.keys.has(first.hash)).toBe(false);
    const [second] = [...openrouter.keys.values()];
    expect(second.limit).toBe(7);
    const status = await myGatewayKeyStatus(alice, g.id);
    expect(status.issued).toMatchObject({ maxBudget: 10 });
    // The check reads the spend back in budget terms: the carried 3 included.
    await db
      .update(gatewayIssuedKeys)
      .set({ updatedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(gatewayIssuedKeys.providerId, g.id));
    openrouter.setUsage(second.hash, 1);
    await checkGatewayKeys({ force: true });
    expect((await myGatewayKeyStatus(alice, g.id)).issued).toMatchObject({
      spendUsd: 4,
      maxBudget: 10,
    });
  });
});
