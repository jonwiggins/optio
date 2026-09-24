import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import type { FastifyInstance } from "fastify";

const mockGetProviderOptions = vi.fn();
const mockInvalidateProviderCache = vi.fn();

vi.mock("../services/agent-options-service.js", () => ({
  getProviderOptions: (...args: unknown[]) => mockGetProviderOptions(...args),
  invalidateProviderCache: (...args: unknown[]) => mockInvalidateProviderCache(...args),
}));

vi.mock("../services/oauth/index.js", () => ({
  isAuthDisabled: () => false,
}));

import { agentOptionsRoutes } from "./agent-options.js";

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(agentOptionsRoutes);
}

describe("GET /api/agents/options", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns all provider catalogs", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents/options" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    const ids = body.providers.map((p: { provider: string }) => p.provider);
    expect(ids).toEqual(
      expect.arrayContaining(["anthropic", "openai", "gemini", "copilot", "opencode", "openclaw"]),
    );
  });
});

describe("GET /api/agents/:provider/options", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns the provider options", async () => {
    mockGetProviderOptions.mockResolvedValue({
      catalog: {
        provider: "anthropic",
        models: [],
        aliases: {},
        options: [],
        liveRefreshSupported: true,
        label: "Claude Code",
        modelField: "claudeModel",
      },
      source: "baseline",
      cached: false,
      refreshedAt: null,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/agents/anthropic/options",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe("anthropic");
    expect(body.source).toBe("baseline");
    expect(body.cached).toBe(false);
    expect(mockGetProviderOptions).toHaveBeenCalledWith("anthropic", {
      workspaceId: "ws-1",
      forceRefresh: false,
      machines: { userId: expect.anything(), hostId: undefined },
    });
  });

  it("honours the refresh query param", async () => {
    mockGetProviderOptions.mockResolvedValue({
      catalog: {
        provider: "anthropic",
        models: [],
        aliases: {},
        options: [],
        liveRefreshSupported: true,
        label: "Claude Code",
        modelField: "claudeModel",
      },
      source: "live",
      cached: false,
      refreshedAt: 1700000000,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/agents/anthropic/options?refresh=true",
    });

    expect(res.statusCode).toBe(200);
    expect(mockInvalidateProviderCache).toHaveBeenCalledWith("anthropic");
    expect(mockGetProviderOptions).toHaveBeenCalledWith("anthropic", {
      workspaceId: "ws-1",
      forceRefresh: true,
      machines: expect.objectContaining({ userId: expect.anything() }),
    });
  });

  it("rejects an unknown provider id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/agents/bogus/options",
    });
    expect(res.statusCode).toBe(400);
    expect(mockGetProviderOptions).not.toHaveBeenCalled();
  });

  it("surfaces the live-probe error when the fallback kicked in", async () => {
    mockGetProviderOptions.mockResolvedValue({
      catalog: {
        provider: "anthropic",
        models: [],
        aliases: {},
        options: [],
        liveRefreshSupported: true,
        label: "Claude Code",
        modelField: "claudeModel",
      },
      source: "baseline",
      cached: false,
      refreshedAt: null,
      error: "Anthropic /v1/models returned 401",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/agents/anthropic/options?refresh=true",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().error).toBe("Anthropic /v1/models returned 401");
  });

  it("asks for one machine's Codex list and says where it came from", async () => {
    mockGetProviderOptions.mockResolvedValue({
      catalog: {
        provider: "openai",
        models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: ["low", "ultra"] }],
        aliases: {},
        options: [],
        liveRefreshSupported: true,
        label: "OpenAI Codex",
        modelField: "copilotModel",
      },
      source: "live",
      cached: false,
      refreshedAt: 1700000000,
      liveFrom: "Codex on MacBook-Pro",
    });
    const hostId = "6c95f3f7-577f-4d98-8766-27dc670de253";

    const res = await app.inject({
      method: "GET",
      url: `/api/agents/openai/options?hostId=${hostId}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().liveFrom).toBe("Codex on MacBook-Pro");
    expect(res.json().catalog.models[0].efforts).toEqual(["low", "ultra"]);
    expect(mockGetProviderOptions).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({ machines: expect.objectContaining({ hostId }) }),
    );
  });

  it("rejects a hostId that isn't a uuid", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents/openai/options?hostId=x" });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/agents/:provider/options/refresh", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("invalidates the cache and reprobes", async () => {
    mockGetProviderOptions.mockResolvedValue({
      catalog: {
        provider: "gemini",
        models: [],
        aliases: {},
        options: [],
        liveRefreshSupported: true,
        label: "Google Gemini",
        modelField: "geminiModel",
      },
      source: "live",
      cached: false,
      refreshedAt: 1700000000,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/agents/gemini/options/refresh",
    });

    expect(res.statusCode).toBe(200);
    expect(mockInvalidateProviderCache).toHaveBeenCalledWith("gemini");
    expect(mockGetProviderOptions).toHaveBeenCalledWith("gemini", {
      workspaceId: "ws-1",
      forceRefresh: true,
      machines: expect.objectContaining({ userId: expect.anything() }),
    });
  });

  it("rejects non-admin callers", async () => {
    const nonAdminApp = await buildRouteTestApp(agentOptionsRoutes, {
      user: { id: "user-2", workspaceId: "ws-1", workspaceRole: "member" },
    });

    const res = await nonAdminApp.inject({
      method: "POST",
      url: "/api/agents/anthropic/options/refresh",
    });

    expect(res.statusCode).toBe(403);
  });
});
