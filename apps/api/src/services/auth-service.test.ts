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

  it("lifts per-model weekly limits (Fable) out of the limits list", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          five_hour: { utilization: 26, resets_at: "2026-09-19T23:20:00Z" },
          seven_day: { utilization: 50, resets_at: "2026-09-20T20:59:59Z" },
          limits: [
            { kind: "session", group: "session", percent: 26, severity: "normal" },
            { kind: "weekly_all", group: "weekly", percent: 50, severity: "normal" },
            {
              kind: "weekly_scoped",
              group: "weekly",
              percent: 98,
              severity: "critical",
              resets_at: "2026-09-20T20:59:59Z",
              scope: { model: { id: null, display_name: "Fable" }, surface: null },
            },
            { kind: "weekly_scoped", percent: 3, scope: { model: null, surface: "cowork" } },
          ],
        }),
    });

    const result = await getClaudeUsage();
    expect(result.sevenDayModels).toEqual([
      { model: "Fable", utilization: 98, resetsAt: "2026-09-20T20:59:59Z", severity: "critical" },
    ]);
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

describe("getClaudeUsage — rate limits and transient failures", () => {
  let originalFetch: typeof globalThis.fetch;
  const good = {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        five_hour: { utilization: 42, resets_at: "2026-09-18T20:00:00Z" },
        seven_day: { utilization: 10, resets_at: null },
      }),
  };
  const rateLimited = (retryAfter?: string) => ({
    ok: false,
    status: 429,
    headers: { get: (k: string) => (k === "retry-after" ? (retryAfter ?? null) : null) },
    text: () => Promise.resolve("Rate limited"),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T17:00:00Z"));
    invalidateUsageCache();
    originalFetch = globalThis.fetch;
    mockedRetrieveSecret.mockResolvedValue("test-oauth-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("backs off after a 429 instead of going upstream on every poll", async () => {
    const fetchMock = vi.fn().mockResolvedValue(rateLimited());
    globalThis.fetch = fetchMock;

    const first = await getClaudeUsage();
    expect(first).toEqual({ available: false, error: "Usage API returned 429" });

    // Every poll inside the backoff window is answered from memory.
    for (let i = 0; i < 5; i++) await getClaudeUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    await getClaudeUsage();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After for the backoff window", async () => {
    const fetchMock = vi.fn().mockResolvedValue(rateLimited("300"));
    globalThis.fetch = fetchMock;
    await getClaudeUsage();
    vi.advanceTimersByTime(200_000);
    await getClaudeUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(101_000);
    await getClaudeUsage();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves the last good numbers flagged stale while a refresh fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(good);
    globalThis.fetch = fetchMock;
    const ok = await getClaudeUsage();
    expect(ok.available).toBe(true);
    expect(ok.fiveHour?.utilization).toBe(42);
    expect(ok.stale).toBeUndefined();

    // Cache expires; the refresh is rate-limited.
    vi.advanceTimersByTime(5 * 60_000 + 1);
    fetchMock.mockResolvedValue(rateLimited());
    const stale = await getClaudeUsage();
    expect(stale.available).toBe(true);
    expect(stale.stale).toBe(true);
    expect(stale.fiveHour?.utilization).toBe(42);
    expect(stale.error).toBe("Usage API returned 429");
    expect(stale.asOf).toBe("2026-09-18T17:00:00.000Z");

    // Backoff elapses, upstream recovers: fresh numbers, no stale flag.
    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValue(good);
    const fresh = await getClaudeUsage();
    expect(fresh.stale).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not serve stale numbers after an auth failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(good);
    globalThis.fetch = fetchMock;
    await getClaudeUsage();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: () => Promise.resolve("Unauthorized"),
    });
    const result = await getClaudeUsage();
    expect(result.available).toBe(false);
    expect(result.stale).toBeUndefined();
  });

  it("backs off on network errors too", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    globalThis.fetch = fetchMock;
    expect(await getClaudeUsage()).toEqual({
      available: false,
      error: "Failed to reach usage API",
    });
    await getClaudeUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
