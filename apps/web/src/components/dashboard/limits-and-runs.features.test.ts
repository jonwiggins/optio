import { describe, it, expect } from "vitest";
import { featuresFromEnv } from "@optio/shared/features";
import { collectProviderLimits } from "./limits-panel";
import { runTone } from "./recent-runs";

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

describe("runTone for an open merge request", () => {
  it("reads MR open for a GitLab merge request, by its URL or the feature lists", () => {
    expect(
      runTone("pr_opened", { prUrl: "https://gitlab.example.com/g/p/-/merge_requests/3" }).label,
    ).toBe("MR open");
    expect(
      runTone("pr_opened", { features: featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal" }) })
        .label,
    ).toBe("MR open");
    expect(runTone("pr_opened", { features: featuresFromEnv({}) }).label).toBe("PR open");
    expect(runTone("pr_opened", { platform: "gitlab" }).label).toBe("MR open");
    // Either way, the tooltip says what it waits on.
    expect(runTone("pr_opened").title).toBe("Waiting for review or merge");
  });
});
