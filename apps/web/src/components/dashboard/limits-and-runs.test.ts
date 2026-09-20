import { describe, it, expect } from "vitest";
import { collectProviderLimits, windowLabel } from "./limits-panel";
import { runTone } from "./recent-runs";

// Real clock: collectProviderLimits compares reset times against Date.now().
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("collectProviderLimits", () => {
  it("folds Claude account usage and the freshest Codex host snapshot", () => {
    const providers = collectProviderLimits(
      {
        available: true,
        fiveHour: { utilization: 22, resetsAt: ago(-3_600_000) },
        sevenDay: { utilization: 21, resetsAt: ago(-86_400_000) },
      },
      [
        {
          agentLimits: {
            codex: {
              primary: { usedPercent: 40, windowMinutes: 300, resetsAt: ago(-60_000) },
              secondary: { usedPercent: 8, windowMinutes: 10080, resetsAt: ago(-6_000_000) },
              planType: "pro",
              observedAt: ago(1_000),
            },
          },
        },
        {
          agentLimits: {
            codex: {
              primary: { usedPercent: 99, windowMinutes: 300, resetsAt: null },
              secondary: null,
              planType: "pro",
              observedAt: ago(9_000_000),
            },
          },
        },
      ],
    );
    expect(providers.map((p) => p.key)).toEqual(["claude", "codex"]);
    expect(providers[0].windows.map((w) => [w.label, w.window.usedPercent])).toEqual([
      ["5h", 22],
      ["7d", 21],
    ]);
    expect(providers[1].planType).toBe("pro");
    expect(providers[1].windows.map((w) => [w.label, w.window.usedPercent])).toEqual([
      ["5h", 40],
      ["7d", 8],
    ]);
  });

  it("zeroes a Codex window whose reset time has passed", () => {
    const [codex] = collectProviderLimits(null, [
      {
        agentLimits: {
          codex: {
            primary: { usedPercent: 70, windowMinutes: 300, resetsAt: ago(60_000) },
            secondary: null,
            planType: null,
            observedAt: ago(1_000_000),
          },
        },
      },
    ]);
    expect(codex.windows[0].window.usedPercent).toBe(0);
    expect(codex.windows[0].window.resetsAt).toBeNull();
  });

  it("labels windows by length", () => {
    expect(windowLabel(300, "?")).toBe("5h");
    expect(windowLabel(10080, "?")).toBe("7d");
    expect(windowLabel(90, "?")).toBe("90m");
    expect(windowLabel(null, "5h")).toBe("5h");
  });
});

describe("runTone", () => {
  it("maps the three state vocabularies onto one", () => {
    expect(runTone("running").label).toBe("running");
    expect(runTone("provisioning").label).toBe("running");
    expect(runTone("queued").label).toBe("queued");
    expect(runTone("needs_attention").label).toBe("needs attention");
    expect(runTone("pr_opened").label).toBe("PR open");
    expect(runTone("completed").label).toBe("done");
    expect(runTone("failed").label).toBe("failed");
    expect(runTone("weird_state").label).toBe("weird state");
  });
});
