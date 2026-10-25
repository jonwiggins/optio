import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProviderMark, brandFor } from "./brand-icon";

describe("ProviderMark", () => {
  it("draws a known provider's brand mark", () => {
    const { container } = render(<ProviderMark provider="gitlab" title="GitLab" />);
    expect(container.querySelector("svg title")?.textContent).toBe("GitLab");
    expect(brandFor("gitlab")).toBe("gitlab");
  });

  it("falls back to a generic mark for a provider with no brand", () => {
    expect(brandFor("forgejo")).toBeNull();
    const { container } = render(<ProviderMark provider="forgejo" className="w-4 h-4" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class")).toContain("lucide-link2");
  });
});
