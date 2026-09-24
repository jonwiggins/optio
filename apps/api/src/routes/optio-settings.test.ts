import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockGetSettings = vi.fn();
const mockUpsertSettings = vi.fn();

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

// ─── Tests ───

describe("GET /api/optio/settings", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns current settings", async () => {
    mockGetSettings.mockResolvedValue(defaultSettings);

    const res = await app.inject({ method: "GET", url: "/api/optio/settings" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settings.model).toBe("sonnet");
    expect(body.settings.confirmWrites).toBe(true);
    expect(body.settings.maxTurns).toBe(20);
    expect(mockGetSettings).toHaveBeenCalledWith("ws-1");
  });

  it("returns settings with custom values", async () => {
    mockGetSettings.mockResolvedValue({
      ...defaultSettings,
      model: "opus",
      systemPrompt: "Always use TypeScript",
      enabledTools: ["list_tasks", "create_task"],
      confirmWrites: false,
      maxTurns: 10,
    });

    const res = await app.inject({ method: "GET", url: "/api/optio/settings" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settings.model).toBe("opus");
    expect(body.settings.systemPrompt).toBe("Always use TypeScript");
    expect(body.settings.enabledTools).toEqual(["list_tasks", "create_task"]);
    expect(body.settings.confirmWrites).toBe(false);
    expect(body.settings.maxTurns).toBe(10);
  });
});

describe("PUT /api/optio/settings", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates settings with valid input", async () => {
    const updated = {
      ...defaultSettings,
      model: "opus",
      maxTurns: 30,
    };
    mockUpsertSettings.mockResolvedValue(updated);

    const res = await app.inject({
      method: "PUT",
      url: "/api/optio/settings",
      payload: { model: "opus", maxTurns: 30 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settings.model).toBe("opus");
    expect(body.settings.maxTurns).toBe(30);
    expect(mockUpsertSettings).toHaveBeenCalledWith({ model: "opus", maxTurns: 30 }, "ws-1");
  });

  it("updates system prompt", async () => {
    const updated = {
      ...defaultSettings,
      systemPrompt: "Use conventional commits",
    };
    mockUpsertSettings.mockResolvedValue(updated);

    const res = await app.inject({
      method: "PUT",
      url: "/api/optio/settings",
      payload: { systemPrompt: "Use conventional commits" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settings.systemPrompt).toBe("Use conventional commits");
  });

  it("updates enabled tools", async () => {
    const updated = {
      ...defaultSettings,
      enabledTools: ["list_tasks", "get_cost_analytics"],
    };
    mockUpsertSettings.mockResolvedValue(updated);

    const res = await app.inject({
      method: "PUT",
      url: "/api/optio/settings",
      payload: { enabledTools: ["list_tasks", "get_cost_analytics"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settings.enabledTools).toEqual(["list_tasks", "get_cost_analytics"]);
  });

  it("updates confirmWrites", async () => {
    const updated = { ...defaultSettings, confirmWrites: false };
    mockUpsertSettings.mockResolvedValue(updated);

    const res = await app.inject({
      method: "PUT",
      url: "/api/optio/settings",
      payload: { confirmWrites: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settings.confirmWrites).toBe(false);
  });

  it("rejects invalid model", async () => {
    for (const model of ["gpt-4", "claude opus", "", "constructor"]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/optio/settings",
        payload: { model },
      });
      expect(res.statusCode, model).toBe(400);
    }
  });

  it("accepts every alias and a pinned Claude id the baseline doesn't list", async () => {
    mockUpsertSettings.mockResolvedValue(defaultSettings);
    for (const model of ["opus", "sonnet", "haiku", "fable", "claude-opus-5-5"]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/optio/settings",
        payload: { model },
      });
      expect(res.statusCode, model).toBe(200);
      expect(mockUpsertSettings).toHaveBeenLastCalledWith({ model }, "ws-1");
    }
  });

  it("rejects maxTurns below 5", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/optio/settings",
      payload: { maxTurns: 2 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects maxTurns above 50", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/optio/settings",
      payload: { maxTurns: 100 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects empty enabledTools array", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/optio/settings",
      payload: { enabledTools: [] },
    });

    expect(res.statusCode).toBe(400);
  });
});
