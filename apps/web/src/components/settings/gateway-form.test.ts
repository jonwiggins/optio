import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@optio/shared";
import {
  emptyProviderForm,
  formFromProvider,
  toCreateInput,
  toUpdateInput,
  toggleAgent,
  validateProviderForm,
  withKind,
} from "./model-provider-form";
import {
  claudeNameWindowWarning,
  cleanGatewayModels,
  gatewaySummary,
  modelLimitsHint,
  withEffort,
} from "./gateway-form";

const saved: ModelProvider = {
  id: "p1",
  workspaceId: "ws",
  ownerUserId: null,
  ownerName: null,
  kind: "bedrock",
  name: "Bedrock",
  agents: ["claude-code"],
  region: "us-west-2",
  models: { "claude-code": [{ id: "us.anthropic.claude-opus-5-5", label: "Opus 5.5" }] },
  localAwsProfile: null,
  podCredential: "access-key",
  hasPodCredentials: true,
  baseUrl: null,
  authHeader: "bearer",
  syncUrl: null,
  lastSyncedAt: null,
  tokenSource: "personal",
  mine: false,
  canEdit: true,
  createdAt: "",
  updatedAt: "",
};

const gateway: ModelProvider = {
  ...saved,
  id: "g1",
  kind: "gateway",
  name: "LiteLLM",
  agents: ["claude-code", "opencode"],
  region: "",
  models: {
    "claude-code": [
      {
        id: "claude-sonnet-internal",
        label: "Sonnet (internal)",
        contextWindow: 200000,
        maxOutputTokens: 32000,
        efforts: ["low", "medium", "high"],
        defaultEffort: "high",
        prices: { input: 3, output: 15 },
        role: "sonnet",
      },
      { id: "claude-old", missing: true },
    ],
    opencode: [{ id: "gpt-internal" }],
  },
  podCredential: "none",
  hasPodCredentials: false,
  baseUrl: "https://litellm.example.com",
  authHeader: "api-key",
  syncUrl: "https://litellm.example.com/admin",
  lastSyncedAt: "2026-10-20T00:00:00.000Z",
};

describe("model gateway form (docs/model-gateway.md)", () => {
  it("starts a gateway with Claude Code, personal tokens and an empty catalog", () => {
    const f = emptyProviderForm(true, "gateway");
    expect(f.kind).toBe("gateway");
    expect(f.name).toBe("Model gateway");
    expect(f.agents).toEqual(["claude-code"]);
    expect(f.models["claude-code"]).toEqual([]);
    expect(f.tokenSource).toBe("personal");
    expect(f.authHeader).toBe("bearer");
    // A newly served agent starts empty too — Sync fills it, not Bedrock's suggestions.
    expect(toggleAgent(f, "opencode", true).models.opencode).toEqual([]);
  });

  it("switches a new provider's kind, keeping the owner and a name you typed", () => {
    const bedrock = { ...emptyProviderForm(false), name: "Acme" };
    const g = withKind(bedrock, "gateway", false);
    expect(g.kind).toBe("gateway");
    expect(g.owner).toBe("me");
    expect(g.name).toBe("Acme");
    expect(withKind(emptyProviderForm(true), "gateway", true).name).toBe("Model gateway");
    expect(withKind(g, "gateway", false)).toBe(g);
  });

  it("validates the URL, the shared token and the catalog", () => {
    const f = emptyProviderForm(true, "gateway");
    expect(validateProviderForm(f, true)).toMatch(/Where does the gateway listen/);
    expect(validateProviderForm({ ...f, baseUrl: "litellm" }, true)).toMatch(/base URL/);
    const ok = { ...f, baseUrl: "https://litellm.example.com/" };
    expect(validateProviderForm(ok, true)).toBeNull();
    expect(validateProviderForm({ ...ok, syncUrl: "nope" }, true)).toMatch(/sync URL/);
    expect(validateProviderForm({ ...ok, tokenSource: "stored" }, true)).toMatch(/shared token/);
    expect(
      validateProviderForm({ ...ok, tokenSource: "stored", bearerToken: "t" }, true),
    ).toBeNull();
    expect(validateProviderForm({ ...ok, models: { "claude-code": [{ id: " " }] } }, true)).toMatch(
      /needs an id/,
    );
    expect(
      validateProviderForm({ ...ok, models: { "claude-code": [{ id: "a" }, { id: "a" }] } }, true),
    ).toMatch(/twice/);
    expect(
      validateProviderForm(
        {
          ...ok,
          models: { "claude-code": [{ id: "a", efforts: ["low"], defaultEffort: "max" }] },
        },
        true,
      ),
    ).toMatch(/default effort/);
    // Bedrock's region rule doesn't apply.
    expect(validateProviderForm({ ...ok, region: "" }, true)).toBeNull();
  });

  it("builds a gateway's create body: normalized URLs, pods by token source, a clean catalog", () => {
    const f = {
      ...emptyProviderForm(true, "gateway"),
      name: " LiteLLM ",
      baseUrl: " https://litellm.example.com/ ",
      syncUrl: "",
      authHeader: "api-key" as const,
      models: {
        "claude-code": [
          {
            id: " claude-sonnet-internal ",
            label: " Sonnet ",
            contextWindow: 200000.7,
            maxOutputTokens: 0,
            efforts: ["low", "high", "turbo"],
            defaultEffort: "high",
            prices: { input: 3, output: undefined },
            role: "sonnet" as const,
          },
          { id: "" },
        ],
      },
    };
    const body = toCreateInput(f);
    expect(body).toEqual({
      name: "LiteLLM",
      owner: "workspace",
      kind: "gateway",
      agents: ["claude-code"],
      models: {
        "claude-code": [
          {
            id: "claude-sonnet-internal",
            label: "Sonnet",
            contextWindow: 200000,
            efforts: ["low", "high"],
            defaultEffort: "high",
            prices: { input: 3 },
            role: "sonnet",
          },
        ],
      },
      baseUrl: "https://litellm.example.com",
      authHeader: "api-key",
      syncUrl: null,
      tokenSource: "personal",
      podCredential: "none",
    });
    expect(body).not.toHaveProperty("region");
    expect(body).not.toHaveProperty("credentials");

    const stored = toCreateInput({ ...f, tokenSource: "stored", bearerToken: " shared " });
    expect(stored.podCredential).toBe("bearer-token");
    expect(stored.credentials).toEqual({ type: "bearer-token", bearerToken: "shared" });
  });

  it("round-trips a saved gateway and updates it without touching a token it never had", () => {
    const f = formFromProvider(gateway);
    expect(f.kind).toBe("gateway");
    expect(f.baseUrl).toBe("https://litellm.example.com");
    expect(f.syncUrl).toBe("https://litellm.example.com/admin");
    expect(f.authHeader).toBe("api-key");
    expect(validateProviderForm(f, false)).toBeNull();
    const body = toUpdateInput(f, gateway);
    expect(body).toMatchObject({
      name: "LiteLLM",
      agents: ["claude-code", "opencode"],
      baseUrl: "https://litellm.example.com",
      syncUrl: "https://litellm.example.com/admin",
      tokenSource: "personal",
      podCredential: "none",
    });
    expect(body.models?.["claude-code"]?.[1]).toEqual({ id: "claude-old", missing: true });
    expect(body).not.toHaveProperty("credentials");
    expect(body).not.toHaveProperty("owner");
    expect(body).not.toHaveProperty("region");
  });

  it("keeps a catalog row's default effort among the efforts it takes", () => {
    const m = { id: "m", efforts: ["low", "high"], defaultEffort: "high" };
    expect(withEffort(m, "high", false)).toEqual({
      id: "m",
      efforts: ["low"],
      defaultEffort: "low",
    });
    expect(withEffort(m, "max", true).efforts).toEqual(["low", "high", "max"]);
    expect(withEffort({ id: "m", efforts: ["low"] }, "low", false).defaultEffort).toBeUndefined();
  });

  it("drops what the API shouldn't see and summarizes for the list", () => {
    expect(cleanGatewayModels([{ id: "a", prices: {} }, { id: "" }])).toEqual([{ id: "a" }]);
    expect(modelLimitsHint({ contextWindow: 200000, maxOutputTokens: 32000 })).toBe(
      "200K context · 32K max output",
    );
    expect(modelLimitsHint({ contextWindow: 1_000_000 })).toBe("1M context");
    expect(modelLimitsHint({})).toBeNull();
  });

  it("warns that Claude Code keeps Anthropic's window for a claude-… name", () => {
    expect(claudeNameWindowWarning({ id: "claude-sonnet-internal", contextWindow: 32000 })).toMatch(
      /assumes its 200K context, not 32K/,
    );
    expect(claudeNameWindowWarning({ id: "qwen-internal", contextWindow: 32000 })).toBeNull();
    expect(claudeNameWindowWarning({ id: "claude-sonnet-4-5", contextWindow: 200000 })).toBeNull();
    expect(claudeNameWindowWarning({ id: "claude-x" })).toBeNull();
    expect(gatewaySummary(gateway, () => "2h ago")).toBe(
      "Personal tokens · 3 models (1 missing) · synced 2h ago",
    );
    expect(
      gatewaySummary({ ...gateway, lastSyncedAt: null, tokenSource: "stored" }, () => ""),
    ).toBe("Shared token · 3 models (1 missing) · never synced");
  });
});
