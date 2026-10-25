import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setGatewayFetchForTests } from "./model-gateway-service.js";
import {
  LiteLLMError,
  blockKey,
  checkAdminKey,
  deleteKeys,
  generateKey,
  isAliasTaken,
  isTeamMissing,
  keySpend,
  liteLLMKeyHash,
  setKeySpend,
  teamSpend,
} from "./litellm-admin.js";

const admin = { base: "https://litellm.example.test", adminKey: "sk-master" };

function answer(status: number, body: unknown) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function stub(...answers: Array<[number, unknown]>) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  for (const [status, body] of answers) fetch.mockResolvedValueOnce(answer(status, body));
  setGatewayFetchForTests(fetch);
  return fetch;
}

afterEach(() => setGatewayFetchForTests(null));

describe("LiteLLM's key management", () => {
  it("names a key by the SHA-256 of its value, as LiteLLM does", () => {
    expect(liteLLMKeyHash("sk-abc")).toBe(createHash("sha256").update("sk-abc").digest("hex"));
  });

  it("generates with the admin key and only the fields given", async () => {
    const fetch = stub([200, { key: "sk-new", key_alias: "optio-bob", expires: null }]);
    const made = await generateKey(admin, {
      keyAlias: "optio-bob",
      userId: "bob@example.test",
      models: ["qwen-internal"],
      maxBudget: 5,
      budgetDuration: "30d",
      duration: null,
    });
    expect(made).toEqual({
      key: "sk-new",
      keyHash: liteLLMKeyHash("sk-new"),
      keyAlias: "optio-bob",
      expiresAt: null,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://litellm.example.test/key/generate");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-master");
    expect(JSON.parse(String(init?.body))).toEqual({
      key_alias: "optio-bob",
      user_id: "bob@example.test",
      models: ["qwen-internal"],
      max_budget: 5,
      budget_duration: "30d",
    });
  });

  it("starts a key from a spend only when there is one", async () => {
    const fetch = stub([200, { key: "sk-a" }], [200, { key: "sk-b" }]);
    await generateKey(admin, { keyAlias: "a", models: [], maxBudget: 5, spend: 3.25 });
    await generateKey(admin, { keyAlias: "b", models: [], maxBudget: 5, spend: 0 });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ spend: 3.25 });
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).not.toHaveProperty("spend");
  });

  it("takes LiteLLM's own id for the key when it gives one", async () => {
    const id = "a".repeat(64);
    stub([200, { key: "sk-new", token_id: id, expires: "2027-01-01T00:00:00Z" }]);
    const made = await generateKey(admin, { keyAlias: "k", models: [] });
    expect(made.keyHash).toBe(id);
    expect(made.expiresAt?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("says why LiteLLM refused, and spots a taken alias", async () => {
    stub([
      400,
      {
        error: {
          message:
            "Unique key aliases across all keys are required. Key alias=optio-bob already exists.",
        },
      },
    ]);
    const err = await generateKey(admin, { keyAlias: "optio-bob", models: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(LiteLLMError);
    expect(err.message).toMatch(/\/key\/generate answered 400: Unique key aliases/);
    expect(isAliasTaken(err)).toBe(true);
    expect(isAliasTaken(new LiteLLMError("x", 400, "Budget exceeded"))).toBe(false);

    stub([401, { detail: "Authentication Error" }]);
    const refused = await generateKey(admin, { keyAlias: "k", models: [] }).catch((e) => e);
    expect(refused.status).toBe(401);
    expect(refused.message).toMatch(/refused the admin key/);
  });

  it("spots a LiteLLM team someone removed", async () => {
    // LiteLLM's own wording on /key/generate and /team/update, and the fake's.
    expect(
      isTeamMissing(
        new LiteLLMError(
          "x",
          404,
          "Team doesn't exist in db. Team=team-1. Create team via `/team/new` call.",
        ),
      ),
    ).toBe(true);
    expect(isTeamMissing(new LiteLLMError("x", 400, "Team not found: team-1"))).toBe(true);
    expect(isTeamMissing(new LiteLLMError("x", 400, "Key alias=optio-team-x already exists"))).toBe(
      false,
    );
    expect(isTeamMissing(new LiteLLMError("x", 502, "Team not found"))).toBe(false);
    expect(isTeamMissing(new Error("Team not found"))).toBe(false);
  });

  it("sets a key's spend, never below zero", async () => {
    const fetch = stub([200, { key: "h", spend: 0 }], [200, { key: "h", spend: 1.5 }]);
    await setKeySpend(admin, "h", -0.25);
    await setKeySpend(admin, "h", 1.5);
    expect(fetch.mock.calls[0][0]).toBe("https://litellm.example.test/key/update");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ key: "h", spend: 0 });
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ key: "h", spend: 1.5 });
    stub([500, "boom"]);
    await expect(setKeySpend(admin, "h", 1)).rejects.toBeInstanceOf(LiteLLMError);
  });

  it("an unreachable gateway is a 502 naming the cause", async () => {
    setGatewayFetchForTests(() => Promise.reject(new Error("connect ECONNREFUSED")));
    const err = await deleteKeys(admin, ["h"]).catch((e) => e);
    expect(err).toMatchObject({ status: 502 });
    expect(err.message).toMatch(/Couldn't reach the gateway: connect ECONNREFUSED/);
  });

  it("a key LiteLLM no longer has counts as deleted", async () => {
    stub([404, { detail: "not found" }]);
    await expect(deleteKeys(admin, ["h"])).resolves.toBeUndefined();
    stub([400, { error: { message: "Key not found" } }]);
    await expect(deleteKeys(admin, ["h"])).resolves.toBeUndefined();
    stub([500, "boom"]);
    await expect(deleteKeys(admin, ["h"])).rejects.toBeInstanceOf(LiteLLMError);
  });

  it("blocks, or deletes where LiteLLM has no /key/block", async () => {
    stub([200, { blocked: true }]);
    expect(await blockKey(admin, "h")).toBe("blocked");
    const fetch = stub([404, { detail: "Not Found" }], [200, { deleted_keys: ["h"] }]);
    expect(await blockKey(admin, "h")).toBe("deleted");
    expect(fetch.mock.calls[1][0]).toBe("https://litellm.example.test/key/delete");
  });

  it("reads a key's and a team's spend", async () => {
    stub([
      200,
      {
        info: {
          spend: 4.2,
          max_budget: 5,
          budget_reset_at: "2026-11-01T00:00:00Z",
          budget_duration: "30d",
        },
      },
    ]);
    expect(await keySpend(admin, "h")).toEqual({
      spend: 4.2,
      maxBudget: 5,
      budgetResetAt: "2026-11-01T00:00:00Z",
      budgetDuration: "30d",
      blocked: false,
    });
    stub([200, { team_id: "t", team_info: { spend: "1.5", max_budget: null } }]);
    expect(await teamSpend(admin, "t")).toMatchObject({ spend: 1.5, maxBudget: null });
    stub([404, {}]);
    expect(await teamSpend(admin, "t")).toBeNull();
  });

  it("tries the admin key against /key/list, never throwing", async () => {
    stub([200, { keys: [] }]);
    expect(await checkAdminKey(admin)).toEqual({ ok: true });
    stub([403, { detail: "not a proxy admin" }]);
    expect((await checkAdminKey(admin)).error).toMatch(/refused the admin key \(403\)/);
    stub([404, "Not Found"]);
    expect((await checkAdminKey(admin)).error).toMatch(/is it LiteLLM/);
  });
});
