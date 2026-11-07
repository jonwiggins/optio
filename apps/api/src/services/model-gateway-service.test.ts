import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ───

const mockRetrieveGatewayTokenSecret = vi.fn();
const mockStoreSecret = vi.fn();
vi.mock("./secret-service.js", () => ({
  retrieveGatewayTokenSecret: (...args: unknown[]) => mockRetrieveGatewayTokenSecret(...args),
  storeSecret: (...args: unknown[]) => mockStoreSecret(...args),
}));

vi.mock("../db/client.js", () => ({ db: {} }));

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
  gatewayFetch,
  gatewayKeyInfo,
  gatewayTest,
  listGatewayModels,
  MAX_CATALOG_ENTRIES,
  MAX_GATEWAY_BODY_BYTES,
  mergeGatewayCatalog,
  parseKeyInfo,
  parseModelInfo,
  parseModelList,
  resolveGatewayToken,
  setGatewayFetchForTests,
  tokenSecretNameOf,
} from "./model-gateway-service.js";
import { gatewayTokenConsent } from "./gateway-token-consent.js";
import type { ModelProviderRow } from "./model-provider-service.js";
import { setOutboundDefaults } from "../utils/outbound-url.js";

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
  mockRetrieveGatewayTokenSecret.mockReset();
  mockStoreSecret.mockReset();
  mockStoredGatewayToken.mockReset();
  mockStoredGatewayToken.mockReturnValue(null);
});

afterEach(() => {
  setGatewayFetchForTests(null);
  vi.unstubAllEnvs();
});

describe("gateway outbound policy", () => {
  it("blocks loopback and link-local destinations before sending a token", async () => {
    const send = vi.fn();
    const restore = setOutboundDefaults({
      policy: { allowPrivate: false, allowedHosts: [], allowAll: false },
      fetchImpl: send,
    });
    try {
      for (const url of ["http://127.0.0.1/private", "http://169.254.169.254/latest/meta-data"]) {
        await expect(
          gatewayFetch()(url, { headers: { Authorization: "Bearer dummy" } }),
        ).rejects.toThrow(/blocked/i);
      }
      expect(send).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("uses the administrator's explicit allowlist and rejects redirects", async () => {
    const send = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      return new Response("{}", { status: 200 });
    });
    const restore = setOutboundDefaults({
      policy: { allowPrivate: false, allowedHosts: ["127.0.0.1"], allowAll: false },
      fetchImpl: send,
    });
    try {
      await gatewayFetch()("http://127.0.0.1/v1/models");
      expect(send).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it("rejects fragments and credentials that could alter the endpoint", () => {
    for (const url of [
      "https://gateway.example/path#discard",
      "https://user:pass@gateway.example/v1/models",
    ]) {
      expect(() => gatewayFetch()(url)).toThrow(/fragments or user credentials/);
    }
  });
});

// ─── Tokens ───

describe("resolveGatewayToken", () => {
  const SECRET = "gateway:11111111-1111-4111-8111-111111111111";
  /** A stored token with the consent `consentFor` gave it. */
  const storedFor = (value: string, consentFor: Partial<ModelProviderRow> = {}) => ({
    value,
    consent: gatewayTokenConsent({ ...gateway, ...consentFor } as ModelProviderRow),
  });

  it("names the secret after the gateway, never a vendor's env name", () => {
    expect(tokenSecretNameOf(gateway)).toBe(SECRET);
    expect(tokenSecretNameOf({ ...gateway, authHeader: "api-key" } as ModelProviderRow)).toBe(
      SECRET,
    );
  });

  it("gives personal work its owner's token only, from gateway:<id> at user scope", async () => {
    mockRetrieveGatewayTokenSecret.mockResolvedValue(storedFor("alice-token"));
    await expect(
      resolveGatewayToken({ provider: gateway, workspaceId: "ws-1", ownerUserId: "alice" }),
    ).resolves.toBe("alice-token");
    expect(mockRetrieveGatewayTokenSecret).toHaveBeenCalledWith(SECRET, "user", null, "alice");

    mockRetrieveGatewayTokenSecret.mockResolvedValue(null);
    await expect(
      resolveGatewayToken({ provider: gateway, workspaceId: "ws-1", ownerUserId: "alice" }),
    ).rejects.toThrow('Add your token for "Corp LiteLLM" under Settings → My tokens');
  });

  it("gives the organization's work the token bound to the gateway's workspace", async () => {
    mockRetrieveGatewayTokenSecret.mockResolvedValue(storedFor("org-token"));
    await expect(
      resolveGatewayToken({ provider: gateway, workspaceId: "ws-1", ownerUserId: null }),
    ).resolves.toBe("org-token");
    // Never the instance-wide `global` scope, never another workspace's.
    expect(mockRetrieveGatewayTokenSecret).toHaveBeenCalledWith(SECRET, "gateway", "ws-1", null);

    mockRetrieveGatewayTokenSecret.mockResolvedValue(null);
    const err = await resolveGatewayToken({
      provider: gateway,
      workspaceId: "ws-1",
      ownerUserId: null,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayTokenMissingError);
    expect(err.scope).toBe("global");
  });

  it("never reads a vendor key, whatever the auth header or agents", async () => {
    mockRetrieveGatewayTokenSecret.mockResolvedValue(null);
    for (const provider of [
      { ...gateway, authHeader: "api-key" },
      { ...gateway, agents: ["opencode"] },
    ] as ModelProviderRow[]) {
      await resolveGatewayToken({ provider, workspaceId: "ws-1", ownerUserId: "alice" }).catch(
        () => null,
      );
      await resolveGatewayToken({ provider, workspaceId: "ws-1", ownerUserId: null }).catch(
        () => null,
      );
    }
    const names = mockRetrieveGatewayTokenSecret.mock.calls.map((c) => c[0]);
    expect(names.length).toBe(4);
    expect(new Set(names)).toEqual(new Set([SECRET]));
  });

  it("refuses a token whose consent is for another gateway or its old URL", async () => {
    for (const consentFor of [
      { id: "22222222-2222-4222-8222-222222222222" },
      { baseUrl: "https://old-litellm.example.com" },
      { syncUrl: "https://admin.example.com" },
    ] as Partial<ModelProviderRow>[]) {
      mockRetrieveGatewayTokenSecret.mockResolvedValue(storedFor("stale", consentFor));
      await expect(
        resolveGatewayToken({ provider: gateway, workspaceId: "ws-1", ownerUserId: "alice" }),
      ).rejects.toBeInstanceOf(GatewayTokenMissingError);
      await expect(
        resolveGatewayToken({ provider: gateway, workspaceId: "ws-1", ownerUserId: null }),
      ).rejects.toBeInstanceOf(GatewayTokenMissingError);
    }
    // A plain secret under the gateway's name (no consent) isn't a token either.
    mockRetrieveGatewayTokenSecret.mockResolvedValue({ value: "planted", consent: null });
    await expect(
      resolveGatewayToken({ provider: gateway, workspaceId: "ws-1", ownerUserId: "alice" }),
    ).rejects.toBeInstanceOf(GatewayTokenMissingError);
  });

  it("hands out the sealed token of a stored gateway without looking at secrets", async () => {
    mockStoredGatewayToken.mockReturnValue("shared-token");
    const stored = { ...gateway, tokenSource: "stored" } as ModelProviderRow;
    await expect(
      resolveGatewayToken({ provider: stored, workspaceId: "ws-1", ownerUserId: "alice" }),
    ).resolves.toBe("shared-token");
    expect(mockRetrieveGatewayTokenSecret).not.toHaveBeenCalled();

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

  it("reads nothing from an answer of another shape or past the entry cap", () => {
    expect(parseModelInfo({ data: "everything" })).toEqual([]);
    expect(parseModelInfo({ data: [{ model_name: "m", model_info: "not an object" }] })).toEqual(
      [],
    );
    const many = Array.from({ length: MAX_CATALOG_ENTRIES + 1 }, (_, i) => ({ id: `m${i}` }));
    expect(parseModelList({ data: many })).toEqual([]);
    expect(
      parseModelInfo({ data: many.map((m) => ({ model_name: m.id, model_info: {} })) }),
    ).toEqual([]);
    expect(parseModelList({ data: many.slice(0, 3) })).toEqual(["m0", "m1", "m2"]);
  });

  it("skips ids that aren't valid model ids", () => {
    const long = "x".repeat(201);
    expect(
      parseModelInfo({
        data: [
          { model_name: long, model_info: {} },
          { model_name: 42, model_info: {} },
          { model_name: " ok ", model_info: null },
        ],
      }),
    ).toEqual([{ id: "ok" }]);
    expect(parseModelList({ data: [{ id: long }, { id: { nested: true } }, { id: "b" }] })).toEqual(
      ["b"],
    );
  });

  it("refuses a gateway answer larger than the body cap", async () => {
    const row = gateway;
    const big = JSON.stringify({ data: [{ id: "a", pad: "y".repeat(MAX_GATEWAY_BODY_BYTES) }] });
    setGatewayFetchForTests(async () => new Response(big, { status: 200 }));
    expect(await listGatewayModels(row, "https://litellm.example.com", "t")).toMatchObject({
      status: 200,
      ids: [],
    });
    // A declared length past the cap isn't read at all.
    setGatewayFetchForTests(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "a" }] }), {
          status: 200,
          headers: { "content-length": String(MAX_GATEWAY_BODY_BYTES + 1) },
        }),
    );
    expect((await listGatewayModels(row, "https://litellm.example.com", "t")).ids).toEqual([]);
    // Within it: read as usual.
    setGatewayFetchForTests(async () => Response.json({ data: [{ id: "a" }] }));
    expect((await listGatewayModels(row, "https://litellm.example.com", "t")).ids).toEqual(["a"]);
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
    return hit.body === undefined
      ? new Response(null, { status: hit.status })
      : Response.json(hit.body, { status: hit.status });
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

describe("gateway guarded HTTP transport", () => {
  it("sends a token only to the administrator-allowed endpoint and refuses its redirect", async () => {
    const received: Array<{ url: string; auth: string | undefined }> = [];
    const server = createServer((req, res) => {
      received.push({ url: req.url ?? "", auth: req.headers.authorization });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/credential-sink" });
        res.end();
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "internal-model" }] }));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const restore = setOutboundDefaults({
      policy: { allowPrivate: false, allowedHosts: ["127.0.0.1"], allowAll: false },
    });
    try {
      const url = `http://127.0.0.1:${address.port}`;
      const response = await gatewayFetch()(`${url}/v1/models`, {
        headers: { Authorization: "Bearer owner-token" },
      });
      expect(await response.json()).toEqual({ data: [{ id: "internal-model" }] });
      await expect(
        gatewayFetch()(`${url}/redirect`, { headers: { Authorization: "Bearer owner-token" } }),
      ).rejects.toThrow();
      expect(received).toEqual([
        { url: "/v1/models", auth: "Bearer owner-token" },
        { url: "/redirect", auth: "Bearer owner-token" },
      ]);
    } finally {
      restore();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
