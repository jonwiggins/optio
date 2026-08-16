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

  it("returns the baseline when no credential is configured", async () => {
    mockRetrieveSecret.mockRejectedValue(new Error("Secret not found"));
    const result = await getProviderOptions("anthropic");
    expect(result.source).toBe("baseline");
    expect(mockRetrieveSecret).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "global", undefined);
    expect(mockRetrieveSecret).toHaveBeenCalledWith("CLAUDE_CODE_OAUTH_TOKEN", "global", undefined);
  });

  it("falls back to the Claude OAuth token when no API key is configured", async () => {
    mockRetrieveSecret.mockImplementation((name: unknown) =>
      name === "CLAUDE_CODE_OAUTH_TOKEN"
        ? Promise.resolve("sk-ant-oat01-xxx")
        : Promise.reject(new Error("Secret not found")),
    );
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: "claude-new-model-id" }] }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await getProviderOptions("anthropic");
    expect(result.source).toBe("live");
    expect(result.catalog.models.some((m) => m.id === "claude-new-model-id")).toBe(true);
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-ant-oat01-xxx");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("follows pagination on the anthropic models endpoint", async () => {
    mockRetrieveSecret.mockResolvedValueOnce("sk-ant-xxx");
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ id: "claude-page-1" }],
            has_more: true,
            last_id: "claude-page-1",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "claude-page-2" }], has_more: false }),
      });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await getProviderOptions("anthropic");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(String(fetchSpy.mock.calls[1][0]));
    expect(secondUrl.searchParams.get("after_id")).toBe("claude-page-1");
    expect(result.catalog.models.some((m) => m.id === "claude-page-1")).toBe(true);
    expect(result.catalog.models.some((m) => m.id === "claude-page-2")).toBe(true);
  });

  it("uses upstream display names as labels for live models", async () => {
    mockRetrieveSecret.mockResolvedValueOnce("sk-ant-xxx");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
        }),
    }) as unknown as typeof fetch;

    const result = await getProviderOptions("anthropic");
    const added = result.catalog.models.find((m) => m.id === "claude-opus-5");
    expect(added?.label).toBe("Claude Opus 5");
    expect(added?.family).toBe("opus");
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
        models: [{ id: "claude-from-cache", displayName: "From Cache" }],
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
    const cachedModel = result.catalog.models.find((m) => m.id === "claude-from-cache");
    expect(cachedModel?.label).toBe("From Cache");
  });

  it("reads the legacy ids-only cache shape", async () => {
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
    expect(result.cached).toBe(true);
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
