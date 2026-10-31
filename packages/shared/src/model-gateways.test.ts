import { describe, expect, it } from "vitest";
import {
  MODEL_GATEWAY_TYPES,
  MODEL_GATEWAY_TYPE_INFO,
  gatewayTypeTakesAuthHeader,
  isModelGatewayType,
  modelGatewayCapabilities,
  modelGatewayTypeInfo,
  modelGatewayTypeOf,
} from "./model-gateways.js";
import { gatewayRuntime, type GatewayRuntimeSource } from "./types/model-provider.js";

describe("gateway types", () => {
  it("lists every type by its label, and reads a missing or unknown one as LiteLLM", () => {
    const labels = MODEL_GATEWAY_TYPES.map((t) => MODEL_GATEWAY_TYPE_INFO[t].label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(MODEL_GATEWAY_TYPES).toEqual(["litellm", "generic", "openrouter", "portkey"]);
    expect(modelGatewayTypeOf(null)).toBe("litellm");
    expect(modelGatewayTypeOf("nope")).toBe("litellm");
    expect(modelGatewayTypeOf("generic")).toBe("generic");
    expect(modelGatewayTypeOf("portkey")).toBe("portkey");
    expect(isModelGatewayType("generic")).toBe(true);
    expect(isModelGatewayType("openrouter")).toBe(true);
    expect(isModelGatewayType("bedrock")).toBe(false);
  });

  it("says what each type supports", () => {
    expect(modelGatewayCapabilities("litellm")).toEqual({
      catalog: true,
      catalogDetails: true,
      catalogAddsModels: true,
      tokenBudget: true,
    });
    expect(modelGatewayCapabilities("generic")).toEqual({
      catalog: true,
      catalogDetails: false,
      catalogAddsModels: true,
      tokenBudget: false,
    });
    // OpenRouter lists hundreds of models: Sync details the listed ones only.
    expect(modelGatewayCapabilities("openrouter")).toEqual({
      catalog: true,
      catalogDetails: true,
      catalogAddsModels: false,
      tokenBudget: true,
    });
    // Portkey's key API reports no usage for a key: no budget panel.
    expect(modelGatewayCapabilities("portkey")).toEqual({
      catalog: true,
      catalogDetails: false,
      catalogAddsModels: true,
      tokenBudget: false,
    });
  });

  it("takes only the auth headers and URLs each type supports", () => {
    expect(gatewayTypeTakesAuthHeader("litellm", "api-key")).toBe(true);
    expect(gatewayTypeTakesAuthHeader("generic", "api-key")).toBe(true);
    expect(gatewayTypeTakesAuthHeader("openrouter", "api-key")).toBe(false);
    expect(gatewayTypeTakesAuthHeader("portkey", "api-key")).toBe(false);
    expect(gatewayTypeTakesAuthHeader("portkey", "bearer")).toBe(true);
    expect(modelGatewayTypeInfo("openrouter")).toMatchObject({
      hosted: true,
      baseUrlExample: "https://openrouter.ai/api",
      syncUrlLabel: null,
    });
    expect(modelGatewayTypeInfo("portkey")).toMatchObject({
      hosted: true,
      baseUrlExample: "https://api.portkey.ai",
      syncUrlLabel: null,
    });
    expect(modelGatewayTypeInfo("litellm").hosted).toBe(false);
  });
});

describe("gatewayRuntime per type", () => {
  const source = (type: GatewayRuntimeSource["type"]): GatewayRuntimeSource => ({
    type,
    baseUrl: "https://gateway.example.com",
    authHeader: "bearer",
    models: { "claude-code": [{ id: "m" }] },
  });

  it("gives OpenRouter its token as ANTHROPIC_AUTH_TOKEN, with no ANTHROPIC_API_KEY beside it", () => {
    const { env } = gatewayRuntime("claude-code", source("openrouter"), { model: "m" }, "sk-or");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
  });

  it("sends Portkey's token in its own header too, and no header without a token", () => {
    const { env } = gatewayRuntime("claude-code", source("portkey"), { model: "m" }, "pk-1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("pk-1");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-portkey-api-key: pk-1");
    const bare = gatewayRuntime("claude-code", source("portkey"), { model: "m" }, null).env;
    expect(bare).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
    expect(bare).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("adds no header for LiteLLM, a generic gateway or OpenCode on Portkey", () => {
    for (const type of ["litellm", "generic", undefined] as const) {
      const { env } = gatewayRuntime("claude-code", source(type), { model: "m" }, "t");
      expect(env).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
    }
    const opencode = gatewayRuntime("opencode", source("portkey"), { model: "m" }, "pk-1").env;
    expect(opencode).toEqual({
      OPENAI_BASE_URL: "https://gateway.example.com/v1",
      OPENAI_API_KEY: "pk-1",
      OPTIO_OPENCODE_MODEL: "m",
    });
  });
});
