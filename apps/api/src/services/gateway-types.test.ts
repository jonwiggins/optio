/**
 * The gateway types' pure parts (docs/model-gateway.md "Gateway types"):
 * OpenRouter's catalog, key info and reset times, Portkey's usage limits,
 * the catalog merge for gateways that list many models, an Anthropic-style
 * paged `/v1/models`, and which driver a type gets. The key APIs themselves
 * are tested against in-process fakes in gateway-key-types.int.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyDriver, adminBaseOf } from "./gateway-admin.js";
import {
  listGatewayModels,
  mergeGatewayCatalog,
  openRouterKeyInfo,
  parseOpenRouterModels,
  setGatewayFetchForTests,
} from "./model-gateway-service.js";
import { openRouterLimitReset, openRouterResetAt, openRouterSpend } from "./openrouter-admin.js";
import { portkeyUsageLimits } from "./portkey-admin.js";
import { carriedInSpend } from "./gateway-key-carry.js";
import { FAKE_OPENROUTER_MODELS } from "../test-utils/fake-openrouter.js";
import type { ModelProviderRow } from "./model-provider-service.js";

afterEach(() => setGatewayFetchForTests(null));

describe("OpenRouter", () => {
  it("reads context lengths, output limits and per-token prices from its model list", () => {
    expect(parseOpenRouterModels({ data: FAKE_OPENROUTER_MODELS })).toEqual([
      {
        id: "anthropic/claude-sonnet-4.5",
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
      { id: "qwen/qwen3-coder", contextWindow: 262_144, prices: { input: 0.2, output: 0.8 } },
      // A router's "-1" prices vary per request: left out.
      { id: "openrouter/auto", contextWindow: 2_000_000 },
    ]);
    expect(parseOpenRouterModels({})).toEqual([]);
  });

  it("maps budget periods to its resets, and finds when a reset falls (UTC)", () => {
    expect(openRouterLimitReset("1d")).toBe("daily");
    expect(openRouterLimitReset("7d")).toBe("weekly");
    expect(openRouterLimitReset("30d")).toBe("monthly");
    expect(openRouterLimitReset(null)).toBeNull();
    // Saturday 2026-10-24 15:00 UTC.
    const sat = new Date("2026-10-24T15:00:00Z");
    expect(openRouterResetAt("daily", sat)).toBe("2026-10-25T00:00:00.000Z");
    expect(openRouterResetAt("weekly", sat)).toBe("2026-10-26T00:00:00.000Z");
    expect(openRouterResetAt("monthly", sat)).toBe("2026-11-01T00:00:00.000Z");
    // A Monday's week ends the next Monday.
    expect(openRouterResetAt("weekly", new Date("2026-10-26T09:00:00Z"))).toBe(
      "2026-11-02T00:00:00.000Z",
    );
    expect(openRouterResetAt(null, sat)).toBeNull();
  });

  it("reads a key's spend as its limit less what remains, else the period's usage", () => {
    const now = new Date("2026-10-24T15:00:00Z");
    expect(
      openRouterSpend(
        {
          limit: 10,
          limit_remaining: 6.5,
          limit_reset: "monthly",
          usage_monthly: 1,
          disabled: false,
        },
        now,
      ),
    ).toEqual({
      spend: 3.5,
      maxBudget: 10,
      budgetResetAt: "2026-11-01T00:00:00.000Z",
      budgetDuration: "1mo",
      blocked: false,
    });
    expect(
      openRouterSpend({ limit: null, limit_remaining: null, usage: 7, disabled: true }, now),
    ).toMatchObject({ spend: 7, maxBudget: null, budgetResetAt: null, blocked: true });
  });

  it("answers a token's own info in the shape the health checks read", () => {
    const body = openRouterKeyInfo(
      {
        data: {
          label: "sk-or-v1-abc...xyz",
          limit: 5,
          limit_remaining: 0,
          limit_reset: "daily",
          expires_at: "2027-01-01T00:00:00Z",
        },
      },
      new Date("2026-10-24T15:00:00Z"),
    );
    expect(body).toEqual({
      info: {
        spend: 5,
        max_budget: 5,
        budget_reset_at: "2026-10-25T00:00:00.000Z",
        budget_duration: "1d",
        expires: "2027-01-01T00:00:00Z",
        blocked: false,
        key_alias: "sk-or-v1-abc...xyz",
      },
    });
  });
});

describe("carried spend, read as LiteLLM keeps it", () => {
  it("counts every amount still on the key until its own period starts over", () => {
    const key = {
      createdAt: new Date("2026-10-20T00:00:00Z"),
      budgetDuration: "1mo",
      carriedSpend: [
        { usd: 2, until: "2026-11-01T00:00:00.000Z" },
        { usd: 1.5, until: null },
      ],
    };
    // Before and after an amount's own end: the check hasn't taken it off yet.
    expect(carriedInSpend(key, new Date("2026-10-25T00:00:00Z"))).toBe(3.5);
    expect(carriedInSpend(key, new Date("2026-11-02T00:00:00Z"))).toBe(3.5);
    // Past the key's own first period: none.
    expect(carriedInSpend(key, new Date("2026-11-20T00:00:00Z"))).toBe(0);
    expect(carriedInSpend({ ...key, carriedSpend: null }, new Date("2026-10-25T00:00:00Z"))).toBe(
      0,
    );
  });
});

describe("Portkey", () => {
  it("writes a budget as a cost limit with one way to reset", () => {
    expect(portkeyUsageLimits(5, "1mo")).toEqual({
      type: "cost",
      credit_limit: 5,
      periodic_reset: "monthly",
    });
    expect(portkeyUsageLimits(5, "1w")).toEqual({
      type: "cost",
      credit_limit: 5,
      periodic_reset: "weekly",
    });
    expect(portkeyUsageLimits(5, "30d")).toEqual({
      type: "cost",
      credit_limit: 5,
      periodic_reset_days: 30,
    });
    expect(portkeyUsageLimits(5, null)).toEqual({ type: "cost", credit_limit: 5 });
    expect(portkeyUsageLimits(null, "1mo")).toBeNull();
  });
});

describe("the catalog merge for a gateway that lists many models", () => {
  const existing = [{ id: "a", label: "A" }, { id: "gone" }];
  it("refreshes only the listed models when it mustn't add any", () => {
    expect(
      mergeGatewayCatalog(existing, [{ id: "a", contextWindow: 100 }], ["a", "b", "c"], {
        addNew: false,
      }),
    ).toEqual([
      { id: "a", label: "A", contextWindow: 100 },
      { id: "gone", missing: true },
    ]);
  });

  it("adds new ids up to a cap", () => {
    const merged = mergeGatewayCatalog(existing, [], ["a", "b", "c", "d"], { maxModels: 3 });
    expect(merged.map((m) => m.id)).toEqual(["a", "gone", "b"]);
  });
});

describe("an Anthropic-style paged /v1/models", () => {
  it("reads every page by after_id, with the version header", async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }], has_more: true, last_id: "m2" }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "m3" }], has_more: false, last_id: "m3" }), {
          status: 200,
        }),
      );
    setGatewayFetchForTests(fetch);
    const row = {
      gatewayType: "generic",
      authHeader: "api-key",
      baseUrl: "https://gateway.example.com",
    } as ModelProviderRow;
    const listed = await listGatewayModels(row, "https://gateway.example.com", "sk-1");
    expect(listed).toMatchObject({ status: 200, ids: ["m1", "m2", "m3"] });
    expect(fetch.mock.calls[1][0]).toBe(
      "https://gateway.example.com/v1/models?after_id=m2&limit=1000",
    );
    const headers = fetch.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers).toMatchObject({ "x-api-key": "sk-1", "anthropic-version": "2023-06-01" });
  });
});

describe("drivers and admin URLs per type", () => {
  const row = (gatewayType: string, syncUrl: string | null = null) =>
    ({ gatewayType, baseUrl: "https://gw.example.com", syncUrl }) as ModelProviderRow;

  it("picks the driver for the type, and none for a generic gateway", () => {
    const admin = { base: "https://gw.example.com", adminKey: "k" };
    expect(keyDriver(admin).type).toBe("litellm");
    expect(keyDriver({ ...admin, type: "openrouter" })).toMatchObject({
      carry: "limit",
      teams: false,
    });
    expect(keyDriver({ ...admin, type: "portkey" })).toMatchObject({ carry: null, teams: false });
    expect(keyDriver({ ...admin, type: "litellm" })).toMatchObject({ carry: "spend", teams: true });
    expect(() => keyDriver({ ...admin, type: "generic" })).toThrow(/doesn't make keys/);
  });

  it("finds each type's admin API", () => {
    expect(adminBaseOf(row("litellm"))).toBe("https://gw.example.com");
    expect(adminBaseOf(row("litellm", "https://admin.example.com/"))).toBe(
      "https://admin.example.com",
    );
    expect(adminBaseOf(row("openrouter"))).toBe("https://gw.example.com/v1");
    expect(adminBaseOf(row("portkey"))).toBe("https://gw.example.com/v1");
    expect(adminBaseOf(row("portkey", "https://portkey-cp.example.com"))).toBe(
      "https://portkey-cp.example.com",
    );
  });
});
