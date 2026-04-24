import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRetrieveSecret = vi.fn();
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();

vi.mock("./secret-service.js", () => ({
  retrieveSecret: (...args: unknown[]) => mockRetrieveSecret(...args),
}));

vi.mock("./event-bus.js", () => ({
  getRedisClient: () => ({
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    scanStream: () => {
      return {
        on(event: string, cb: (arg?: unknown) => void) {
          if (event === "end") queueMicrotask(() => cb());
          return this;
        },
      };
    },
  }),
}));

import { getProviderOptions } from "./agent-options-service.js";

const originalFetch = globalThis.fetch;

describe("getProviderOptions", () => {
  beforeEach(() => {
    mockRetrieveSecret.mockReset();
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    mockRedisDel.mockReset();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue("OK");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the baseline when the provider doesn't support live refresh", async () => {
    const result = await getProviderOptions("copilot");
    expect(result.source).toBe("baseline");
    expect(result.cached).toBe(false);
    expect(result.catalog.provider).toBe("copilot");
    expect(mockRetrieveSecret).not.toHaveBeenCalled();
  });

  it("returns the baseline when no API key is configured", async () => {
    mockRetrieveSecret.mockRejectedValueOnce(new Error("Secret not found"));
    const result = await getProviderOptions("anthropic");
    expect(result.source).toBe("baseline");
    expect(mockRetrieveSecret).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "global", undefined);
  });

  it("probes upstream and merges when no cache entry exists", async () => {
    mockRetrieveSecret.mockResolvedValueOnce("sk-ant-xxx");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: "claude-opus-4-7" }, { id: "claude-new-model-id" }],
        }),
    }) as unknown as typeof fetch;

    const result = await getProviderOptions("anthropic");
    expect(result.source).toBe("live");
    expect(result.cached).toBe(false);
    expect(result.catalog.models.some((m) => m.id === "claude-new-model-id")).toBe(true);
    expect(mockRedisSet).toHaveBeenCalled();
  });

  it("uses the cached list when present (skipping the probe)", async () => {
    mockRetrieveSecret.mockResolvedValueOnce("sk-ant-xxx");
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({
        ids: ["claude-from-cache"],
        refreshedAt: 1700000000,
      }),
    );
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await getProviderOptions("anthropic");
    expect(result.source).toBe("live");
    expect(result.cached).toBe(true);
    expect(result.refreshedAt).toBe(1700000000);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.catalog.models.some((m) => m.id === "claude-from-cache")).toBe(true);
  });

  it("force-refresh bypasses the cache", async () => {
    mockRetrieveSecret.mockResolvedValueOnce("sk-ant-xxx");
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({ ids: ["cached-id"], refreshedAt: 1700000000 }),
    );
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: "fresh-id" }] }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await getProviderOptions("anthropic", { forceRefresh: true });
    expect(fetchSpy).toHaveBeenCalled();
    expect(result.source).toBe("live");
    expect(result.cached).toBe(false);
    expect(result.catalog.models.some((m) => m.id === "fresh-id")).toBe(true);
    expect(result.catalog.models.some((m) => m.id === "cached-id")).toBe(false);
  });

  it("falls back to baseline when the upstream probe fails", async () => {
    mockRetrieveSecret.mockResolvedValueOnce("sk-ant-xxx");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    }) as unknown as typeof fetch;

    const result = await getProviderOptions("anthropic");
    expect(result.source).toBe("baseline");
    expect(result.error).toMatch(/401/);
  });

  it("strips the `models/` prefix from gemini ids", async () => {
    mockRetrieveSecret.mockResolvedValueOnce("aiza-xxx");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          models: [{ name: "models/gemini-4-pro" }, { name: "models/gemini-3-pro" }],
        }),
    }) as unknown as typeof fetch;

    const result = await getProviderOptions("gemini");
    expect(result.source).toBe("live");
    expect(result.catalog.models.some((m) => m.id === "gemini-4-pro")).toBe(true);
    // already in the baseline — not duplicated
    const geminiThreeProEntries = result.catalog.models.filter((m) => m.id === "gemini-3-pro");
    expect(geminiThreeProEntries.length).toBe(1);
  });
});
