import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// Gateway types (docs/model-gateway.md "Gateway types"): what OpenRouter and
// Portkey are asked, how their answers are read, and which headers carry
// the token.

vi.mock("./secret-service.js", () => ({
  retrieveGatewayTokenSecret: vi.fn(),
  storeSecret: vi.fn(),
}));
vi.mock("../db/client.js", () => ({ db: {} }));

import {
  MAX_CATALOG_ENTRIES,
  gatewayKeyInfo,
  gatewayKeyInfoRaw,
  gatewayTest,
  openRouterKeyInfo,
  parseOpenRouterModels,
  setGatewayFetchForTests,
} from "./model-gateway-service.js";
import { openRouterResetAt, openRouterSpend, parseOpenRouterKey } from "./openrouter-key.js";
import type { ModelProviderRow } from "./model-provider-service.js";
import { setOutboundDefaults } from "../utils/outbound-url.js";

/** What OpenRouter's `/api/v1/models` lists, prices as USD-per-token strings. */
const OPENROUTER_MODELS = [
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Anthropic: Claude Sonnet 4.5",
    context_length: 1_000_000,
    pricing: {
      prompt: "0.000003",
      completion: "0.000015",
      input_cache_read: "0.0000003",
      input_cache_write: "0.00000375",
    },
    top_provider: { context_length: 1_000_000, max_completion_tokens: 64_000 },
  },
  {
    id: "qwen/qwen3-coder",
    context_length: 262_144,
    pricing: { prompt: "0.0000002", completion: "0.0000008" },
    top_provider: { context_length: 262_144, max_completion_tokens: null },
  },
  {
    id: "openrouter/auto",
    context_length: 2_000_000,
    pricing: { prompt: "-1", completion: "-1" },
    top_provider: null,
  },
  { id: "", context_length: 1 },
  { id: "x".repeat(201) },
];

const row = (gatewayType: string, baseUrl = "https://gateway.example.com") =>
  ({ gatewayType, baseUrl, authHeader: "bearer", syncUrl: null }) as unknown as ModelProviderRow;

afterEach(() => setGatewayFetchForTests(null));

describe("OpenRouter's answers", () => {
  it("reads context lengths, output limits and per-token prices from its model list", () => {
    expect(parseOpenRouterModels({ data: OPENROUTER_MODELS })).toEqual([
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
  });

  it("reads nothing from an answer of another shape or one too long", () => {
    expect(parseOpenRouterModels({})).toEqual([]);
    expect(parseOpenRouterModels({ data: { id: "m" } })).toEqual([]);
    expect(parseOpenRouterModels("not json")).toEqual([]);
    const tooMany = Array.from({ length: MAX_CATALOG_ENTRIES + 1 }, (_, i) => ({ id: `m${i}` }));
    expect(parseOpenRouterModels({ data: tooMany })).toEqual([]);
  });

  it("reads a key's spend as its limit less what remains, else the period's usage", () => {
    const now = new Date("2026-10-24T15:00:00Z");
    expect(
      openRouterSpend(
        { limit: 10, limit_remaining: 6.5, limit_reset: "monthly", usage_monthly: 1 },
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
    // A negative or non-numeric amount is no amount.
    expect(openRouterSpend({ limit: -5, usage: "lots" }, now)).toMatchObject({
      spend: 0,
      maxBudget: null,
    });
  });

  it("resets at the next UTC midnight, Monday or 1st", () => {
    const saturday = new Date("2026-10-24T15:00:00Z");
    expect(openRouterResetAt("daily", saturday)).toBe("2026-10-25T00:00:00.000Z");
    expect(openRouterResetAt("weekly", saturday)).toBe("2026-10-26T00:00:00.000Z");
    expect(openRouterResetAt("weekly", new Date("2026-10-26T01:00:00Z"))).toBe(
      "2026-11-02T00:00:00.000Z",
    );
    expect(openRouterResetAt("monthly", saturday)).toBe("2026-11-01T00:00:00.000Z");
    expect(openRouterResetAt(null, saturday)).toBeNull();
  });

  it("answers a token's own info in LiteLLM's /key/info shape, and nothing for garbage", () => {
    expect(
      openRouterKeyInfo(
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
      ),
    ).toEqual({
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
    expect(openRouterKeyInfo({ data: { limit: { nested: true } } })).toBeNull();
    expect(openRouterKeyInfo({ info: {} })).toBeNull();
    expect(parseOpenRouterKey({ data: { label: 7 } })).toBeNull();
  });
});

describe("what each type is asked", () => {
  it("tries an OpenRouter token on /v1/key first, since anyone may list its models", async () => {
    const calls: string[] = [];
    setGatewayFetchForTests(async (url) => {
      calls.push(new URL(url).pathname);
      return new Response(null, { status: 401 });
    });
    const res = await gatewayTest(row("openrouter", "https://openrouter.ai/api"), "sk-or");
    expect(res).toEqual({ ok: false, modelCount: 0, error: "The gateway refused the token (401)" });
    expect(calls).toEqual(["/api/v1/key"]);
  });

  it("reads OpenRouter's budget from /v1/key under the base URL, and none from Portkey", async () => {
    const calls: string[] = [];
    setGatewayFetchForTests(async (url) => {
      calls.push(url);
      return Response.json({ data: { limit: 20, limit_remaining: 15, label: "jon" } });
    });
    expect(await gatewayKeyInfo(row("openrouter", "https://openrouter.ai/api"), "sk-or")).toEqual({
      spend: 5,
      maxBudget: 20,
      budgetResetAt: null,
      keyAlias: "jon",
    });
    expect(calls).toEqual(["https://openrouter.ai/api/v1/key"]);
    // Portkey reports no budget for a key: no request at all.
    expect(await gatewayKeyInfoRaw(row("portkey"), "pk")).toEqual({ status: 404, body: null });
    expect(calls).toHaveLength(1);
    // An OpenRouter answer of another shape is no budget.
    setGatewayFetchForTests(async () => Response.json({ data: "nope" }));
    expect(await gatewayKeyInfoRaw(row("openrouter"), "sk-or")).toEqual({
      status: 502,
      body: null,
    });
  });
});

describe("provider-specific credential transport", () => {
  it.each(["openrouter", "portkey"] as const)(
    "sends a %s token only through the outbound guard, in its own header, never redirected",
    async (gatewayType) => {
      const received: Array<{ url: string; bearer?: string; portkey?: string }> = [];
      let redirect = false;
      const server = createServer((req, res) => {
        received.push({
          url: req.url ?? "",
          bearer: req.headers.authorization,
          portkey: req.headers["x-portkey-api-key"] as string | undefined,
        });
        if (redirect && req.url === "/v1/models") {
          res.writeHead(302, { location: "/credential-sink" });
          res.end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            req.url === "/v1/key"
              ? { data: { limit: 5, limit_remaining: 3, label: "owner" } }
              : { data: [{ id: "m" }] },
          ),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP address");
      const gateway = row(gatewayType, `http://127.0.0.1:${address.port}`);
      let restore = setOutboundDefaults({
        policy: { allowPrivate: false, allowedHosts: [], allowAll: false },
      });
      try {
        // Not allowed: nothing is sent.
        expect((await gatewayTest(gateway, "owner-token")).ok).toBe(false);
        expect(received).toEqual([]);
        restore();
        restore = setOutboundDefaults({
          policy: { allowPrivate: false, allowedHosts: ["127.0.0.1"], allowAll: false },
        });
        expect(await gatewayTest(gateway, "owner-token")).toEqual({ ok: true, modelCount: 1 });
        if (gatewayType === "openrouter") {
          expect(await gatewayKeyInfo(gateway, "owner-token")).toMatchObject({
            spend: 2,
            maxBudget: 5,
          });
        } else {
          expect(await gatewayKeyInfo(gateway, "owner-token")).toBeNull();
        }
        redirect = true;
        expect((await gatewayTest(gateway, "owner-token")).ok).toBe(false);
        expect(received.some((r) => r.url === "/credential-sink")).toBe(false);
        for (const r of received) {
          expect({ bearer: r.bearer, portkey: r.portkey }).toEqual(
            gatewayType === "portkey"
              ? { bearer: undefined, portkey: "owner-token" }
              : { bearer: "Bearer owner-token", portkey: undefined },
          );
        }
      } finally {
        restore();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    },
  );
});
