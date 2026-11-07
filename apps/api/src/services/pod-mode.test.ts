import { describe, expect, it } from "vitest";
import { effectivePodMode } from "./pod-mode.js";

describe("effectivePodMode", () => {
  it("is shared when nothing is set (as before)", () => {
    expect(effectivePodMode(null, null)).toBe("shared");
    expect(effectivePodMode(undefined, "shared")).toBe("shared");
  });

  it("follows the workspace default when the repo picks nothing", () => {
    expect(effectivePodMode(null, "per_run")).toBe("per_run");
    expect(effectivePodMode(null, "shared")).toBe("shared");
  });

  it("lets the repo's own choice win over the workspace default", () => {
    expect(effectivePodMode("shared", "per_run")).toBe("shared");
    expect(effectivePodMode("per_run", "shared")).toBe("per_run");
  });

  it("always gives a fresh pod when the workspace requires it", () => {
    expect(effectivePodMode("shared", "per_run_required")).toBe("per_run");
    expect(effectivePodMode(null, "per_run_required")).toBe("per_run");
    expect(effectivePodMode("per_run", "per_run_required")).toBe("per_run");
  });
});
