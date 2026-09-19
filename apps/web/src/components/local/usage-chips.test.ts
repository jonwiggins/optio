import { describe, it, expect } from "vitest";
import { accountBuckets, pctTone, resetsIn } from "./usage-chips";
import { formatTokens, formatUsd, priceForModel, costForTokens } from "@optio/shared";

describe("usage chips", () => {
  it("colors by utilization", () => {
    expect(pctTone(10)).toBe("text-text-muted");
    expect(pctTone(80)).toBe("text-warning");
    expect(pctTone(95)).toBe("text-error");
  });

  it("formats the reset countdown", () => {
    const now = Date.parse("2026-09-17T10:00:00Z");
    expect(resetsIn("2026-09-17T10:42:00Z", now)).toBe("42m");
    expect(resetsIn("2026-09-17T13:05:00Z", now)).toBe("3h 5m");
    expect(resetsIn("2026-09-19T12:00:00Z", now)).toBe("2d 2h");
    expect(resetsIn("2026-09-17T09:00:00Z", now)).toBeNull();
    expect(resetsIn(null, now)).toBeNull();
  });

  it("formats tokens and dollars compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(2_100_000)).toBe("2.1M");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(12.3)).toBe("$12.30");
  });

  it("prices by model prefix, longest first", () => {
    expect(priceForModel("claude-opus-4-5-20251101")?.input).toBe(5);
    expect(priceForModel("claude-opus-4-1")?.input).toBe(15);
    expect(priceForModel("claude-fable-5-1")?.cacheRead).toBe(0.25);
    expect(priceForModel("gpt-5")).toBeNull();
    const p = priceForModel("claude-sonnet-5")!;
    expect(
      costForTokens(
        { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        p,
      ),
    ).toBe(2);
  });

  it("lists 5h, 7d, then each per-model weekly cap", () => {
    expect(
      accountBuckets({
        available: true,
        fiveHour: { utilization: 26, resetsAt: null },
        sevenDay: { utilization: 50, resetsAt: null },
        sevenDayModels: [
          { model: "Fable", utilization: 98, resetsAt: null },
          { model: "Nimbus", utilization: null, resetsAt: null },
        ],
      }).map(([label, b]) => `${label}=${b.utilization}`),
    ).toEqual(["5h=26", "7d=50", "7d Fable=98"]);
  });
});
