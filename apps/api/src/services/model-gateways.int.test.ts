import { gatewayTokenConsent } from "./gateway-token-consent.js";
import { secrets } from "../db/schema.js";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  createModelProvider,
  deleteModelProvider,
  podProviderRuntime,
  providerLaunch,
  resolveProviderForWork,
  updateModelProvider,
  type ProviderViewer,
} from "./model-provider-service.js";
import {
  GatewayTokenMissingError,
  defaultGateway,
  gatewayServesModel,
  implicitGateway,
  migrateLegacyGatewayTokens,
  organizationGatewayToken,
  personalGatewayToken,
  resolveGatewayToken,
  setDefaultGateway,
  setGatewayFetchForTests,
  storeOrganizationGatewayToken,
  storePersonalGatewayToken,
  syncGatewayCatalog,
  viewerGatewayStatus,
} from "./model-gateway-service.js";
import { gatewayForWork, resolveGatewayRun } from "./gateway-run-service.js";
import {
  buildSecretAAD,
  encrypt,
  listPickableSecrets,
  resolveSecretsForSetup,
  retrieveSecret,
  storeSecret,
} from "./secret-service.js";

async function insertUser(
  name: string,
  email = `${name}-${randomBytes(3).toString("hex")}@acme.dev`,
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

describe("model gateway (docs/model-gateway.md)", () => {
  let ws: string;
  let admin: ProviderViewer;
  let alice: ProviderViewer;

  beforeEach(async () => {
    ws = (await insertWorkspace()).id;
    const [a, b] = await Promise.all([insertUser("Ada"), insertUser("Alice")]);
    admin = { workspaceId: ws, userId: a.id, isAdmin: true };
    alice = { workspaceId: ws, userId: b.id, isAdmin: false };
    // The gateway answers every token test with an empty list.
    setGatewayFetchForTests(async () => Response.json({ data: [] }));
    // The deployment's own vendor keys and a stray ANTHROPIC_AUTH_TOKEN: no
    // gateway run may read, overwrite or ship any of them.
    await storeSecret("ANTHROPIC_API_KEY", "sk-deployment-anthropic", "global");
    await storeSecret("OPENAI_API_KEY", "sk-deployment-openai", "global");
    await storeSecret("ANTHROPIC_AUTH_TOKEN", "deployment-auth-token", "global");
  });

  afterEach(async () => {
    setGatewayFetchForTests(null);
    vi.unstubAllEnvs();
    await db
      .delete(secrets)
      .where(
        and(
          inArray(secrets.name, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN"]),
          eq(secrets.scope, "global"),
        ),
      );
  });

  /** A gateway row as work resolves it. */
  const rowOf = async (id: string, ownerUserId: string | null = alice.userId) =>
    (await resolveProviderForWork({
      agentType: "claude-code",
      agentOptions: { modelProvider: id },
      workspaceId: ws,
      ownerUserId,
      runsOn: "pod",
    }))!;

  const gateway = (extra: Record<string, unknown> = {}) => ({
    name: "Corp LiteLLM",
    owner: "workspace" as const,
    kind: "gateway" as const,
    agents: ["claude-code" as const, "opencode" as const],
    baseUrl: "https://litellm.example.com/",
    models: {
      "claude-code": [
        {
          id: "claude-sonnet-internal",
          label: "Sonnet (internal)",
          contextWindow: 200000,
          maxOutputTokens: 32000,
          efforts: ["low", "medium", "high"],
          defaultEffort: "high",
          prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          role: "sonnet" as const,
        },
        { id: "claude-haiku-internal", role: "haiku" as const },
      ],
      opencode: [{ id: "gpt-internal" }],
    },
    ...extra,
  });

  it("creates a gateway with its catalog, no region, and validates the URL", async () => {
    const p = await createModelProvider(gateway(), admin);
    expect(p).toMatchObject({
      kind: "gateway",
      region: "",
      baseUrl: "https://litellm.example.com",
      authHeader: "bearer",
      syncUrl: null,
      lastSyncedAt: null,
      tokenSource: "personal",
      podCredential: "none",
      hasPodCredentials: false,
    });
    expect(p.models["claude-code"]?.[0]).toEqual({
      id: "claude-sonnet-internal",
      label: "Sonnet (internal)",
      contextWindow: 200000,
      maxOutputTokens: 32000,
      efforts: ["low", "medium", "high"],
      defaultEffort: "high",
      prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      role: "sonnet",
    });
    expect(p.models.opencode).toEqual([{ id: "gpt-internal" }]);

    await expect(createModelProvider(gateway({ baseUrl: "litellm.corp" }), admin)).rejects.toThrow(
      /gateway URL/,
    );
    await expect(createModelProvider(gateway({ baseUrl: "" }), admin)).rejects.toThrow(
      /Give the gateway its URL/,
    );
    await expect(
      createModelProvider(
        gateway({
          models: { "claude-code": [{ id: "m", defaultEffort: "max", efforts: ["low"] }] },
        }),
        admin,
      ),
    ).rejects.toThrow(/default effort/);
    await expect(
      createModelProvider(
        gateway({ models: { "claude-code": [{ id: "m", role: "big" }] } }),
        admin,
      ),
    ).rejects.toThrow(/Unknown role/);
    await expect(
      createModelProvider(
        gateway({ models: { "claude-code": [{ id: "m", prices: { input: -1 } }] } }),
        admin,
      ),
    ).rejects.toThrow(/price/);
    await expect(createModelProvider(gateway({ tokenSource: "stored" }), admin)).rejects.toThrow(
      /shared token/,
    );
  });

  it("hands pods the gateway env with the owner's own token, and never someone else's", async () => {
    const p = await createModelProvider(gateway(), admin);
    const row = await resolveProviderForWork({
      agentType: "claude-code",
      agentOptions: {
        modelProvider: p.id,
        claudeModel: "claude-sonnet-internal",
        claudeEffort: "low",
      },
      workspaceId: ws,
      ownerUserId: alice.userId,
      runsOn: "pod",
    });
    expect(row).not.toBeNull();

    // No token yet: the run fails with the message that says where to add
    // one; the deployment's own keys are never stood in.
    const missing = await resolveGatewayToken({
      provider: row!,
      workspaceId: ws,
      ownerUserId: alice.userId,
    }).catch((e) => e);
    expect(missing).toBeInstanceOf(GatewayTokenMissingError);
    expect(missing.message).toBe('Add your token for "Corp LiteLLM" under Settings → My tokens');
    await expect(
      resolveGatewayToken({ provider: row!, workspaceId: ws, ownerUserId: null }),
    ).rejects.toBeInstanceOf(GatewayTokenMissingError);

    await storePersonalGatewayToken(alice, "alice-token", p.id);
    await storeOrganizationGatewayToken(p.id, admin, "org-token");
    const token = await resolveGatewayToken({
      provider: row!,
      workspaceId: ws,
      ownerUserId: alice.userId,
    });
    expect(token).toBe("alice-token");
    expect(await resolveGatewayToken({ provider: row!, workspaceId: ws, ownerUserId: null })).toBe(
      "org-token",
    );

    const runtime = podProviderRuntime(
      row!,
      "claude-code",
      { model: "claude-sonnet-internal", effort: "low" },
      token,
    );
    expect(runtime.codexConfig).toEqual([]);
    expect(runtime.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://litellm.example.com",
      ANTHROPIC_AUTH_TOKEN: "alice-token",
      ANTHROPIC_MODEL: "claude-sonnet-internal",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-sonnet-internal",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-internal",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-internal",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
      CLAUDE_CODE_EFFORT_LEVEL: "low",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(podProviderRuntime(row!, "opencode", { model: "gpt-internal" }, token).env).toEqual({
      OPENAI_BASE_URL: "https://litellm.example.com/v1",
      OPENAI_API_KEY: "alice-token",
      OPTIO_OPENCODE_MODEL: "gpt-internal",
    });

    // A machine gets the same env, token included: it is Alice's token on Alice's machine.
    const launch = providerLaunch(row!, {
      agent: "claude-code",
      pick: { model: "claude-sonnet-internal" },
      token,
    });
    expect(launch).toMatchObject({
      kind: "gateway",
      providerId: p.id,
      baseUrl: "https://litellm.example.com",
      authHeader: "bearer",
    });
    expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBe("alice-token");
  });

  it("checks the picked model against the catalog", async () => {
    const p = await createModelProvider(gateway(), admin);
    const use = (agentOptions: Record<string, unknown>, agentType = "claude-code") =>
      resolveProviderForWork({
        agentType,
        agentOptions: { modelProvider: p.id, ...agentOptions },
        workspaceId: ws,
        ownerUserId: alice.userId,
        runsOn: "pod",
      });
    await expect(use({ claudeModel: "claude-opus-4-8" })).rejects.toThrow(
      /doesn't serve the model/,
    );
    await expect(use({ claudeModel: "claude-haiku-internal" })).resolves.toMatchObject({
      id: p.id,
    });
    await expect(use({})).resolves.toMatchObject({ id: p.id });
    await expect(use({ opencodeModel: "other" }, "opencode")).rejects.toThrow(/doesn't serve/);
    await expect(use({}, "codex")).rejects.toThrow(/isn't set up for codex/);
    expect(await gatewayServesModel(ws, "claude-code", "claude-haiku-internal")).toBe(true);
    expect(await gatewayServesModel(ws, "claude-code", "claude-opus-4-8")).toBe(false);
  });

  it("stores one shared token when asked, and clears it going back to personal", async () => {
    const p = await createModelProvider(
      gateway({
        tokenSource: "stored",
        credentials: { type: "bearer-token", bearerToken: "shared" },
      }),
      admin,
    );
    expect(p).toMatchObject({
      tokenSource: "stored",
      podCredential: "bearer-token",
      hasPodCredentials: true,
    });
    expect(JSON.stringify(p)).not.toContain("shared");
    const row = await resolveProviderForWork({
      agentType: "claude-code",
      agentOptions: { modelProvider: p.id },
      workspaceId: ws,
      ownerUserId: alice.userId,
      runsOn: "pod",
    });
    expect(
      await resolveGatewayToken({ provider: row!, workspaceId: ws, ownerUserId: alice.userId }),
    ).toBe("shared");
    // The stored token is read from the row when the caller passes none.
    expect(podProviderRuntime(row!, "claude-code").env.ANTHROPIC_AUTH_TOKEN).toBe("shared");
    expect(podProviderRuntime(row!, "claude-code").env.ANTHROPIC_MODEL).toBe(
      "claude-sonnet-internal",
    );

    const back = await updateModelProvider(p.id, { tokenSource: "personal" }, admin);
    expect(back).toMatchObject({
      tokenSource: "personal",
      podCredential: "none",
      hasPodCredentials: false,
    });
    await expect(updateModelProvider(p.id, { tokenSource: "stored" }, admin)).rejects.toThrow(
      /Add the gateway's shared token/,
    );
    const changed = await updateModelProvider(
      p.id,
      {
        baseUrl: "https://other.example.com",
        authHeader: "api-key",
        syncUrl: "https://admin.example.com/",
      },
      admin,
    );
    expect(changed).toMatchObject({
      baseUrl: "https://other.example.com",
      authHeader: "api-key",
      syncUrl: "https://admin.example.com",
    });
    await expect(updateModelProvider(p.id, { baseUrl: "nope" }, admin)).rejects.toThrow(
      /gateway URL/,
    );
  });

  it("stores tokens as gateway:<id>, never under a vendor's name or over the deployment's keys", async () => {
    for (const extra of [{}, { authHeader: "api-key" }, { agents: ["opencode" as const] }]) {
      const p = await createModelProvider(
        gateway({ name: `G ${JSON.stringify(extra)}`, ...extra }),
        admin,
      );
      await storePersonalGatewayToken(alice, "alice-gateway-token", p.id);
      await storeOrganizationGatewayToken(p.id, admin, "org-gateway-token");
      const names = await db
        .select({ name: secrets.name, scope: secrets.scope, workspaceId: secrets.workspaceId })
        .from(secrets)
        .where(eq(secrets.name, `gateway:${p.id}`));
      expect(names).toEqual(
        expect.arrayContaining([
          { name: `gateway:${p.id}`, scope: "user", workspaceId: null },
          { name: `gateway:${p.id}`, scope: "gateway", workspaceId: ws },
        ]),
      );
    }
    // The deployment's keys are untouched, and Alice has no vendor key of
    // her own that a run outside the gateway would prefer
    // (`retrieveSecretWithFallback` reads user scope first).
    expect(await retrieveSecret("ANTHROPIC_API_KEY", "global")).toBe("sk-deployment-anthropic");
    expect(await retrieveSecret("OPENAI_API_KEY", "global")).toBe("sk-deployment-openai");
    expect(await retrieveSecret("ANTHROPIC_AUTH_TOKEN", "global")).toBe("deployment-auth-token");
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
      await expect(retrieveSecret(name, "user", undefined, alice.userId)).rejects.toThrow(
        /not found/,
      );
    }
    // Gateway tokens are never a pod secret, nor in a repo pod's env.
    expect((await listPickableSecrets(ws, alice.userId)).map((s) => s.name)).not.toContainEqual(
      expect.stringMatching(/^gateway:/),
    );
    expect(
      Object.keys(await resolveSecretsForSetup("https://github.com/acme/x", ws)),
    ).not.toContainEqual(expect.stringMatching(/^gateway:/));
    // Only an admin stores the organization's token.
    const p = await createModelProvider(gateway({ name: "Another" }), admin);
    await expect(storeOrganizationGatewayToken(p.id, alice, "t")).rejects.toThrow(/Only admins/);
  });

  it("reads the organization's token from the gateway's own workspace only", async () => {
    const p = await createModelProvider(gateway(), admin);
    const row = await rowOf(p.id, null);
    // The same name planted in another workspace (or instance-wide) isn't it.
    const other = (await insertWorkspace()).id;
    const consent = gatewayTokenConsent(row);
    await storeSecret(`gateway:${p.id}`, "elsewhere", "gateway", other, null, consent);
    await storeSecret(`gateway:${p.id}`, "instance-wide", "global", null, null, consent);
    expect(await organizationGatewayToken(row)).toBeNull();
    await storeOrganizationGatewayToken(p.id, admin, "ours");
    expect(await organizationGatewayToken(row)).toBe("ours");
    // Another workspace's admin can't set it.
    await expect(
      storeOrganizationGatewayToken(p.id, { ...admin, workspaceId: other }, "x"),
    ).rejects.toThrow(/not found/);
  });

  it("hands a token out only while its consent matches the gateway's URLs", async () => {
    const p = await createModelProvider(gateway(), admin);
    await storePersonalGatewayToken(alice, "alice-token", p.id);
    await storeOrganizationGatewayToken(p.id, admin, "org-token");
    expect(await personalGatewayToken(await rowOf(p.id), alice.userId)).toBe("alice-token");

    // The gateway moves: neither token follows it, every reader sees none.
    await updateModelProvider(p.id, { baseUrl: "https://elsewhere.example.com" }, admin);
    const moved = await rowOf(p.id);
    expect(await personalGatewayToken(moved, alice.userId)).toBeNull();
    expect(await organizationGatewayToken(moved)).toBeNull();
    await expect(
      resolveGatewayToken({ provider: moved, workspaceId: ws, ownerUserId: alice.userId }),
    ).rejects.toBeInstanceOf(GatewayTokenMissingError);
    expect(await viewerGatewayStatus(alice)).toMatchObject({ hasToken: false, orgHasToken: false });
    // Likewise a new sync URL.
    await storePersonalGatewayToken(alice, "alice-token-2", p.id);
    expect(await personalGatewayToken(await rowOf(p.id), alice.userId)).toBe("alice-token-2");
    await updateModelProvider(p.id, { syncUrl: "https://admin.example.com" }, admin);
    expect(await personalGatewayToken(await rowOf(p.id), alice.userId)).toBeNull();

    // A token written any other way (no consent) is never read as one.
    await storeSecret(`gateway:${p.id}`, "planted", "user", null, alice.userId);
    expect(await personalGatewayToken(await rowOf(p.id), alice.userId)).toBeNull();
  });

  it("asks for a stored gateway's shared token again when its URL changes", async () => {
    const p = await createModelProvider(
      gateway({ tokenSource: "stored", credentials: { type: "bearer-token", bearerToken: "s" } }),
      admin,
    );
    await expect(
      updateModelProvider(p.id, { baseUrl: "https://elsewhere.example.com" }, admin),
    ).rejects.toThrow(/add its shared token again/);
    await expect(
      updateModelProvider(p.id, { syncUrl: "https://admin.example.com" }, admin),
    ).rejects.toThrow(/add its shared token again/);
    await expect(
      updateModelProvider(
        p.id,
        {
          baseUrl: "https://elsewhere.example.com",
          credentials: { type: "bearer-token", bearerToken: "s2" },
        },
        admin,
      ),
    ).resolves.toMatchObject({ baseUrl: "https://elsewhere.example.com" });
    // Other edits keep it.
    await expect(updateModelProvider(p.id, { name: "Renamed" }, admin)).resolves.toMatchObject({
      hasPodCredentials: true,
    });
  });

  it("removes a gateway's tokens with it", async () => {
    const p = await createModelProvider(gateway(), admin);
    await storePersonalGatewayToken(alice, "alice-token", p.id);
    await storeOrganizationGatewayToken(p.id, admin, "org-token");
    await deleteModelProvider(p.id, admin);
    expect(
      await db
        .select()
        .from(secrets)
        .where(eq(secrets.name, `gateway:${p.id}`)),
    ).toEqual([]);
  });

  it("moves an earlier build's gateway tokens off vendor names, never touching a real key", async () => {
    const p = await createModelProvider(gateway(), admin);
    const row = await rowOf(p.id);
    const bob = await insertUser("Bob");
    const carol = await insertUser("Carol");
    /** A row as the earlier build wrote it: a vendor name, consent by origins. */
    const legacy = async (name: string, userId: string, value: string, origins: string[]) => {
      const sealed = encrypt(value, buildSecretAAD(name, "user", null));
      await db.insert(secrets).values({
        name,
        scope: "user",
        userId,
        encryptedValue: sealed.ciphertext,
        iv: sealed.iv,
        authTag: sealed.authTag,
        alg: sealed.alg,
        gatewayConsent: { providerId: p.id, origins },
      });
    };
    await legacy("ANTHROPIC_AUTH_TOKEN", alice.userId!, "alice-gw", [
      "https://litellm.example.com",
    ]);
    // Consent for a URL the gateway has since left: not carried over.
    await legacy("ANTHROPIC_API_KEY", bob.id, "bob-gw", ["https://old.example.com"]);
    // Carol's real vendor key (no consent) and the deployment's stay as they are.
    await storeSecret("ANTHROPIC_API_KEY", "carol-real-key", "user", null, carol.id);

    expect(await migrateLegacyGatewayTokens()).toBe(1);
    expect(await personalGatewayToken(row, alice.userId)).toBe("alice-gw");
    expect(await personalGatewayToken(row, bob.id)).toBeNull();
    for (const [name, userId] of [
      ["ANTHROPIC_AUTH_TOKEN", alice.userId!],
      ["ANTHROPIC_API_KEY", bob.id],
    ] as const) {
      await expect(retrieveSecret(name, "user", undefined, userId)).rejects.toThrow(/not found/);
    }
    expect(await retrieveSecret("ANTHROPIC_API_KEY", "user", undefined, carol.id)).toBe(
      "carol-real-key",
    );
    expect(await retrieveSecret("ANTHROPIC_API_KEY", "global")).toBe("sk-deployment-anthropic");
    // Idempotent.
    expect(await migrateLegacyGatewayTokens()).toBe(0);
    expect(await personalGatewayToken(row, alice.userId)).toBe("alice-gw");
  });

  it("never reroutes work that picked no gateway, unless the deployment is gateway-only", async () => {
    const p = await createModelProvider(gateway(), admin);
    await storeOrganizationGatewayToken(p.id, admin, "org-token");
    const use = {
      agentType: "claude-code",
      agentOptions: { claudeModel: "sonnet" },
      workspaceId: ws,
      ownerUserId: null,
    };
    // OPTIO_MODEL_ACCESS unset / any: the organization's gateway exists, but
    // work that didn't pick it goes to the vendor as before.
    for (const access of [undefined, "any"]) {
      if (access) vi.stubEnv("OPTIO_MODEL_ACCESS", access);
      expect(await implicitGateway(ws)).toBeNull();
      expect(await gatewayForWork(use)).toBeNull();
      expect(await resolveGatewayRun(use)).toBeNull();
    }
    // Picked explicitly: the gateway takes it.
    expect(await resolveGatewayRun({ ...use, provider: await rowOf(p.id, null) })).toMatchObject({
      token: "org-token",
    });
    // Gateway-only: the default gateway takes it, as the form shows.
    vi.stubEnv("OPTIO_MODEL_ACCESS", "gateway");
    expect((await implicitGateway(ws))?.id).toBe(p.id);
    expect(await resolveGatewayRun(use)).toMatchObject({ row: { id: p.id }, token: "org-token" });
  });

  it("caps what a LiteLLM sync adds, and reads nothing from a malformed answer", async () => {
    const p = await createModelProvider(gateway({ gatewayType: "litellm" }), admin);
    await storeOrganizationGatewayToken(p.id, admin, "org-token");
    const ids = Array.from({ length: 300 }, (_, i) => `model-${i}`);
    setGatewayFetchForTests(async (url) =>
      new URL(url).pathname === "/model/info"
        ? Response.json({ data: ids.map((id) => ({ model_name: id, model_info: {} })) })
        : Response.json({ data: ids.map((id) => ({ id })) }),
    );
    const { provider } = await syncGatewayCatalog(p.id, admin);
    // The two models already listed stay; new ones fill up to 50.
    expect(provider.models["claude-code"]).toHaveLength(50);
    expect(provider.models.opencode).toHaveLength(50);

    setGatewayFetchForTests(async () => Response.json({ data: { not: "a list" } }));
    await expect(syncGatewayCatalog(p.id, admin)).rejects.toThrow(/listed no models/);
  });

  it("names the workspace's default gateway, falling back to the organization's first", async () => {
    expect(await defaultGateway(ws)).toBeNull();
    const first = await createModelProvider(gateway({ name: "First" }), admin);
    const second = await createModelProvider(gateway({ name: "Second" }), admin);
    expect((await defaultGateway(ws))?.id).toBe(first.id);
    await expect(setDefaultGateway(ws, second.id, alice)).rejects.toThrow(/Only admins/);
    await setDefaultGateway(ws, second.id, admin);
    expect((await defaultGateway(ws))?.id).toBe(second.id);
    const mine = await createModelProvider(gateway({ name: "Mine", owner: "me" }), alice);
    await expect(setDefaultGateway(ws, mine.id, admin)).rejects.toThrow(/organization's/);
    await setDefaultGateway(ws, null, admin);
    expect((await defaultGateway(ws))?.id).toBe(first.id);

    expect(await viewerGatewayStatus(alice)).toEqual({
      gateway: {
        id: first.id,
        name: "First",
        baseUrl: "https://litellm.example.com",
        authHeader: "bearer",
        tokenSource: "personal",
      },
      hasToken: false,
      keyInfo: null,
      orgHasToken: false,
    });
  });
});
