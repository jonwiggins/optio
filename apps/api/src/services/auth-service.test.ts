import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────
// Mock heavy dependencies so the module can be imported in isolation.

const mockRecordAuthEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("./auth-failure-detector.js", () => ({
  recordAuthEvent: (...args: unknown[]) => mockRecordAuthEvent(...args),
}));

const mockPublishEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("./event-bus.js", () => ({
  publishEvent: (...args: unknown[]) => mockPublishEvent(...args),
}));

vi.mock("./secret-service.js", () => ({
  retrieveSecret: vi.fn().mockResolvedValue(null),
}));

vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Stub getClaudeAuthToken — default: token available
vi.mock("./auth-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./auth-service.js")>();
  return {
    ...original,
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

// We need to control `getClaudeAuthToken` and `fetch` from inside the module.
// Since getClaudeAuthToken is a module-level function, we mock the child_process
// and fs modules it depends on, then override the credential cache via
// the module's own functions.  However, it's simpler to mock `fetch` and provide
// a token via the secret-service fallback path.

const { retrieveSecret } = await import("./secret-service.js");
const mockedRetrieveSecret = vi.mocked(retrieveSecret);

// Re-import the function under test AFTER mocks are in place.
const { getClaudeUsage, invalidateUsageCache } = await import("./auth-service.js");

// ── Tests ───────────────────────────────────────────────────────────────────

describe("getClaudeUsage — auth failure handling", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateUsageCache();
    originalFetch = globalThis.fetch;
    // Provide a token via the secrets-store fallback path
    mockedRetrieveSecret.mockResolvedValue("test-oauth-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("records auth event and publishes auth:failed on 401", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const result = await getClaudeUsage();

    expect(result.available).toBe(false);
    expect(result.error).toBe("Usage API returned 401");

    // Should record the auth failure event
    expect(mockRecordAuthEvent).toHaveBeenCalledWith(
      "claude",
      "Usage API returned 401",
      "usage-endpoint",
    );

    // Should publish a WebSocket auth:failed event
    expect(mockPublishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "auth:failed",
        message: expect.stringContaining("expired"),
      }),
    );
  });

  it("records auth event and publishes auth:failed on 403", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve("Forbidden"),
    });

    const result = await getClaudeUsage();

    expect(result.available).toBe(false);
    expect(result.error).toBe("Usage API returned 403");

    expect(mockRecordAuthEvent).toHaveBeenCalledWith(
      "claude",
      "Usage API returned 403",
      "usage-endpoint",
    );
    expect(mockPublishEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "auth:failed" }));
  });

  it("does NOT record auth event on non-auth errors (e.g. 500)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const result = await getClaudeUsage();

    expect(result.available).toBe(false);
    expect(result.error).toBe("Usage API returned 500");
    expect(mockRecordAuthEvent).not.toHaveBeenCalled();
    expect(mockPublishEvent).not.toHaveBeenCalled();
  });

  it("still returns the error result even if recordAuthEvent throws", async () => {
    mockRecordAuthEvent.mockRejectedValueOnce(new Error("db down"));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const result = await getClaudeUsage();

    expect(result.available).toBe(false);
    expect(result.error).toBe("Usage API returned 401");
  });

  it("still returns the error result even if publishEvent throws", async () => {
    mockPublishEvent.mockRejectedValueOnce(new Error("redis down"));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const result = await getClaudeUsage();

    expect(result.available).toBe(false);
    expect(result.error).toBe("Usage API returned 401");
  });

  it("returns cached result for successful usage calls", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          five_hour: { utilization: 0.5, resets_at: "2026-04-20T12:00:00Z" },
          seven_day: null,
          seven_day_sonnet: null,
          seven_day_opus: null,
        }),
    });

    const first = await getClaudeUsage();
    expect(first.available).toBe(true);
    expect(first.fiveHour?.utilization).toBe(0.5);

    // Second call should use cache
    const second = await getClaudeUsage();
    expect(second).toEqual(first);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
