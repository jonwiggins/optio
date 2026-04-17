import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must come before imports) ───────────────────────────────────────

const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  publish: vi.fn(),
};

vi.mock("../services/event-bus.js", () => ({
  getRedisClient: () => mockRedis,
  publishEvent: vi.fn(),
}));

vi.mock("../services/redis-config.js", () => ({
  getBullMQConnectionOptions: vi.fn().mockReturnValue({}),
}));

vi.mock("bullmq", () => {
  class MockQueue {
    add = vi.fn().mockResolvedValue({});
    close = vi.fn().mockResolvedValue(undefined);
  }
  class MockWorker {
    on = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    constructor(_name: string, _fn: unknown, _opts?: unknown) {}
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Import after mocks ─────────────────────────────────────────────────────

import {
  validateClaudeToken,
  getCachedTokenValidation,
  TOKEN_VALIDATION_CACHE_KEY,
} from "./token-validation-worker.js";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("validateClaudeToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("returns valid: true when API returns 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ usage: {} }), { status: 200 }),
    );
    const result = await validateClaudeToken("test-token");
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns valid: false when API returns 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );
    const result = await validateClaudeToken("expired-token");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("returns valid: true on network error (fail-open)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await validateClaudeToken("some-token");
    expect(result.valid).toBe(true);
  });

  it("returns valid: true when API returns 429 (rate limited but token still valid)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Too Many Requests", { status: 429 }),
    );
    const result = await validateClaudeToken("rate-limited-token");
    expect(result.valid).toBe(true);
  });

  it("sends correct headers to Anthropic API", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await validateClaudeToken("my-token");
    expect(fetchSpy).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: "Bearer my-token",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
  });
});

describe("getCachedTokenValidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed result when cache exists", async () => {
    const cached = {
      valid: false,
      lastValidated: "2026-04-17T10:00:00.000Z",
      tokenExists: true,
      error: "OAuth token has expired",
    };
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(cached));

    const result = await getCachedTokenValidation();
    expect(result).toEqual(cached);
    expect(mockRedis.get).toHaveBeenCalledWith(TOKEN_VALIDATION_CACHE_KEY);
  });

  it("returns null when no cache exists", async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    const result = await getCachedTokenValidation();
    expect(result).toBeNull();
  });

  it("returns null on Redis error", async () => {
    mockRedis.get.mockRejectedValueOnce(new Error("Redis down"));
    const result = await getCachedTokenValidation();
    expect(result).toBeNull();
  });
});
