import { describe, expect, it } from "vitest";
import {
  MODEL_GATEWAY_TYPES,
  MODEL_GATEWAY_TYPE_INFO,
  isModelGatewayType,
  modelGatewayCapabilities,
  modelGatewayTypeOf,
} from "./model-gateways.js";

describe("gateway types", () => {
  it("lists every type by its label, and reads a missing or unknown one as LiteLLM", () => {
    const labels = MODEL_GATEWAY_TYPES.map((t) => MODEL_GATEWAY_TYPE_INFO[t].label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(MODEL_GATEWAY_TYPES).toHaveLength(2);
    expect(modelGatewayTypeOf(null)).toBe("litellm");
    expect(modelGatewayTypeOf("nope")).toBe("litellm");
    expect(modelGatewayTypeOf("generic")).toBe("generic");
    expect(isModelGatewayType("generic")).toBe(true);
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
  });
});
