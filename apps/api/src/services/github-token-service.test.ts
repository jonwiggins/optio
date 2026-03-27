import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";

// Generate a test RSA key pair
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// Store original env and fetch
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

describe("github-app-service", () => {
  let isGitHubAppConfigured: typeof import("./github-app-service.js").isGitHubAppConfigured;
  let generateJwt: typeof import("./github-app-service.js").generateJwt;
  let getInstallationToken: typeof import("./github-app-service.js").getInstallationToken;
  let resetTokenCache: typeof import("./github-app-service.js").resetTokenCache;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Set env vars for tests that need them
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey as string;

    const mod = await import("./github-app-service.js");
    isGitHubAppConfigured = mod.isGitHubAppConfigured;
    generateJwt = mod.generateJwt;
    getInstallationToken = mod.getInstallationToken;
    resetTokenCache = mod.resetTokenCache;
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  describe("isGitHubAppConfigured", () => {
    it("returns true when all three env vars are set", () => {
      expect(isGitHubAppConfigured()).toBe(true);
    });

    it("returns false when GITHUB_APP_ID is missing", () => {
      delete process.env.GITHUB_APP_ID;
      expect(isGitHubAppConfigured()).toBe(false);
    });

    it("returns false when GITHUB_APP_INSTALLATION_ID is missing", () => {
      delete process.env.GITHUB_APP_INSTALLATION_ID;
      expect(isGitHubAppConfigured()).toBe(false);
    });

    it("returns false when GITHUB_APP_PRIVATE_KEY is missing", () => {
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      expect(isGitHubAppConfigured()).toBe(false);
    });
  });

  describe("generateJwt", () => {
    it("produces a valid RS256 JWT with three parts", () => {
      const jwt = generateJwt();
      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);
    });

    it("has correct header with RS256 algorithm", () => {
      const jwt = generateJwt();
      const [headerB64] = jwt.split(".");
      const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    });

    it("has correct payload claims", () => {
      const now = Math.floor(Date.now() / 1000);
      const jwt = generateJwt();
      const [, payloadB64] = jwt.split(".");
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());

      expect(payload.iss).toBe("12345");
      // iat should be now - 60 (clock skew tolerance)
      expect(payload.iat).toBeGreaterThanOrEqual(now - 62);
      expect(payload.iat).toBeLessThanOrEqual(now - 58);
      // exp should be now + 600 (10 minutes)
      expect(payload.exp).toBeGreaterThanOrEqual(now + 598);
      expect(payload.exp).toBeLessThanOrEqual(now + 602);
    });

    it("signature is verifiable with the public key", () => {
      const jwt = generateJwt();
      const [headerB64, payloadB64, signatureB64] = jwt.split(".");
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${headerB64}.${payloadB64}`);
      const isValid = verifier.verify(publicKey, signatureB64, "base64url");
      expect(isValid).toBe(true);
    });
  });

  describe("getInstallationToken", () => {
    it("returns a fresh token on first call", async () => {
      resetTokenCache();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          token: "ghs_test_token_abc123",
          expires_at: "2024-01-01T01:00:00Z",
        }),
      });
      globalThis.fetch = mockFetch;

      const token = await getInstallationToken();

      expect(token).toBe("ghs_test_token_abc123");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.github.com/app/installations/67890/access_tokens",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Optio",
          }),
        }),
      );
    });

    it("returns cached token on second call", async () => {
      resetTokenCache();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          token: "ghs_cached_token",
          expires_at: "2024-01-01T01:00:00Z",
        }),
      });
      globalThis.fetch = mockFetch;

      const token1 = await getInstallationToken();
      const token2 = await getInstallationToken();

      expect(token1).toBe("ghs_cached_token");
      expect(token2).toBe("ghs_cached_token");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("refreshes token after cache reset", async () => {
      resetTokenCache();
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          ok: true,
          json: async () => ({
            token: `ghs_token_${callCount}`,
            expires_at: "2024-01-01T01:00:00Z",
          }),
        };
      });
      globalThis.fetch = mockFetch;

      const token1 = await getInstallationToken();
      expect(token1).toBe("ghs_token_1");

      resetTokenCache();

      const token2 = await getInstallationToken();
      expect(token2).toBe("ghs_token_2");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("throws on API error", async () => {
      resetTokenCache();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });
      globalThis.fetch = mockFetch;

      await expect(getInstallationToken()).rejects.toThrow(
        "Failed to get installation token: 401 Unauthorized",
      );
    });
  });
});
