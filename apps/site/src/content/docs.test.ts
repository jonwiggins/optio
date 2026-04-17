import { describe, it, expect } from "vitest";
import { docsNav } from "./docs.js";

describe("docsNav", () => {
  it("should reference /docs/guides/standalone-tasks, not /docs/guides/workflows", () => {
    const guidesSection = docsNav.find((s) => s.title === "Guides");
    expect(guidesSection).toBeDefined();

    const standaloneEntry = guidesSection!.pages.find((p) => p.title === "Standalone Tasks");
    expect(standaloneEntry).toBeDefined();
    expect(standaloneEntry!.href).toBe("/docs/guides/standalone-tasks");

    const workflowsEntry = guidesSection!.pages.find((p) => p.href === "/docs/guides/workflows");
    expect(workflowsEntry).toBeUndefined();
  });
});
