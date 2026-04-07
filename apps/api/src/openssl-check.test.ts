import { describe, it, expect } from "vitest";
import { assertMinOpenSSL } from "./openssl-check.js";

describe("assertMinOpenSSL", () => {
  it("throws for OpenSSL 1.x", () => {
    expect(() => assertMinOpenSSL("1.1.1")).toThrow(
      "OpenSSL 1.1.1 is too old for post-quantum TLS",
    );
  });

  it("throws for OpenSSL 3.0.x", () => {
    expect(() => assertMinOpenSSL("3.0.15")).toThrow(
      "OpenSSL 3.0.15 is too old for post-quantum TLS",
    );
  });

  it("throws for OpenSSL 3.4.x", () => {
    expect(() => assertMinOpenSSL("3.4.1")).toThrow(
      "OpenSSL 3.4.1 is too old for post-quantum TLS",
    );
  });

  it("passes for OpenSSL 3.5.0", () => {
    expect(() => assertMinOpenSSL("3.5.0")).not.toThrow();
  });

  it("passes for OpenSSL 3.5.4", () => {
    expect(() => assertMinOpenSSL("3.5.4")).not.toThrow();
  });

  it("passes for OpenSSL 3.6.0", () => {
    expect(() => assertMinOpenSSL("3.6.0")).not.toThrow();
  });

  it("passes for OpenSSL 4.0.0", () => {
    expect(() => assertMinOpenSSL("4.0.0")).not.toThrow();
  });

  it("includes upgrade instructions in error message", () => {
    expect(() => assertMinOpenSSL("3.0.0")).toThrow("Upgrade to Node 22+ with OpenSSL 3.5+");
  });
});
