import { describe, expect, it } from "vitest";
import { addDomains, normalizeDomain } from "./auto-join-domains";

describe("auto-join domains", () => {
  it("normalizes what people type", () => {
    expect(normalizeDomain("Acme.com")).toBe("acme.com");
    expect(normalizeDomain("@acme.com")).toBe("acme.com");
    expect(normalizeDomain("jane@eng.acme.co.uk")).toBe("eng.acme.co.uk");
    expect(normalizeDomain("https://acme.com/team")).toBe("acme.com");
    expect(normalizeDomain("acme")).toBeNull();
    expect(normalizeDomain("not a domain")).toBeNull();
  });

  it("adds a pasted list, deduped, reporting the bad ones", () => {
    expect(addDomains(["acme.com"], "ACME.com, beta.io nope")).toEqual({
      domains: ["acme.com", "beta.io"],
      invalid: ["nope"],
    });
  });
});
