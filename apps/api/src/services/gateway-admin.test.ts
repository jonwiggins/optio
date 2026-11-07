import { afterEach, describe, expect, it, vi } from "vitest";

// The gateways' key APIs (gateway-admin.ts and its drivers): which types
// have one, where it answers, and what an answer of another shape becomes.

vi.mock("./secret-service.js", () => ({
  retrieveGatewayTokenSecret: vi.fn(),
  storeSecret: vi.fn(),
}));
vi.mock("../db/client.js", () => ({ db: {} }));

import { adminBaseOf, keyDriver } from "./gateway-admin.js";
import { adminCall } from "./gateway-admin-http.js";
import { MAX_GATEWAY_BODY_BYTES, setGatewayFetchForTests } from "./model-gateway-service.js";
import type { ModelProviderRow } from "./model-provider-service.js";

afterEach(() => setGatewayFetchForTests(null));

const row = (gatewayType: string, syncUrl: string | null = null) =>
  ({ gatewayType, baseUrl: "https://gw.example.com/api", syncUrl }) as unknown as ModelProviderRow;

describe("key drivers", () => {
  it("exist for LiteLLM and OpenRouter only", () => {
    expect(keyDriver({ type: "litellm", base: "https://x", adminKey: "k" }).carry).toBe("spend");
    expect(keyDriver({ type: "openrouter", base: "https://x", adminKey: "k" }).carry).toBe("limit");
    for (const type of ["generic", "portkey"] as const) {
      expect(() => keyDriver({ type, base: "https://x", adminKey: "k" })).toThrow(
        /doesn't make keys/,
      );
    }
  });

  it("answer where the gateway's token consent already points", () => {
    expect(adminBaseOf(row("litellm"))).toBe("https://gw.example.com/api");
    expect(adminBaseOf(row("litellm", "https://admin.example.com/"))).toBe(
      "https://admin.example.com",
    );
    expect(adminBaseOf(row("openrouter"))).toBe("https://gw.example.com/api/v1");
  });

  it("refuse a made key they can't read, rather than store garbage", async () => {
    setGatewayFetchForTests(async () => Response.json({ key: 42 }));
    await expect(
      keyDriver({ type: "litellm", base: "https://x", adminKey: "k" }).generateKey({
        keyAlias: "optio-a",
        models: ["m"],
      }),
    ).rejects.toThrow(/another shape/);
    setGatewayFetchForTests(async () =>
      Response.json({ key: "sk-or-v1-abcdef", data: { hash: "../../x" } }, { status: 201 }),
    );
    await expect(
      keyDriver({ type: "openrouter", base: "https://x", adminKey: "k" }).generateKey({
        keyAlias: "optio-a",
        models: [],
      }),
    ).rejects.toThrow(/without a key or its hash/);
    setGatewayFetchForTests(async () => Response.json({ data: { limit: "lots" } }));
    await expect(
      keyDriver({ type: "openrouter", base: "https://x", adminKey: "k" }).keySpend("abcdefgh"),
    ).resolves.toMatchObject({ spend: 0, maxBudget: null });
    setGatewayFetchForTests(async () => Response.json({ data: [] }));
    await expect(
      keyDriver({ type: "openrouter", base: "https://x", adminKey: "k" }).keySpend("abcdefgh"),
    ).rejects.toThrow(/another shape/);
  });

  it("send the admin key as a bearer token, and read no answer over the size cap", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    setGatewayFetchForTests(async (url, init) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return new Response("x".repeat(MAX_GATEWAY_BODY_BYTES + 1), { status: 200 });
    });
    const res = await adminCall("https://gw.example.com/key/list", "GET", {
      Authorization: "Bearer sk-admin",
    });
    expect(res).toEqual({ status: 200, body: null });
    expect(seen).toEqual([{ url: "https://gw.example.com/key/list", auth: "Bearer sk-admin" }]);
  });
});
