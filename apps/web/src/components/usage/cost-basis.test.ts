import { describe, expect, it } from "vitest";
import { costBasisNote } from "./cost-basis";

describe("costBasisNote", () => {
  it("says whether the cost is reported, estimated from the catalog's prices, or both", () => {
    expect(costBasisNote({ costUsd: "3", reportedCostUsd: "3", estimatedCostUsd: null })).toBe(
      "Reported by runtimes",
    );
    expect(costBasisNote({ costUsd: "2", reportedCostUsd: null, estimatedCostUsd: "2" })).toBe(
      "Estimated from the catalog's prices",
    );
    expect(costBasisNote({ costUsd: "5", reportedCostUsd: "3", estimatedCostUsd: "2" })).toBe(
      "$2.00 estimated (catalog prices) · $3.00 reported",
    );
    expect(costBasisNote({ costUsd: null, reportedCostUsd: null, estimatedCostUsd: null })).toBe(
      "No cost recorded",
    );
  });
});
