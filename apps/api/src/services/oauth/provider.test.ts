import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getCallbackUrl } from "./provider.js";

describe("getCallbackUrl", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant environment variables before each test
    delete process.env.PUBLIC_URL;
    delete process.env.API_PORT;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  it("uses PUBLIC_URL when it is set", () => {
    process.env.PUBLIC_URL = "https://optio.example.com";

    const url = getCallbackUrl("github");

    expect(url).toBe("https://optio.example.com/api/auth/github/callback");
  });

  it("falls back to localhost with API_PORT when PUBLIC_URL is not set", () => {
    process.env.API_PORT = "8080";

    const url = getCallbackUrl("google");

    expect(url).toBe("http://localhost:8080/api/auth/google/callback");
  });

  it("falls back to localhost:4000 when neither PUBLIC_URL nor API_PORT are set", () => {
    const url = getCallbackUrl("oidc");

    expect(url).toBe("http://localhost:4000/api/auth/oidc/callback");
  });
});
