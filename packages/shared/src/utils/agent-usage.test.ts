import { describe, it, expect } from "vitest";
import {
  catalogPrice,
  costForTokens,
  priceForModel,
  stripModelContextSuffix,
  type PricedCatalogModel,
} from "./agent-usage.js";

// A gateway's catalog (docs/model-gateway.md): ids as the gateway names
// them, prices in USD / MTok from its sync.
const catalog: PricedCatalogModel[] = [
  { id: "acme-coder-large", prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  // The gateway said nothing about cache rates.
  { id: "acme-haiku", prices: { input: 1, output: 5 } },
  // Priced for nothing: unknown, never zero.
  { id: "acme-free" },
  { id: "claude-opus-5", prices: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } },
];

describe("stripModelContextSuffix", () => {
  it("drops Claude Code's [1m] suffix and leaves every other id alone", () => {
    expect(stripModelContextSuffix("claude-sonnet-5[1m]")).toBe("claude-sonnet-5");
    expect(stripModelContextSuffix("acme-coder-large[1m]")).toBe("acme-coder-large");
    expect(stripModelContextSuffix("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(stripModelContextSuffix("gpt-6.1-sol")).toBe("gpt-6.1-sol");
  });
});

describe("catalogPrice", () => {
  it("matches the exact id, [1m] ignored", () => {
    expect(catalogPrice("acme-coder-large", catalog)).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    expect(catalogPrice("acme-coder-large[1m]", catalog)).toEqual(
      catalogPrice("acme-coder-large", catalog),
    );
    // No prefix matching: a gateway id is whatever the admin named it.
    expect(catalogPrice("acme-coder", catalog)).toBeNull();
    expect(catalogPrice("acme-coder-large-2", catalog)).toBeNull();
  });

  it("defaults the cache rates to the Anthropic ratios when the gateway didn't say", () => {
    expect(catalogPrice("acme-haiku", catalog)).toEqual({
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
  });

  it("is null for a model without prices, an incomplete price, or no catalog", () => {
    expect(catalogPrice("acme-free", catalog)).toBeNull();
    expect(catalogPrice("x", [{ id: "x", prices: { input: 1 } }])).toBeNull();
    expect(catalogPrice("x", [{ id: "x", prices: { input: Number.NaN, output: 1 } }])).toBeNull();
    expect(catalogPrice("x", [{ id: "x", prices: null }])).toBeNull();
    expect(catalogPrice("acme-coder-large", [])).toBeNull();
    expect(catalogPrice("acme-coder-large", null)).toBeNull();
    expect(catalogPrice("acme-coder-large", undefined)).toBeNull();
  });
});

describe("priceForModel with a catalog", () => {
  it("consults the catalog before the built-in table", () => {
    // The public list price for opus-5 is 5 / 25; the gateway charges 1 / 2.
    expect(priceForModel("claude-opus-5", {}, catalog)).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
    expect(priceForModel("claude-opus-5")).toMatchObject({ input: 5, output: 25 });
  });

  it("prices a gateway's own id that the table doesn't know", () => {
    expect(priceForModel("acme-coder-large")).toBeNull();
    expect(priceForModel("acme-coder-large", {}, catalog)).toMatchObject({ input: 3, output: 15 });
    expect(
      costForTokens(
        { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 200 },
        priceForModel("acme-coder-large", {}, catalog)!,
      ),
    ).toBeCloseTo(0.0021, 9);
  });

  it("falls back to the table for an id the catalog doesn't price", () => {
    expect(priceForModel("claude-sonnet-5", {}, catalog)).toEqual(priceForModel("claude-sonnet-5"));
    // An unpriced catalog model is not zero: the table gets its say, then null.
    expect(priceForModel("acme-free", {}, catalog)).toBeNull();
  });
});
