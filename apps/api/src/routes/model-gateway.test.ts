import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockSync = vi.fn();
const mockTest = vi.fn();
const mockStatus = vi.fn();
const mockStoreToken = vi.fn();
const mockStoreOrgToken = vi.fn();
const mockSetDefault = vi.fn();
const mockUsage = vi.fn();

vi.mock("../services/model-gateway-service.js", () => ({
  syncGatewayCatalog: (...args: unknown[]) => mockSync(...args),
  testGateway: (...args: unknown[]) => mockTest(...args),
  viewerGatewayStatus: (...args: unknown[]) => mockStatus(...args),
  viewerGatewayUsage: (...args: unknown[]) => mockUsage(...args),
  storePersonalGatewayToken: (...args: unknown[]) => mockStoreToken(...args),
  storeOrganizationGatewayToken: (...args: unknown[]) => mockStoreOrgToken(...args),
  setDefaultGateway: (...args: unknown[]) => mockSetDefault(...args),
}));

const mockCreate = vi.fn();
vi.mock("../services/model-provider-service.js", () => {
  class ModelProviderError extends Error {
    constructor(
      message: string,
      readonly status: 400 | 403 | 404 = 400,
    ) {
      super(message);
    }
  }
  return {
    ModelProviderError,
    createModelProvider: (...args: unknown[]) => mockCreate(...args),
    listModelProviders: vi.fn(),
    updateModelProvider: vi.fn(),
    deleteModelProvider: vi.fn(),
  };
});
vi.mock("../services/optio-action-service.js", () => ({ logAction: vi.fn(async () => {}) }));
vi.mock("../services/oauth/index.js", () => ({ isAuthDisabled: () => false }));

import { modelGatewayRoutes } from "./model-gateway.js";
import { modelProviderRoutes } from "./model-providers.js";
import { ModelProviderError } from "../services/model-provider-service.js";

const GATEWAY_ID = "11111111-1111-4111-8111-111111111111";
const WS_ID = "22222222-2222-4222-8222-222222222222";

async function buildApp(role: "admin" | "member" | "viewer" = "admin"): Promise<FastifyInstance> {
  return buildRouteTestApp(
    async (app) => {
      await modelProviderRoutes(app);
      await modelGatewayRoutes(app);
    },
    { user: { id: "u1", workspaceId: WS_ID, workspaceRole: role } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// ─── Tests ───

describe("POST /api/model-providers (OPTIO_MODEL_ACCESS gate)", () => {
  it("refuses Bedrock with OPTIO_MODEL_ACCESS=gateway, where the gateway is the one kind", async () => {
    vi.stubEnv("OPTIO_MODEL_ACCESS", "gateway");
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers",
      payload: {
        name: "Bedrock",
        owner: "workspace",
        kind: "bedrock",
        agents: ["claude-code"],
        region: "us-west-2",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/offers gateway model providers only/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates a gateway with its catalog fields", async () => {
    vi.stubEnv("OPTIO_MODEL_ACCESS", "gateway");
    mockCreate.mockResolvedValue({ id: GATEWAY_ID, name: "Corp LiteLLM" });
    const app = await buildApp();
    const payload = {
      name: "Corp LiteLLM",
      owner: "workspace",
      kind: "gateway",
      agents: ["claude-code", "opencode"],
      baseUrl: "https://litellm.example.com",
      authHeader: "api-key",
      tokenSource: "personal",
      models: {
        "claude-code": [
          {
            id: "claude-sonnet-internal",
            contextWindow: 200000,
            maxOutputTokens: 32000,
            efforts: ["low", "high"],
            defaultEffort: "high",
            prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            role: "sonnet",
          },
        ],
      },
    };
    const res = await app.inject({ method: "POST", url: "/api/model-providers", payload });
    expect(res.statusCode).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "gateway", baseUrl: "https://litellm.example.com" }),
      expect.objectContaining({ workspaceId: WS_ID, isAdmin: true }),
    );
  });

  it("rejects a negative price and an unknown kind at the schema", async () => {
    vi.stubEnv("OPTIO_MODEL_ACCESS", "");
    const app = await buildApp();
    const bad = await app.inject({
      method: "POST",
      url: "/api/model-providers",
      payload: {
        name: "x",
        owner: "workspace",
        kind: "gateway",
        agents: ["claude-code"],
        baseUrl: "https://g",
        models: { "claude-code": [{ id: "m", prices: { input: -1 } }] },
      },
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({
      method: "POST",
      url: "/api/model-providers",
      payload: { name: "x", owner: "workspace", kind: "vertex", agents: ["claude-code"] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("still takes Bedrock by default", async () => {
    vi.stubEnv("OPTIO_MODEL_ACCESS", "");
    mockCreate.mockResolvedValue({ id: GATEWAY_ID, name: "Bedrock" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers",
      payload: {
        name: "Bedrock",
        owner: "workspace",
        kind: "bedrock",
        agents: ["claude-code"],
        region: "us-west-2",
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("POST /api/model-providers/:id/sync", () => {
  it("syncs for admins and reports what changed", async () => {
    mockSync.mockResolvedValue({ provider: { id: GATEWAY_ID }, synced: { models: 4, missing: 1 } });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/model-providers/${GATEWAY_ID}/sync`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().synced).toEqual({ models: 4, missing: 1 });
    expect(mockSync).toHaveBeenCalledWith(GATEWAY_ID, expect.objectContaining({ userId: "u1" }));
  });

  it("is admin-only and passes service errors through with their status", async () => {
    const member = await buildApp("member");
    const forbidden = await member.inject({
      method: "POST",
      url: `/api/model-providers/${GATEWAY_ID}/sync`,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(mockSync).not.toHaveBeenCalled();

    mockSync.mockRejectedValue(new ModelProviderError("Model provider not found", 404));
    const admin = await buildApp();
    const missing = await admin.inject({
      method: "POST",
      url: `/api/model-providers/${GATEWAY_ID}/sync`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("Model provider not found");
  });
});

describe("POST /api/model-providers/:id/test", () => {
  it("tries the given token, else the caller's own", async () => {
    mockTest.mockResolvedValue({ ok: true, modelCount: 3, tokenFrom: "given" });
    const app = await buildApp("member");
    const res = await app.inject({
      method: "POST",
      url: `/api/model-providers/${GATEWAY_ID}/test`,
      payload: { token: "sk-try" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, modelCount: 3, tokenFrom: "given" });
    expect(mockTest).toHaveBeenCalledWith(
      GATEWAY_ID,
      expect.objectContaining({ userId: "u1" }),
      "sk-try",
    );

    mockTest.mockResolvedValue({
      ok: false,
      modelCount: 0,
      error: "refused",
      tokenFrom: "personal",
    });
    const own = await app.inject({
      method: "POST",
      url: `/api/model-providers/${GATEWAY_ID}/test`,
      payload: {},
    });
    expect(own.json()).toMatchObject({ ok: false, tokenFrom: "personal" });
    expect(mockTest).toHaveBeenLastCalledWith(GATEWAY_ID, expect.anything(), undefined);
  });

  it("says where to add a token when the caller has none", async () => {
    mockTest.mockRejectedValue(
      new ModelProviderError("Add your gateway token under Settings → My tokens", 400),
    );
    const app = await buildApp("member");
    const res = await app.inject({
      method: "POST",
      url: `/api/model-providers/${GATEWAY_ID}/test`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Settings → My tokens/);
  });
});

describe("GET /api/gateway/me", () => {
  it("returns the viewer's standing with the default gateway", async () => {
    const status = {
      gateway: {
        id: GATEWAY_ID,
        name: "Corp LiteLLM",
        baseUrl: "https://litellm.example.com",
        authHeader: "bearer",
        tokenSource: "personal",
      },
      hasToken: true,
      keyInfo: { spend: 1.5, maxBudget: 50, budgetResetAt: null, keyAlias: "u1" },
      orgHasToken: true,
    };
    mockStatus.mockResolvedValue(status);
    const app = await buildApp("viewer");
    const res = await app.inject({ method: "GET", url: "/api/gateway/me" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(status);
    expect(mockStatus).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
  });

  it("is empty without a gateway", async () => {
    mockStatus.mockResolvedValue({
      gateway: null,
      hasToken: false,
      keyInfo: null,
      orgHasToken: false,
    });
    const app = await buildApp("member");
    const res = await app.inject({ method: "GET", url: "/api/gateway/me" });
    expect(res.json().gateway).toBeNull();
  });
});

describe("PUT /api/gateway/me/token", () => {
  it("stores the token for the named gateway (else the default) and reports the test", async () => {
    mockStoreToken.mockResolvedValue({ providerId: GATEWAY_ID, test: { ok: true, modelCount: 2 } });
    const app = await buildApp("member");
    const res = await app.inject({
      method: "PUT",
      url: "/api/gateway/me/token",
      payload: { token: "sk-mine", providerId: GATEWAY_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providerId: GATEWAY_ID, test: { ok: true, modelCount: 2 } });
    expect(mockStoreToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1" }),
      "sk-mine",
      GATEWAY_ID,
    );
    await app.inject({ method: "PUT", url: "/api/gateway/me/token", payload: { token: "t" } });
    expect(mockStoreToken).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: "u1" }),
      "t",
      undefined,
    );
  });

  it("needs a token and a gateway", async () => {
    const app = await buildApp("member");
    const empty = await app.inject({
      method: "PUT",
      url: "/api/gateway/me/token",
      payload: { token: "" },
    });
    expect(empty.statusCode).toBe(400);
    expect(mockStoreToken).not.toHaveBeenCalled();

    mockStoreToken.mockRejectedValue(
      new ModelProviderError("The workspace has no model gateway yet", 404),
    );
    const none = await app.inject({
      method: "PUT",
      url: "/api/gateway/me/token",
      payload: { token: "x" },
    });
    expect(none.statusCode).toBe(404);
  });
});

describe("PUT /api/model-providers/:id/token", () => {
  it("stores the organization's token for admins", async () => {
    mockStoreOrgToken.mockResolvedValue({
      providerId: GATEWAY_ID,
      test: { ok: true, modelCount: 1 },
    });
    const app = await buildApp("admin");
    const res = await app.inject({
      method: "PUT",
      url: `/api/model-providers/${GATEWAY_ID}/token`,
      payload: { token: "sk-org" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providerId: GATEWAY_ID, test: { ok: true, modelCount: 1 } });
    expect(mockStoreOrgToken).toHaveBeenCalledWith(
      GATEWAY_ID,
      expect.objectContaining({ isAdmin: true }),
      "sk-org",
    );
  });

  it("is admin-only", async () => {
    const app = await buildApp("member");
    const res = await app.inject({
      method: "PUT",
      url: `/api/model-providers/${GATEWAY_ID}/token`,
      payload: { token: "sk-org" },
    });
    expect(res.statusCode).toBe(403);
    expect(mockStoreOrgToken).not.toHaveBeenCalled();
  });
});

describe("PUT /api/workspaces/:id/default-gateway", () => {
  it("lets admins name (and clear) the default gateway", async () => {
    mockSetDefault.mockResolvedValue({ id: GATEWAY_ID });
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${WS_ID}/default-gateway`,
      payload: { providerId: GATEWAY_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ defaultModelProviderId: GATEWAY_ID });
    expect(mockSetDefault).toHaveBeenCalledWith(
      WS_ID,
      GATEWAY_ID,
      expect.objectContaining({ isAdmin: true }),
    );

    mockSetDefault.mockResolvedValue(null);
    const cleared = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${WS_ID}/default-gateway`,
      payload: { providerId: null },
    });
    expect(cleared.json()).toEqual({ defaultModelProviderId: null });
  });

  it("is admin-only", async () => {
    const app = await buildApp("member");
    const res = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${WS_ID}/default-gateway`,
      payload: { providerId: GATEWAY_ID },
    });
    expect(res.statusCode).toBe(403);
    expect(mockSetDefault).not.toHaveBeenCalled();
  });
});

describe("GET /api/gateway/me/usage", () => {
  it("returns the gateway's budgets for the viewer's and the organization's tokens", async () => {
    const usage = {
      gateway: { id: GATEWAY_ID, name: "Corp LiteLLM", baseUrl: "https://litellm.example.com" },
      personal: {
        hasToken: true,
        keyInfo: {
          spend: 12.5,
          maxBudget: 100,
          budgetResetAt: "2026-11-01T00:00:00Z",
          keyAlias: "u1",
        },
      },
      organization: { hasToken: true, keyInfo: null },
    };
    mockUsage.mockResolvedValue(usage);
    const app = await buildApp("member");
    const res = await app.inject({ method: "GET", url: "/api/gateway/me/usage" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(usage);
    expect(mockUsage).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
  });

  it("is empty without a gateway", async () => {
    mockUsage.mockResolvedValue({
      gateway: null,
      personal: { hasToken: false, keyInfo: null },
      organization: { hasToken: false, keyInfo: null },
    });
    const app = await buildApp("viewer");
    const res = await app.inject({ method: "GET", url: "/api/gateway/me/usage" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ gateway: null, personal: { hasToken: false } });
  });
});
