import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import type { FastifyInstance } from "fastify";
import { modelBelongsToAgentCatalog } from "@optio/shared";

// ─── Mocks ───

const mockGetSettings = vi.fn();
const mockUpsertSettings = vi.fn();

const mockModelBelongsToAgent = vi.fn(async (agentType: string, model: string) =>
  modelBelongsToAgentCatalog(agentType, model),
);
vi.mock("../services/agent-options-service.js", () => ({
  modelBelongsToAgent: (...args: unknown[]) =>
    mockModelBelongsToAgent(...(args as [string, string])),
}));

// A model gateway of the workspace (docs/model-gateway.md): serves nothing unless a test says.
const mockGatewayServesModel = vi.fn(async () => false);
vi.mock("../services/model-gateway-service.js", () => ({
  gatewayServesModel: (...args: unknown[]) => mockGatewayServesModel(...(args as [])),
}));

vi.mock("../services/optio-settings-service.js", () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  upsertSettings: (...args: unknown[]) => mockUpsertSettings(...args),
}));

import { optioSettingsRoutes } from "./optio-settings.js";

// ─── Helpers ───

const defaultSettings = {
  id: "set-1",
  model: "sonnet",
  systemPrompt: "",
  enabledTools: [],
  confirmWrites: true,
  maxTurns: 20,
  workspaceId: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(optioSettingsRoutes);
}

describe("PUT /api/optio/settings with OPTIO_RUNTIMES narrowed", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("OPTIO_RUNTIMES", "claude-code,opencode");
    mockGetSettings.mockResolvedValue(defaultSettings);
    mockUpsertSettings.mockResolvedValue(defaultSettings);
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses an assistant harness or review agent outside the list", async () => {
    const harness = await app.inject({
      method: "PUT",
      url: "/api/optio/settings",
      payload: { agentRuntime: "codex" },
    });
    expect(harness.statusCode).toBe(400);
    expect(harness.json().error).toBe("codex isn't available in this deployment");

    const review = await app.inject({
      method: "PUT",
      url: "/api/optio/settings",
      payload: { defaultReviewAgentType: "gemini" },
    });
    expect(review.statusCode).toBe(400);
    expect(review.json().error).toBe("gemini isn't available in this deployment");
    expect(mockUpsertSettings).not.toHaveBeenCalled();
  });

  it("takes the listed runtimes, and the default takes the rest", async () => {
    const ok = await app.inject({
      method: "PUT",
      url: "/api/optio/settings",
      payload: { agentRuntime: "opencode", defaultReviewAgentType: "claude-code" },
    });
    expect(ok.statusCode).toBe(200);

    vi.stubEnv("OPTIO_RUNTIMES", "");
    const full = await app.inject({
      method: "PUT",
      url: "/api/optio/settings",
      payload: { agentRuntime: "codex" },
    });
    expect(full.statusCode).toBe(200);
  });
});
