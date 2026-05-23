import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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
    it("produces a valid RS256 JWT with three parts", async () => {
      resetTokenCache();
      const jwt = await generateJwt();
      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);
    });

    it("has correct header with RS256 algorithm", async () => {
      resetTokenCache();
      const jwt = await generateJwt();
      const [headerB64] = jwt.split(".");
      const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    });

    it("has correct payload claims", async () => {
      resetTokenCache();
      const now = Math.floor(Date.now() / 1000);
      const jwt = await generateJwt();
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

    it("signature is verifiable with the public key", async () => {
      resetTokenCache();
      const jwt = await generateJwt();
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
      const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          token: "ghs_cached_token",
          expires_at: futureExpiry,
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

describe("github-token-service", () => {
  const mockRetrieveSecret = vi.fn();
  const mockRetrieveSecretWithFallback = vi.fn();
  const mockStoreSecret = vi.fn().mockResolvedValue(undefined);
  const mockDeleteSecret = vi.fn().mockResolvedValue(undefined);
  const mockIsConfigured = vi.fn();
  const mockGetInstToken = vi.fn();
  const mockDbWhere = vi.fn();

  let getGitHubToken: typeof import("./github-token-service.js").getGitHubToken;
  let storeUserGitHubTokens: typeof import("./github-token-service.js").storeUserGitHubTokens;
  let deleteUserGitHubTokens: typeof import("./github-token-service.js").deleteUserGitHubTokens;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    vi.doMock("../db/client.js", () => ({
      db: {
        select: () => ({
          from: () => ({
            where: (...args: unknown[]) => mockDbWhere(...args),
          }),
        }),
      },
    }));

    vi.doMock("../db/schema.js", () => ({
      tasks: {
        id: "id",
        createdBy: "created_by",
        workspaceId: "workspace_id",
      },
    }));

    vi.doMock("./secret-service.js", () => ({
      retrieveSecret: (...args: unknown[]) => mockRetrieveSecret(...args),
      retrieveSecretWithFallback: (...args: unknown[]) => mockRetrieveSecretWithFallback(...args),
      storeSecret: (...args: unknown[]) => mockStoreSecret(...args),
      deleteSecret: (...args: unknown[]) => mockDeleteSecret(...args),
    }));

    vi.doMock("./github-app-service.js", () => ({
      isGitHubAppConfigured: () => mockIsConfigured(),
      getInstallationToken: () => mockGetInstToken(),
    }));

    const mod = await import("./github-token-service.js");
    getGitHubToken = mod.getGitHubToken;
    storeUserGitHubTokens = mod.storeUserGitHubTokens;
    deleteUserGitHubTokens = mod.deleteUserGitHubTokens;
  });

  afterEach(() => {
    vi.doUnmock("../db/client.js");
    vi.doUnmock("../db/schema.js");
    vi.doUnmock("./secret-service.js");
    vi.doUnmock("./github-app-service.js");
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  it("returns valid user token when not expired", async () => {
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockRetrieveSecret.mockResolvedValueOnce("ghu_valid_token").mockResolvedValueOnce(futureDate);

    const token = await getGitHubToken({ userId: "user-1" });

    expect(token).toBe("ghu_valid_token");
    expect(mockRetrieveSecret).toHaveBeenCalledWith("GITHUB_USER_ACCESS_TOKEN", "user:user-1");
    expect(mockRetrieveSecret).toHaveBeenCalledWith("GITHUB_USER_TOKEN_EXPIRES_AT", "user:user-1");
  });

  it("refreshes expired user token", async () => {
    const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
    mockRetrieveSecret
      .mockResolvedValueOnce("ghu_expired_token")
      .mockResolvedValueOnce(pastDate)
      .mockResolvedValueOnce("ghr_refresh_token");

    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "ghu_new_token",
        refresh_token: "ghr_new_refresh",
        expires_in: 28800,
      }),
    });
    globalThis.fetch = mockFetch;

    const token = await getGitHubToken({ userId: "user-2" });

    expect(token).toBe("ghu_new_token");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockStoreSecret).toHaveBeenCalledTimes(3);
  });

  it("falls back to PAT when no user tokens exist", async () => {
    mockRetrieveSecret.mockRejectedValue(new Error("Secret not found"));
    mockRetrieveSecretWithFallback.mockResolvedValue("ghp_pat_token");

    const token = await getGitHubToken({ userId: "user-3", workspaceId: "ws-1" });

    expect(token).toBe("ghp_pat_token");
    expect(mockRetrieveSecretWithFallback).toHaveBeenCalledWith("GITHUB_TOKEN", "global", "ws-1");
  });

  it("falls back to PAT when refresh fails", async () => {
    const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
    mockRetrieveSecret
      .mockResolvedValueOnce("ghu_expired")
      .mockResolvedValueOnce(pastDate)
      .mockResolvedValueOnce("ghr_refresh");

    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });
    globalThis.fetch = mockFetch;

    mockRetrieveSecretWithFallback.mockResolvedValue("ghp_fallback_pat");

    const token = await getGitHubToken({ userId: "user-4" });

    expect(token).toBe("ghp_fallback_pat");
    // Transient failures (HTTP 401) should NOT delete tokens — only definitive
    // revocation errors (bad_refresh_token) trigger deletion
    expect(mockDeleteSecret).not.toHaveBeenCalled();
  });

  it("resolves task creator's token", async () => {
    mockDbWhere.mockResolvedValueOnce([{ createdBy: "user-5", workspaceId: "ws-2" }]);
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockRetrieveSecret
      .mockResolvedValueOnce("ghu_task_user_token")
      .mockResolvedValueOnce(futureDate);

    const token = await getGitHubToken({ taskId: "task-1" });

    expect(token).toBe("ghu_task_user_token");
    expect(mockRetrieveSecret).toHaveBeenCalledWith("GITHUB_USER_ACCESS_TOKEN", "user:user-5");
  });

  it("returns installation token when GitHub App is configured (server context)", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetInstToken.mockResolvedValue("ghs_install_token");

    const token = await getGitHubToken({ server: true });

    expect(token).toBe("ghs_install_token");
    expect(mockIsConfigured).toHaveBeenCalled();
    expect(mockGetInstToken).toHaveBeenCalled();
  });

  it("falls back to PAT when GitHub App not configured (server context)", async () => {
    mockIsConfigured.mockReturnValue(false);
    mockRetrieveSecretWithFallback.mockResolvedValue("ghp_server_pat");

    const token = await getGitHubToken({ server: true });

    expect(token).toBe("ghp_server_pat");
    expect(mockRetrieveSecretWithFallback).toHaveBeenCalledWith(
      "GITHUB_TOKEN",
      "global",
      undefined,
    );
  });

  it("storeUserGitHubTokens stores 3 secrets", async () => {
    await storeUserGitHubTokens("user-6", {
      accessToken: "ghu_access",
      refreshToken: "ghr_refresh",
      expiresIn: 28800,
    });

    expect(mockStoreSecret).toHaveBeenCalledTimes(3);
    expect(mockStoreSecret).toHaveBeenCalledWith(
      "GITHUB_USER_ACCESS_TOKEN",
      "ghu_access",
      "user:user-6",
    );
    expect(mockStoreSecret).toHaveBeenCalledWith(
      "GITHUB_USER_REFRESH_TOKEN",
      "ghr_refresh",
      "user:user-6",
    );
    expect(mockStoreSecret).toHaveBeenCalledWith(
      "GITHUB_USER_TOKEN_EXPIRES_AT",
      expect.any(String),
      "user:user-6",
    );
  });

  it("deleteUserGitHubTokens deletes 3 secrets", async () => {
    await deleteUserGitHubTokens("user-7");

    expect(mockDeleteSecret).toHaveBeenCalledTimes(3);
    expect(mockDeleteSecret).toHaveBeenCalledWith("GITHUB_USER_ACCESS_TOKEN", "user:user-7");
    expect(mockDeleteSecret).toHaveBeenCalledWith("GITHUB_USER_REFRESH_TOKEN", "user:user-7");
    expect(mockDeleteSecret).toHaveBeenCalledWith("GITHUB_USER_TOKEN_EXPIRES_AT", "user:user-7");
  });
});
