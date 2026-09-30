import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getCallbackUrl } from "./provider.js";

describe("getCallbackUrl", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant environment variables before each test
    delete process.env.PUBLIC_URL;
    delete process.env.PUBLIC_API_URL;
    delete process.env.API_PORT;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe.each(["github", "google", "oidc"])("with provider %s", (provider) => {
    it("uses PUBLIC_URL when it is set and PUBLIC_API_URL is not", () => {
      process.env.PUBLIC_URL = "https://optio.example.com";
      expect(getCallbackUrl(provider)).toBe(
        `https://optio.example.com/api/auth/${provider}/callback`,
      );
    });

    it("uses PUBLIC_API_URL when it is set", () => {
      process.env.PUBLIC_API_URL = "https://optio-api.example.com/api";
      expect(getCallbackUrl(provider)).toBe(
        `https://optio-api.example.com/api/auth/${provider}/callback`,
      );
    });

    it("uses PUBLIC_API_URL and trims trailing slash", () => {
      process.env.PUBLIC_API_URL = "https://optio-api.example.com/api/";
      expect(getCallbackUrl(provider)).toBe(
        `https://optio-api.example.com/api/auth/${provider}/callback`,
      );
    });

    it("falls back to localhost with API_PORT when PUBLIC_URL is not set", () => {
      process.env.API_PORT = "8080";
      expect(getCallbackUrl(provider)).toBe(`http://localhost:8080/api/auth/${provider}/callback`);
    });

    it("falls back to localhost:4000 when neither PUBLIC_URL nor API_PORT are set", () => {
      expect(getCallbackUrl(provider)).toBe(`http://localhost:4000/api/auth/${provider}/callback`);
    });
  });
});
