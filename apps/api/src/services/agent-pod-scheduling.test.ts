import { describe, it, expect } from "vitest";
import { parseJsonEnv } from "./agent-pod-scheduling.js";

// ── parseJsonEnv ─────────────────────────────────────────────────────

describe("parseJsonEnv", () => {
  it("returns undefined when value is undefined", () => {
    expect(parseJsonEnv("TEST_VAR", undefined)).toBeUndefined();
  });

  it("returns undefined when value is empty string", () => {
    expect(parseJsonEnv("TEST_VAR", "")).toBeUndefined();
  });

  it("parses valid JSON object", () => {
    const result = parseJsonEnv("TEST_VAR", '{"disktype":"ssd"}');
    expect(result).toEqual({ disktype: "ssd" });
  });

  it("parses valid JSON array", () => {
    const result = parseJsonEnv(
      "TEST_VAR",
      '[{"key":"gpu","operator":"Exists","effect":"NoSchedule"}]',
    );
    expect(result).toEqual([{ key: "gpu", operator: "Exists", effect: "NoSchedule" }]);
  });

  it("throws a descriptive error for malformed JSON", () => {
    expect(() => parseJsonEnv("OPTIO_AGENT_NODE_SELECTOR", "{bad json}")).toThrow(
      /Invalid JSON in OPTIO_AGENT_NODE_SELECTOR/,
    );
  });

  it("includes the original value in the error message", () => {
    expect(() => parseJsonEnv("OPTIO_AGENT_TOLERATIONS", "not-json")).toThrow(/not-json/);
  });
});
