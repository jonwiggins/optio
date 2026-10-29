import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

describe("agent options with OPTIO_RUNTIMES narrowed", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("OPTIO_RUNTIMES", "claude-code,opencode");
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists only the offered runtimes' providers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents/options" });
    expect(res.statusCode).toBe(200);
    const ids = res.json().providers.map((p: { provider: string }) => p.provider);
    expect(ids).toEqual(["anthropic", "opencode"]);
  });

  it("answers 404 for a provider outside the offered runtimes, and never asks the service", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents/openai/options" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("openai isn't available in this deployment");
    const refresh = await app.inject({
      method: "POST",
      url: "/api/agents/gemini/options/refresh",
    });
    expect(refresh.statusCode).toBe(404);
    expect(mockGetProviderOptions).not.toHaveBeenCalled();
    expect(mockInvalidateProviderCache).not.toHaveBeenCalled();
  });

  it("still answers for the offered runtimes' providers", async () => {
    mockGetProviderOptions.mockResolvedValue({
      catalog: { provider: "opencode" },
      source: "baseline",
      cached: false,
      refreshedAt: null,
    });
    const res = await app.inject({ method: "GET", url: "/api/agents/opencode/options" });
    expect(res.statusCode).toBe(200);
  });
});
