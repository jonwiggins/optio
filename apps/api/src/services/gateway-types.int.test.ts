import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  createModelProvider,
  podProviderRuntime,
  resolveProviderForWork,
  updateModelProvider,
  type ProviderViewer,
} from "./model-provider-service.js";
import {
  personalGatewayToken,
  setGatewayFetchForTests,
  storeOrganizationGatewayToken,
  storePersonalGatewayToken,
  syncGatewayCatalog,
} from "./model-gateway-service.js";

// Gateway types against a real database (docs/model-gateway.md "Gateway
// types"): what each type takes, OpenRouter's catalog sync, Portkey's header.

async function insertUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "google",
      externalId: randomBytes(6).toString("hex"),
      email: `${name}-${randomBytes(3).toString("hex")}@example.com`,
      displayName: name,
    })
    .returning();
  return row;
}

describe("gateway types", () => {
  let ws: string;
  let admin: ProviderViewer;
  let alice: ProviderViewer;
  let requests: Array<{ url: string; headers: Record<string, string> }>;

  beforeEach(async () => {
    ws = (await insertWorkspace()).id;
    const [a, b] = await Promise.all([insertUser("Ada"), insertUser("Alice")]);
    admin = { workspaceId: ws, userId: a.id, isAdmin: true };
    alice = { workspaceId: ws, userId: b.id, isAdmin: false };
    requests = [];
    setGatewayFetchForTests(async (url, init) => {
      requests.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
      return Response.json({ data: [] });
    });
  });

  afterEach(() => setGatewayFetchForTests(null));

  const rowOf = async (id: string) =>
    (await resolveProviderForWork({
      agentType: "claude-code",
      agentOptions: { modelProvider: id },
      workspaceId: ws,
      ownerUserId: alice.userId,
      runsOn: "pod",
    }))!;

  const gateway = (extra: Record<string, unknown> = {}) => ({
    name: "Gateway",
    owner: "workspace" as const,
    kind: "gateway" as const,
    agents: ["claude-code" as const],
    baseUrl: "https://gateway.example.com",
    models: { "claude-code": [{ id: "m" }] },
    ...extra,
  });

  it("takes only the auth header and sync URL a type supports", async () => {
    await expect(
      createModelProvider(gateway({ gatewayType: "openrouter", authHeader: "api-key" }), admin),
    ).rejects.toThrow(/OpenRouter takes the token as bearer, not api-key/);
    await expect(
      createModelProvider(
        gateway({ gatewayType: "portkey", syncUrl: "https://admin.example.com" }),
        admin,
      ),
    ).rejects.toThrow(/Portkey has no sync URL/);
    await expect(createModelProvider(gateway({ gatewayType: "bogus" }), admin)).rejects.toThrow(
      /litellm, generic, openrouter, portkey/,
    );

    const p = await createModelProvider(
      gateway({ authHeader: "api-key", syncUrl: "https://admin.example.com" }),
      admin,
    );
    expect(p).toMatchObject({ gatewayType: "litellm", syncUrl: "https://admin.example.com" });
    await storePersonalGatewayToken(alice, "alice-token", p.id);
    expect(await personalGatewayToken(await rowOf(p.id), alice.userId)).toBe("alice-token");

    // OpenRouter refuses the api-key header it was saved with…
    await expect(updateModelProvider(p.id, { gatewayType: "openrouter" }, admin)).rejects.toThrow(
      /takes the token as bearer/,
    );
    // …and drops the sync URL it has no use for, so Alice's token, given for
    // that sync URL, is no longer read.
    const moved = await updateModelProvider(
      p.id,
      { gatewayType: "openrouter", authHeader: "bearer" },
      admin,
    );
    expect(moved).toMatchObject({ gatewayType: "openrouter", syncUrl: null });
    expect(await personalGatewayToken(await rowOf(p.id), alice.userId)).toBeNull();
    await expect(updateModelProvider(p.id, { authHeader: "api-key" }, admin)).rejects.toThrow(
      /takes the token as bearer/,
    );
  });

  it("asks a stored gateway for its token again when a type change drops its sync URL", async () => {
    const p = await createModelProvider(
      gateway({
        syncUrl: "https://admin.example.com",
        tokenSource: "stored",
        credentials: { type: "bearer-token", bearerToken: "s" },
      }),
      admin,
    );
    await expect(updateModelProvider(p.id, { gatewayType: "portkey" }, admin)).rejects.toThrow(
      /add its shared token again/,
    );
    await expect(
      updateModelProvider(
        p.id,
        { gatewayType: "portkey", credentials: { type: "bearer-token", bearerToken: "s2" } },
        admin,
      ),
    ).resolves.toMatchObject({ gatewayType: "portkey", syncUrl: null, hasPodCredentials: true });
  });

  it("details OpenRouter's listed models from its list, and adds none", async () => {
    const p = await createModelProvider(
      gateway({
        gatewayType: "openrouter",
        baseUrl: "https://openrouter.ai/api",
        models: {
          "claude-code": [{ id: "anthropic/claude-sonnet-4.5", label: "Sonnet" }, { id: "gone/x" }],
        },
      }),
      admin,
    );
    await storeOrganizationGatewayToken(p.id, admin, "sk-or-org");
    // The token is tried on /v1/key when it is stored.
    expect(requests.map((r) => r.url)).toContain("https://openrouter.ai/api/v1/key");
    requests = [];
    setGatewayFetchForTests(async (url, init) => {
      requests.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
      return Response.json({
        data: [
          {
            id: "anthropic/claude-sonnet-4.5",
            context_length: 1_000_000,
            pricing: { prompt: "0.000003", completion: "0.000015" },
            top_provider: { max_completion_tokens: 64_000 },
          },
          { id: "qwen/qwen3-coder", context_length: 262_144 },
        ],
      });
    });
    const { provider, synced } = await syncGatewayCatalog(p.id, admin);
    expect(provider.models["claude-code"]).toEqual([
      {
        id: "anthropic/claude-sonnet-4.5",
        label: "Sonnet",
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        prices: { input: 3, output: 15 },
      },
      { id: "gone/x", missing: true },
    ]);
    expect(synced).toEqual({ models: 2, missing: 1 });
    expect(requests).toEqual([
      {
        url: "https://openrouter.ai/api/v1/models",
        headers: expect.objectContaining({ Authorization: "Bearer sk-or-org" }),
      },
    ]);

    // An empty catalog: Sync says to add the ids first.
    await updateModelProvider(p.id, { models: { "claude-code": [] } }, admin);
    await expect(syncGatewayCatalog(p.id, admin)).rejects.toThrow(
      /OpenRouter serves 2 models: add the ids you want/,
    );
  });

  it("sends Portkey's token in its own header only, and gives its runs the header", async () => {
    const p = await createModelProvider(
      gateway({ gatewayType: "portkey", baseUrl: "https://api.portkey.ai" }),
      admin,
    );
    await storePersonalGatewayToken(alice, "pk-alice", p.id);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.portkey.ai/v1/models");
    expect(requests[0].headers).toEqual({
      Accept: "application/json",
      "x-portkey-api-key": "pk-alice",
    });

    const row = await rowOf(p.id);
    const token = await personalGatewayToken(row, alice.userId);
    const { env } = podProviderRuntime(row, "claude-code", null, token);
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.portkey.ai",
      ANTHROPIC_AUTH_TOKEN: "pk-alice",
      ANTHROPIC_CUSTOM_HEADERS: "x-portkey-api-key: pk-alice",
    });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });
});
