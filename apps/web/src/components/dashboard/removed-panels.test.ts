import { describe, it, expect } from "vitest";
import * as dashboardExports from "./index.js";

describe("removed dashboard panels", () => {
  it("should not export FailureInsights", () => {
    expect("FailureInsights" in dashboardExports).toBe(false);
  });

  it("should not export PerformanceSummary", () => {
    expect("PerformanceSummary" in dashboardExports).toBe(false);
  });
});
