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
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;

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

    it("limits a repo's token to that repo and caches it apart from the installation's", async () => {
      resetTokenCache();
      const expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        return {
          ok: true,
          json: async () =>
            body
              ? {
                  token: `ghs_${body.repositories[0]}`,
                  expires_at,
                  repositories: [{ full_name: `Acme/${body.repositories[0]}` }],
                }
              : { token: "ghs_all", expires_at },
        };
      });
      globalThis.fetch = mockFetch;

      expect(await getInstallationToken({ owner: "acme", name: "widgets" })).toBe("ghs_widgets");
      expect(JSON.parse(String(mockFetch.mock.calls[0][1].body))).toEqual({
        repositories: ["widgets"],
      });
      expect(await getInstallationToken({ owner: "acme", name: "gadgets" })).toBe("ghs_gadgets");
      expect(await getInstallationToken()).toBe("ghs_all");
      expect(await getInstallationToken({ owner: "ACME", name: "Widgets" })).toBe("ghs_widgets");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("refuses a token that is not limited to exactly the asked repo", async () => {
      resetTokenCache();
      const expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      for (const repositories of [
        undefined,
        [{ full_name: "other-owner/widgets" }],
        [{ full_name: "acme/widgets" }, { full_name: "acme/secrets" }],
      ]) {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ token: "ghs_x", expires_at, repositories }),
        });
        await expect(getInstallationToken({ owner: "acme", name: "widgets" })).rejects.toThrow(
          /not limited to acme\/widgets/,
        );
      }
    });
  });
});

describe("github-token-service", () => {
  const mockRetrieveSecret = vi.fn();
  const mockRetrieveSecretVersioned = vi.fn();
  const mockDeleteSecretsIfUnchanged = vi.fn().mockResolvedValue(true);
  const mockWithLease = vi.fn(
    (_key: string, fn: (signal: AbortSignal) => Promise<unknown>, _opts?: unknown) =>
      fn(new AbortController().signal),
  );
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
      retrieveSecretVersioned: (...args: unknown[]) => mockRetrieveSecretVersioned(...args),
      deleteSecretsIfUnchanged: (...args: unknown[]) => mockDeleteSecretsIfUnchanged(...args),
      retrieveSecretWithFallback: (...args: unknown[]) => mockRetrieveSecretWithFallback(...args),
      storeSecret: (...args: unknown[]) => mockStoreSecret(...args),
      deleteSecret: (...args: unknown[]) => mockDeleteSecret(...args),
    }));

    vi.doMock("./github-app-service.js", () => ({
      isGitHubAppConfigured: () => mockIsConfigured(),
      getInstallationToken: () => mockGetInstToken(),
    }));

    // The refresh runs under a cross-instance lease; here it is always free.
    mockWithLease.mockImplementation((_key, fn) => fn(new AbortController().signal));
    vi.doMock("./lease-service.js", () => ({
      withLease: (key: string, fn: (signal: AbortSignal) => Promise<unknown>, opts?: unknown) =>
        mockWithLease(key, fn, opts),
      LeaseLostError: class LeaseLostError extends Error {},
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
    vi.doUnmock("./lease-service.js");
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
    mockRetrieveSecret.mockImplementation(async (name: string) =>
      name === "GITHUB_USER_ACCESS_TOKEN" ? "ghu_expired_token" : pastDate,
    );
    mockRetrieveSecretVersioned.mockResolvedValue({ value: "ghr_refresh_token", version: "v1" });

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
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    expect(mockStoreSecret).toHaveBeenCalledTimes(3);
    // Under the lease, waiting for another instance's refresh.
    expect(mockWithLease).toHaveBeenCalledWith(
      "github-refresh:user-2",
      expect.any(Function),
      expect.objectContaining({ wait: expect.objectContaining({ timeoutMs: expect.any(Number) }) }),
    );
  });

  it("uses the token another instance stored while it waited for the lease", async () => {
    const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    let refreshedElsewhere = false;
    mockRetrieveSecret.mockImplementation(async (name: string) => {
      if (name === "GITHUB_USER_ACCESS_TOKEN") {
        return refreshedElsewhere ? "ghu_from_other_instance" : "ghu_expired";
      }
      return refreshedElsewhere ? futureDate : pastDate;
    });
    mockWithLease.mockImplementation(async (_key, fn) => {
      refreshedElsewhere = true; // the holder refreshed before letting go
      return fn(new AbortController().signal);
    });
    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    expect(await getGitHubToken({ userId: "user-5" })).toBe("ghu_from_other_instance");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("never refreshes without the lease: a timed-out wait uses a still-valid stored token", async () => {
    const soon = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // inside the refresh buffer
    mockRetrieveSecret.mockImplementation(async (name: string) =>
      name === "GITHUB_USER_ACCESS_TOKEN" ? "ghu_still_valid" : soon,
    );
    mockWithLease.mockResolvedValue(null); // held elsewhere the whole wait
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    expect(await getGitHubToken({ userId: "user-6" })).toBe("ghu_still_valid");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to PAT when the wait times out and the stored token has expired", async () => {
    const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
    mockRetrieveSecret.mockImplementation(async (name: string) =>
      name === "GITHUB_USER_ACCESS_TOKEN" ? "ghu_expired" : pastDate,
    );
    mockWithLease.mockResolvedValue(null);
    mockRetrieveSecretWithFallback.mockResolvedValue("ghp_pat");
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    expect(await getGitHubToken({ userId: "user-7" })).toBe("ghp_pat");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to PAT when the refresh rejects", async () => {
    const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
    mockRetrieveSecret.mockImplementation(async (name: string) =>
      name === "GITHUB_USER_ACCESS_TOKEN" ? "ghu_expired" : pastDate,
    );
    mockWithLease.mockRejectedValue(new Error("database unavailable"));
    mockRetrieveSecretWithFallback.mockResolvedValue("ghp_pat_after_reject");

    expect(await getGitHubToken({ userId: "user-8" })).toBe("ghp_pat_after_reject");
  });

  it("on bad_refresh_token deletes the tokens only if the refresh token is unchanged", async () => {
    const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
    mockRetrieveSecret.mockImplementation(async (name: string) =>
      name === "GITHUB_USER_ACCESS_TOKEN" ? "ghu_expired" : pastDate,
    );
    mockRetrieveSecretVersioned.mockResolvedValue({ value: "ghr_used", version: "iv-used" });
    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: "bad_refresh_token" }),
    });
    mockRetrieveSecretWithFallback.mockResolvedValue("ghp_pat");

    expect(await getGitHubToken({ userId: "user-9" })).toBe("ghp_pat");
    expect(mockDeleteSecretsIfUnchanged).toHaveBeenCalledWith(
      ["GITHUB_USER_ACCESS_TOKEN", "GITHUB_USER_REFRESH_TOKEN", "GITHUB_USER_TOKEN_EXPIRES_AT"],
      "user:user-9",
      { name: "GITHUB_USER_REFRESH_TOKEN", version: "iv-used" },
    );
    expect(mockDeleteSecret).not.toHaveBeenCalled();
  });

  it("falls back to PAT when no user tokens exist", async () => {
    mockRetrieveSecret.mockRejectedValue(new Error("Secret not found"));
    mockRetrieveSecretWithFallback.mockResolvedValue("ghp_pat_token");

    const token = await getGitHubToken({ userId: "user-3", workspaceId: "ws-1" });

    expect(token).toBe("ghp_pat_token");
    expect(mockRetrieveSecretWithFallback).toHaveBeenCalledWith(
      "GITHUB_TOKEN",
      "global",
      "ws-1",
      "user-3",
    );
  });

  it("lets personal work use the organization installation when no personal token exists", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockRetrieveSecret.mockRejectedValue(new Error("Secret not found"));
    mockRetrieveSecretWithFallback.mockRejectedValue(new Error("No PAT"));
    mockGetInstToken.mockResolvedValue("installation-token");
    expect(await getGitHubToken({ userId: "user-3", workspaceId: "ws-1" })).toBe(
      "installation-token",
    );
  });

  it("falls back to PAT when refresh fails", async () => {
    const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
    mockRetrieveSecret.mockImplementation(async (name: string) =>
      name === "GITHUB_USER_ACCESS_TOKEN" ? "ghu_expired" : pastDate,
    );
    mockRetrieveSecretVersioned.mockResolvedValue({ value: "ghr_refresh", version: "v1" });

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
    expect(mockDeleteSecretsIfUnchanged).not.toHaveBeenCalled();
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
