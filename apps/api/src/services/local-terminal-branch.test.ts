import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { withBranchInstructions } from "./local-terminal-service.js";

describe("withBranchInstructions", () => {
  it("appends branch + PR instructions after the prompt", () => {
    const out = withBranchInstructions("Fix the login bug", {
      baseBranch: "develop",
      branch: "optio/session-abc12345",
      dir: "/Users/dev/app",
    });
    expect(out.startsWith("Fix the login bug\n\n---\n")).toBe(true);
    expect(out).toContain("create `optio/session-abc12345` from an up-to-date `develop`");
    expect(out).toContain("open a pull request against `develop`");
    expect(out).toContain("/Users/dev/app");
  });

  it("a blank prompt becomes just the instructions, with main as the fallback base", () => {
    const out = withBranchInstructions("   ", { baseBranch: "", branch: "b", dir: "/x" });
    expect(out.startsWith("You are working in the local checkout at /x.")).toBe(true);
    expect(out).toContain("never directly on `main`");
  });
});
