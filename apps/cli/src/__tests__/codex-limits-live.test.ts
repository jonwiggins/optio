import { describe, expect, it } from "vitest";
import { parseLiveCodexLimits } from "../local/codex-limits.js";

describe("parseLiveCodexLimits", () => {
  const now = new Date("2026-10-01T00:00:00Z");

  it("reads Codex's app-server rate limits, preferring the codex bucket", () => {
    expect(
      parseLiveCodexLimits(
        {
          rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 0 } },
          rateLimitsByLimitId: {
            codex: {
              primary: { usedPercent: 42.5, windowDurationMins: 300, resetsAt: 1790000000 },
              secondary: { usedPercent: 120, windowDurationMins: 10080, resetsAt: null },
              planType: "pro",
            },
          },
        },
        now,
      ),
    ).toEqual({
      primary: {
        usedPercent: 42.5,
        windowMinutes: 300,
        resetsAt: new Date(1790000000 * 1000).toISOString(),
      },
      secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: null },
      planType: "pro",
      observedAt: now.toISOString(),
    });
  });

  it("falls back to the single-bucket view and is null without windows", () => {
    expect(
      parseLiveCodexLimits({ rateLimits: { primary: { usedPercent: 5 } } }, now)?.primary
        ?.usedPercent,
    ).toBe(5);
    expect(parseLiveCodexLimits({ rateLimits: {} }, now)).toBeNull();
    expect(parseLiveCodexLimits(null, now)).toBeNull();
  });
});
