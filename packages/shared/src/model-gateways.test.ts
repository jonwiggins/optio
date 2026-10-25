import { describe, expect, it } from "vitest";
import {
  MODEL_GATEWAY_TYPES,
  MODEL_GATEWAY_TYPE_INFO,
  gatewayBudgetPeriodFor,
  gatewayBudgetProblem,
  isGatewayBudgetPeriod,
  isModelGatewayType,
  modelGatewayCapabilities,
  modelGatewayTypeOf,
} from "./model-gateways.js";
import { gatewayRuntime, type GatewayRuntimeSource } from "./types/model-provider.js";

describe("gateway types", () => {
  it("lists every type by its label, and reads a missing or unknown one as LiteLLM", () => {
    const labels = MODEL_GATEWAY_TYPES.map((t) => MODEL_GATEWAY_TYPE_INFO[t].label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(MODEL_GATEWAY_TYPES).toHaveLength(4);
    expect(modelGatewayTypeOf(null)).toBe("litellm");
    expect(modelGatewayTypeOf("nope")).toBe("litellm");
    expect(modelGatewayTypeOf("portkey")).toBe("portkey");
    expect(isModelGatewayType("openrouter")).toBe(true);
    expect(isModelGatewayType("bedrock")).toBe(false);
  });

  it("says what each type supports", () => {
    expect(modelGatewayCapabilities("litellm")).toEqual({
      catalog: true,
      catalogDetails: true,
      catalogAddsModels: true,
      tokenBudget: true,
      managedKeys: true,
      budgets: true,
      spend: true,
      keyModels: true,
    });
    expect(modelGatewayCapabilities("openrouter")).toMatchObject({
      catalogDetails: true,
      catalogAddsModels: false,
      tokenBudget: true,
      managedKeys: true,
      spend: true,
      keyModels: false,
    });
    expect(modelGatewayCapabilities("portkey")).toMatchObject({
      catalogDetails: false,
      tokenBudget: false,
      managedKeys: true,
      budgets: true,
      spend: false,
      keyModels: false,
    });
    expect(modelGatewayCapabilities("generic")).toMatchObject({
      catalog: true,
      tokenBudget: false,
      managedKeys: false,
      budgets: false,
    });
    // A type without managed keys names no admin key.
    for (const t of MODEL_GATEWAY_TYPES) {
      const info = MODEL_GATEWAY_TYPE_INFO[t];
      expect(info.adminKeyName === null, t).toBe(!info.capabilities.managedKeys);
    }
  });
});

describe("budget periods per type", () => {
  it("takes any duration on LiteLLM, OpenRouter's three resets, Portkey's weeks, months and days", () => {
    expect(isGatewayBudgetPeriod("litellm", "12h")).toBe(true);
    expect(isGatewayBudgetPeriod("openrouter", "1w")).toBe(true);
    expect(isGatewayBudgetPeriod("openrouter", "30d")).toBe(false);
    expect(isGatewayBudgetPeriod("portkey", "30d")).toBe(true);
    expect(isGatewayBudgetPeriod("portkey", "1mo")).toBe(true);
    expect(isGatewayBudgetPeriod("portkey", "400d")).toBe(false);
    expect(isGatewayBudgetPeriod("portkey", "12h")).toBe(false);
  });

  it("maps a period to the nearest one the type takes", () => {
    expect(gatewayBudgetPeriodFor("openrouter", "12h")).toBe("1d");
    expect(gatewayBudgetPeriodFor("openrouter", "7d")).toBe("1w");
    expect(gatewayBudgetPeriodFor("openrouter", "30d")).toBe("1mo");
    expect(gatewayBudgetPeriodFor("portkey", "12h")).toBe("1d");
    expect(gatewayBudgetPeriodFor("portkey", "2w")).toBe("14d");
    expect(gatewayBudgetPeriodFor("portkey", "13mo")).toBe("365d");
    expect(gatewayBudgetPeriodFor("litellm", "30d")).toBe("30d");
    expect(gatewayBudgetPeriodFor("openrouter", null)).toBeNull();
    expect(gatewayBudgetPeriodFor("openrouter", "monthly")).toBeNull();
  });

  it("refuses a Portkey budget that isn't whole USD of 1 or more", () => {
    expect(gatewayBudgetProblem("portkey", 2.5)).toMatch(/whole USD/);
    expect(gatewayBudgetProblem("portkey", 0)).toMatch(/whole USD/);
    expect(gatewayBudgetProblem("portkey", 3)).toBeNull();
    expect(gatewayBudgetProblem("portkey", null)).toBeNull();
    expect(gatewayBudgetProblem("openrouter", 2.5)).toBeNull();
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
  });

  it("sends the token as Portkey's own header too", () => {
    const { env } = gatewayRuntime("claude-code", source("portkey"), { model: "m" }, "pk-1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("pk-1");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-portkey-api-key: pk-1");
    // A launch the machine completes carries no token, so no header either.
    const bare = gatewayRuntime("claude-code", source("portkey"), { model: "m" }, null).env;
    expect(bare).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
  });

  it("adds nothing for LiteLLM, OpenRouter and a generic gateway", () => {
    for (const type of ["litellm", "generic", "openrouter", undefined] as const) {
      const { env } = gatewayRuntime("claude-code", source(type), { model: "m" }, "t");
      expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(env).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
    }
  });
});
