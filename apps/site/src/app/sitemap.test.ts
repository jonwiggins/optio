import { describe, it, expect } from "vitest";
import sitemap from "./sitemap.js";

describe("sitemap", () => {
  it("should include /docs/guides/standalone-tasks, not /docs/guides/workflows", () => {
    const entries = sitemap();
    const urls = entries.map((e) => e.url);

    expect(urls).toContain("https://optio.host/docs/guides/standalone-tasks");
    expect(urls).not.toContain("https://optio.host/docs/guides/workflows");
  });
});
