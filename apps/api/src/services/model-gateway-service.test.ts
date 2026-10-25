import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ───

const mockRetrieveSecret = vi.fn();
const mockStoreSecret = vi.fn();
vi.mock("./secret-service.js", () => ({
  retrieveSecret: (...args: unknown[]) => mockRetrieveSecret(...args),
  storeSecret: (...args: unknown[]) => mockStoreSecret(...args),
}));

// The team's name for the "no team token" message.
const mockSelectRows = vi.fn(async () => [{ name: "Platform" }]);
vi.mock("../db/client.js", () => {
  const chain = {
    from: () => chain,
    where: () => mockSelectRows(),
  };
  return { db: { select: () => chain } };
});

const mockStoredGatewayToken = vi.fn();
vi.mock("./model-provider-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-provider-service.js")>();
  return {
    ModelProviderError: actual.ModelProviderError,
    cleanModels: actual.cleanModels,
    gatewayOf: actual.gatewayOf,
    toModelProvider: actual.toModelProvider,
    getModelProviderRow: vi.fn(),
    storedGatewayToken: (...args: unknown[]) => mockStoredGatewayToken(...args),
  };
});

import {
  GatewayTokenMissingError,
  gatewayKeyInfo,
  gatewayTest,
  mergeGatewayCatalog,
  parseKeyInfo,
  parseModelInfo,
  parseModelList,
  resolveGatewayToken,
  setGatewayFetchForTests,
  tokenSecretNameOf,
} from "./model-gateway-service.js";
import type { ModelProviderRow } from "./model-provider-service.js";

const gateway = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "ws-1",
  ownerUserId: null,
  kind: "gateway",
  name: "Corp LiteLLM",
  agents: ["claude-code"],
  baseUrl: "https://litellm.example.com",
  authHeader: "bearer",
  syncUrl: null,
  tokenSource: "personal",
  encryptedCredentials: null,
  models: { "claude-code": [] },
} as unknown as ModelProviderRow;

beforeEach(() => {
  mockRetrieveSecret.mockReset();
  mockStoreSecret.mockReset();
  mockStoredGatewayToken.mockReset();
  mockStoredGatewayToken.mockReturnValue(null);
});

afterEach(() => {
  setGatewayFetchForTests(null);
});

// ─── Tokens ───

describe("resolveGatewayToken", () => {
  it("gives a team's work the team's token, and says where to add a missing one", async () => {
    mockRetrieveSecret.mockResolvedValue("team-token");
    await expect(
      resolveGatewayToken({
        provider: gateway,
        workspaceId: "ws-1",
        ownerUserId: "alice",
        ownerTeamId: "team-1",
      }),
    ).resolves.toBe("team-token");
    expect(mockRetrieveSecret).toHaveBeenCalledWith(
      "ANTHROPIC_AUTH_TOKEN",
      "team",
      "ws-1",
      undefined,
      "team-1",
    );

    mockRetrieveSecret.mockRejectedValue(new Error("Secret not found"));
    const err = await resolveGatewayToken({
      provider: gateway,
      workspaceId: "ws-1",
      ownerUserId: "alice",
      ownerTeamId: "team-1",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayTokenMissingError);
    expect(err.scope).toBe("team");
    expect(err.status).toBe(400);
    expect(err.message).toBe(
      "This team has no gateway token yet — a team admin adds one under Teams → Platform → Tokens",
    );
    // Never anyone else's: one lookup, no fallback to the person or the organization.
    expect(mockRetrieveSecret).toHaveBeenCalledTimes(2);
  });

  it("gives personal work its owner's token only", async () => {
    mockRetrieveSecret.mockResolvedValue("alice-token");
    await expect(
      resolveGatewayToken({ provider: gateway, workspaceId: "ws-1", ownerUserId: "alice" }),
    ).resolves.toBe("alice-token");
    expect(mockRetrieveSecret).toHaveBeenCalledWith(
      "ANTHROPIC_AUTH_TOKEN",
      "user",
      undefined,
      "alice",
    );

    mockRetrieveSecret.mockRejectedValue(new Error("Secret not found"));
    await expect(
      resolveGatewayToken({ provider: gateway, workspaceId: "ws-1", ownerUserId: "alice" }),
    ).rejects.toThrow("Add your gateway token under Settings → My tokens");
    expect(mockRetrieveSecret).toHaveBeenCalledTimes(2);
  });

  it("gives the organization's work the global token", async () => {
    mockRetrieveSecret.mockResolvedValue("org-token");
    await expect(
      resolveGatewayToken({ provider: gateway, workspaceId: "ws-1", ownerUserId: null }),
    ).resolves.toBe("org-token");
    expect(mockRetrieveSecret).toHaveBeenCalledWith("ANTHROPIC_AUTH_TOKEN", "global");

    mockRetrieveSecret.mockRejectedValue(new Error("Secret not found"));
    await expect(
      resolveGatewayToken({ provider: gateway, workspaceId: "ws-1", ownerUserId: null }),
    ).rejects.toThrow(
      "The organization has no gateway token — an admin adds one under Settings → Model gateway",
    );
  });

  it("names the secret after the auth header, and OPENAI_API_KEY for OpenCode alone", async () => {
    expect(tokenSecretNameOf({ authHeader: "api-key", agents: ["claude-code"] })).toBe(
      "ANTHROPIC_API_KEY",
    );
    expect(tokenSecretNameOf({ authHeader: "bearer", agents: ["opencode"] })).toBe(
      "OPENAI_API_KEY",
    );
    mockRetrieveSecret.mockResolvedValue("t");
    await resolveGatewayToken({
      provider: { ...gateway, authHeader: "api-key" } as ModelProviderRow,
      workspaceId: "ws-1",
      ownerUserId: "alice",
    });
    expect(mockRetrieveSecret).toHaveBeenCalledWith(
      "ANTHROPIC_API_KEY",
      "user",
      undefined,
      "alice",
    );
  });

  it("hands out the sealed token of a stored gateway without looking at secrets", async () => {
    mockStoredGatewayToken.mockReturnValue("shared-token");
    const stored = { ...gateway, tokenSource: "stored" } as ModelProviderRow;
    await expect(
      resolveGatewayToken({ provider: stored, workspaceId: "ws-1", ownerUserId: "alice" }),
    ).resolves.toBe("shared-token");
    expect(mockRetrieveSecret).not.toHaveBeenCalled();

    mockStoredGatewayToken.mockReturnValue(null);
    await expect(
      resolveGatewayToken({ provider: stored, workspaceId: "ws-1", ownerUserId: "alice" }),
    ).rejects.toThrow(/no shared token stored/);
  });

  it("refuses a provider that isn't a gateway", async () => {
    await expect(
      resolveGatewayToken({
        provider: { ...gateway, kind: "bedrock" } as ModelProviderRow,
        workspaceId: "ws-1",
        ownerUserId: null,
      }),
    ).rejects.toThrow(/isn't a model gateway/);
  });
});

// ─── Catalog ───

const modelInfoFixture = {
  data: [
    {
      model_name: "claude-sonnet-internal",
      litellm_params: { model: "bedrock/anthropic.claude-sonnet" },
      model_info: {
        max_input_tokens: 200000,
        max_output_tokens: 32000,
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 3e-7,
        cache_creation_input_token_cost: 0.00000375,
        mode: "chat",
      },
    },
    {
      // A second deployment of the same name: merged, first numbers win.
      model_name: "claude-sonnet-internal",
      model_info: { max_input_tokens: 100000 },
    },
    { model_name: "gpt-internal", model_info: { max_input_tokens: 128000 } },
    { model_name: "   ", model_info: {} },
    { model_info: { max_input_tokens: 1 } },
  ],
};

describe("parseModelInfo", () => {
  it("turns LiteLLM's /model/info into catalog numbers (prices per million tokens)", () => {
    expect(parseModelInfo(modelInfoFixture)).toEqual([
      {
        id: "claude-sonnet-internal",
        contextWindow: 200000,
        maxOutputTokens: 32000,
        prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
      { id: "gpt-internal", contextWindow: 128000 },
    ]);
    expect(parseModelInfo({})).toEqual([]);
    expect(parseModelInfo(null)).toEqual([]);
    expect(parseModelList({ data: [{ id: "a" }, { id: " " }, {}] })).toEqual(["a"]);
  });
});

describe("mergeGatewayCatalog", () => {
  it("keeps the admin's names, efforts and roles, takes the gateway's numbers, flags the gone", () => {
    const existing = [
      {
        id: "claude-sonnet-internal",
        label: "Sonnet (internal)",
        efforts: ["low", "high"],
        defaultEffort: "low",
        role: "sonnet" as const,
        contextWindow: 1000,
        prices: { input: 1, cacheWrite: 9 },
      },
      { id: "claude-retired", label: "Retired", role: "opus" as const },
      { id: "gpt-internal", missing: true },
    ];
    const merged = mergeGatewayCatalog(existing, parseModelInfo(modelInfoFixture), [
      "claude-sonnet-internal",
      "gpt-internal",
      "claude-new",
    ]);
    expect(merged).toEqual([
      {
        id: "claude-sonnet-internal",
        label: "Sonnet (internal)",
        efforts: ["low", "high"],
        defaultEffort: "low",
        role: "sonnet",
        contextWindow: 200000,
        maxOutputTokens: 32000,
        prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
      { id: "claude-retired", label: "Retired", role: "opus", missing: true },
      // Served again: no longer missing.
      { id: "gpt-internal", contextWindow: 128000 },
      // New, and a Claude model: the five efforts by default.
      {
        id: "claude-new",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
      },
    ]);
  });
});

// ─── HTTP ───

function fakeFetch(routes: Record<string, { status: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  setGatewayFetchForTests(async (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const path = new URL(url).pathname;
    const hit = routes[path] ?? { status: 404 };
    if (hit instanceof Error) throw hit;
    return {
      status: hit.status,
      ok: hit.status >= 200 && hit.status < 300,
      json: async () => {
        if (hit.body === undefined) throw new Error("no body");
        return hit.body;
      },
    } as unknown as Response;
  });
  return calls;
}

describe("gatewayTest", () => {
  it("counts the models the token sees, and says when the gateway refuses it", async () => {
    const calls = fakeFetch({
      "/v1/models": { status: 200, body: { data: [{ id: "a" }, { id: "b" }] } },
    });
    expect(await gatewayTest(gateway, "tok")).toEqual({ ok: true, modelCount: 2 });
    expect(calls[0].url).toBe("https://litellm.example.com/v1/models");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");

    fakeFetch({ "/v1/models": { status: 401 } });
    expect(await gatewayTest(gateway, "bad")).toMatchObject({ ok: false, error: /refused/ });

    fakeFetch({ "/v1/models": new Error("connect ECONNREFUSED") });
    expect(await gatewayTest(gateway, "tok")).toMatchObject({
      ok: false,
      modelCount: 0,
      error: /Couldn't reach the gateway: connect ECONNREFUSED/,
    });
  });

  it("sends x-api-key too for an api-key gateway", async () => {
    const calls = fakeFetch({ "/v1/models": { status: 200, body: { data: [] } } });
    await gatewayTest({ ...gateway, authHeader: "api-key" } as ModelProviderRow, "tok");
    expect(calls[0].headers["x-api-key"]).toBe("tok");
  });
});

describe("gatewayKeyInfo", () => {
  it("reads LiteLLM's /key/info, and is null when the gateway isn't LiteLLM", async () => {
    expect(
      parseKeyInfo({
        key: "sk-…",
        info: {
          spend: 12.5,
          max_budget: 100,
          budget_reset_at: "2026-11-01T00:00:00Z",
          key_alias: "alice",
        },
      }),
    ).toEqual({
      spend: 12.5,
      maxBudget: 100,
      budgetResetAt: "2026-11-01T00:00:00Z",
      keyAlias: "alice",
    });
    expect(parseKeyInfo({ info: { spend: "3.5", max_budget: null } })).toEqual({
      spend: 3.5,
      maxBudget: null,
      budgetResetAt: null,
      keyAlias: null,
    });
    expect(parseKeyInfo({ detail: "Not Found" })).toBeNull();

    const calls = fakeFetch({ "/key/info": { status: 200, body: { info: { spend: 1 } } } });
    expect(await gatewayKeyInfo(gateway, "tok")).toMatchObject({ spend: 1, maxBudget: null });
    expect(calls[0].url).toBe("https://litellm.example.com/key/info");

    // The sync URL, when set, is where the management reads go.
    const withSync = {
      ...gateway,
      syncUrl: "https://admin.litellm.example.com",
    } as ModelProviderRow;
    const synced = fakeFetch({ "/key/info": { status: 404 } });
    expect(await gatewayKeyInfo(withSync, "tok")).toBeNull();
    expect(synced[0].url).toBe("https://admin.litellm.example.com/key/info");

    fakeFetch({ "/key/info": new Error("ETIMEDOUT") });
    expect(await gatewayKeyInfo(gateway, "tok")).toBeNull();
  });
});
