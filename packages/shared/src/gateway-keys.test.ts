import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATEWAY_KEY_DEFAULTS,
  gatewayKeyAliasPart,
  gatewayKeyDefaultsOf,
  gatewayKeyModesOf,
  isValidGatewayDuration,
  personalGatewayKeyAlias,
} from "./gateway-keys.js";
import { gatewayBudgetPeriodFor, isGatewayBudgetPeriod } from "./model-gateways.js";

describe("gateway key modes", () => {
  it("reads a gateway saved before modes existed as pasting only", () => {
    expect(gatewayKeyModesOf(null)).toEqual({ personalPasted: true, optioIssued: false });
    expect(gatewayKeyModesOf("garbage")).toEqual({ personalPasted: true, optioIssued: false });
  });

  it("keeps what is stored, and never both off", () => {
    expect(gatewayKeyModesOf({ personalPasted: false, optioIssued: true })).toEqual({
      personalPasted: false,
      optioIssued: true,
    });
    expect(gatewayKeyModesOf({ optioIssued: true })).toEqual({
      personalPasted: true,
      optioIssued: true,
    });
    expect(gatewayKeyModesOf({ personalPasted: false, optioIssued: false })).toEqual({
      personalPasted: true,
      optioIssued: false,
    });
  });
});

describe("gateway key defaults", () => {
  it("fills in what is missing", () => {
    expect(gatewayKeyDefaultsOf(null)).toEqual(DEFAULT_GATEWAY_KEY_DEFAULTS);
    expect(gatewayKeyDefaultsOf({ maxBudget: 5 })).toEqual({
      ...DEFAULT_GATEWAY_KEY_DEFAULTS,
      maxBudget: 5,
    });
  });

  it("keeps an explicit null (no cap, never resets) and drops bad values", () => {
    expect(
      gatewayKeyDefaultsOf({
        maxBudget: "7.5",
        budgetDuration: null,
        keyDuration: "forever",
        models: ["a", "a", "", 3, "b"],
      }),
    ).toEqual({
      maxBudget: 7.5,
      budgetDuration: null,
      keyDuration: null,
      models: ["a", "b"],
    });
  });

  it("takes LiteLLM's durations only", () => {
    for (const ok of ["30d", "1mo", "12h", "45m", "2w", "90s"]) {
      expect(isValidGatewayDuration(ok), ok).toBe(true);
    }
    for (const bad of ["", "30", "d", "0d", "30 days", "1y", "-1d", "12345d"]) {
      expect(isValidGatewayDuration(bad), bad).toBe(false);
    }
  });
});

describe("key aliases", () => {
  it("names a person's key after their email's local part", () => {
    expect(personalGatewayKeyAlias({ email: "Bob@example.test", name: "Bob Smith" })).toBe(
      "optio-bob",
    );
    expect(personalGatewayKeyAlias({ email: "bob.smith+x@example.test" })).toBe(
      "optio-bob.smith-x",
    );
    expect(personalGatewayKeyAlias({ email: "", name: "Bob Smith" })).toBe("optio-bob-smith");
    expect(personalGatewayKeyAlias({})).toBe("optio-user");
  });

  it("keeps alias parts short and clean", () => {
    expect(gatewayKeyAliasPart("--Weird__Name--")).toBe("weird__name");
    expect(gatewayKeyAliasPart("x".repeat(80))).toHaveLength(40);
    expect(gatewayKeyAliasPart("!!!")).toBe("user");
  });
});

describe("budget periods per gateway type", () => {
  it("takes any LiteLLM duration, and OpenRouter's daily, weekly and monthly resets", () => {
    expect(isGatewayBudgetPeriod("litellm", "12h")).toBe(true);
    expect(isGatewayBudgetPeriod("openrouter", "12h")).toBe(false);
    expect(isGatewayBudgetPeriod("openrouter", "1w")).toBe(true);
  });

  it("moves a period to the nearest one OpenRouter takes", () => {
    expect(gatewayBudgetPeriodFor("openrouter", "12h")).toBe("1d");
    expect(gatewayBudgetPeriodFor("openrouter", "5d")).toBe("1w");
    expect(gatewayBudgetPeriodFor("openrouter", "30d")).toBe("1mo");
    expect(gatewayBudgetPeriodFor("openrouter", null)).toBeNull();
    expect(gatewayBudgetPeriodFor("openrouter", "soon")).toBeNull();
    expect(gatewayBudgetPeriodFor("litellm", "30d")).toBe("30d");
  });
});
