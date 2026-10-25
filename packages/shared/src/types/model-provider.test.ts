import { describe, it, expect } from "vitest";
import { featuresFromEnv } from "../config/features.js";
import {
  gatewayModelPick,
  gatewayRuntime,
  gatewayTokenSecretName,
  isValidGatewayUrl,
  normalizeGatewayBaseUrl,
  offeredModelProviderKinds,
  type GatewayRuntimeSource,
} from "./model-provider.js";

const gateway: GatewayRuntimeSource = {
  baseUrl: "https://litellm.example.com",
  authHeader: "bearer",
  models: {
    "claude-code": [
      {
        id: "claude-sonnet-internal",
        label: "Sonnet (internal)",
        contextWindow: 200000,
        maxOutputTokens: 32000,
        efforts: ["low", "medium", "high"],
        defaultEffort: "high",
        role: "sonnet",
      },
      { id: "claude-haiku-internal", role: "haiku", contextWindow: 50000 },
      { id: "claude-opus-internal", role: "opus", missing: true },
    ],
    opencode: [{ id: "gpt-internal" }],
  },
};

describe("offeredModelProviderKinds", () => {
  it("offers both kinds by default and the gateway alone with OPTIO_MODEL_ACCESS=gateway", () => {
    expect(offeredModelProviderKinds(featuresFromEnv({}))).toEqual(["bedrock", "gateway"]);
    expect(offeredModelProviderKinds(featuresFromEnv({ OPTIO_MODEL_ACCESS: "gateway" }))).toEqual([
      "gateway",
    ]);
  });
});

describe("gatewayRuntime", () => {
  it("builds the Claude Code env from the pick and the catalog", () => {
    const { env, codexConfig } = gatewayRuntime(
      "claude-code",
      gateway,
      { model: "claude-sonnet-internal", effort: "medium" },
      "sk-token",
    );
    expect(codexConfig).toEqual([]);
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "https://litellm.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-token",
      ANTHROPIC_MODEL: "claude-sonnet-internal",
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-internal",
      // The opus model is missing from the gateway: the pick stands in.
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-sonnet-internal",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-internal",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-internal",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      CLAUDE_CODE_EFFORT_LEVEL: "medium",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    });
  });

  it("uses ANTHROPIC_API_KEY for an api-key gateway and strips a trailing slash", () => {
    const { env } = gatewayRuntime(
      "claude-code",
      { ...gateway, baseUrl: "https://litellm.example.com/", authHeader: "api-key" },
      { model: "claude-haiku-internal" },
      "sk-token",
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("https://litellm.example.com");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-token");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("leaves out limits the catalog doesn't state and unknown efforts; declares small windows", () => {
    const { env } = gatewayRuntime(
      "claude-code",
      gateway,
      { model: "claude-haiku-internal", effort: "max" },
      null,
    );
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env).not.toHaveProperty("CLAUDE_CODE_MAX_OUTPUT_TOKENS");
    // Smaller than the 200k Claude Code would assume: declared, so it compacts in time.
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("50000");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("50000");
    expect(env).not.toHaveProperty("CLAUDE_CODE_EFFORT_LEVEL");
    expect(env.ANTHROPIC_MODEL).toBe("claude-haiku-internal");
  });

  it("points OpenCode at the OpenAI-compatible /v1 with the same token", () => {
    const { env } = gatewayRuntime("opencode", gateway, { model: "gpt-internal" }, "sk-token");
    expect(env).toEqual({
      OPENAI_BASE_URL: "https://litellm.example.com/v1",
      OPENAI_API_KEY: "sk-token",
      OPTIO_OPENCODE_MODEL: "gpt-internal",
    });
  });
});

describe("gatewayTokenSecretName", () => {
  it("follows the auth header, and is OPENAI_API_KEY for an OpenCode-only gateway", () => {
    expect(gatewayTokenSecretName({ authHeader: "bearer" })).toBe("ANTHROPIC_AUTH_TOKEN");
    expect(gatewayTokenSecretName({ authHeader: "api-key" })).toBe("ANTHROPIC_API_KEY");
    expect(gatewayTokenSecretName({ authHeader: "bearer", agents: ["opencode"] })).toBe(
      "OPENAI_API_KEY",
    );
    expect(
      gatewayTokenSecretName({ authHeader: "bearer", agents: ["claude-code", "opencode"] }),
    ).toBe("ANTHROPIC_AUTH_TOKEN");
  });
});

describe("gatewayModelPick", () => {
  it("takes the work's model and effort when the catalog has them", () => {
    expect(
      gatewayModelPick(gateway, "claude-code", {
        claudeModel: "claude-sonnet-internal",
        claudeEffort: "low",
      }),
    ).toEqual({ model: "claude-sonnet-internal", effort: "low" });
  });

  it("falls back to the model's default effort and to the first served model", () => {
    expect(
      gatewayModelPick(gateway, "claude-code", {
        claudeModel: "claude-sonnet-internal",
        claudeEffort: "max",
      }),
    ).toEqual({ model: "claude-sonnet-internal", effort: "high" });
    expect(gatewayModelPick(gateway, "claude-code", null)).toEqual({
      model: "claude-sonnet-internal",
      effort: "high",
    });
    expect(gatewayModelPick(gateway, "opencode", { opencodeModel: " " })).toEqual({
      model: "gpt-internal",
    });
    expect(gatewayModelPick(gateway, "codex", null)).toBeNull();
  });
});

describe("gateway URLs", () => {
  it("accepts http(s) origins without a trailing slash", () => {
    expect(isValidGatewayUrl("https://litellm.example.com")).toBe(true);
    expect(isValidGatewayUrl("http://10.0.0.5:4000")).toBe(true);
    expect(isValidGatewayUrl("https://litellm.example.com/")).toBe(false);
    expect(isValidGatewayUrl("litellm.example.com")).toBe(false);
    expect(isValidGatewayUrl("ftp://x")).toBe(false);
    expect(normalizeGatewayBaseUrl(" https://a.b/// ")).toBe("https://a.b");
  });
});
