import { describe, it, expect } from "vitest";
import { featuresFromEnv } from "@optio/shared/features";
import { collectProviderLimits } from "./limits-panel";

// Real clock: collectProviderLimits compares reset times against Date.now().
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("collectProviderLimits without Codex (a restricted runtime list)", () => {
  it("leaves every host's Codex snapshot out", () => {
    const host = {
      agentLimits: {
        codex: {
          primary: { usedPercent: 40, windowMinutes: 300, resetsAt: null },
          secondary: null,
          planType: "pro",
          observedAt: ago(1_000),
        },
      },
    };
    expect(collectProviderLimits(null, [host]).map((p) => p.key)).toEqual(["codex"]);
    expect(collectProviderLimits(null, [host], { codex: false })).toEqual([]);
  });
});
