import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as jose from "jose";

// ─── Helpers ───

const ISSUER_URL = "https://auth.example.com/realms/optio";

const DISCOVERY_DOC = {
  issuer: ISSUER_URL,
  authorization_endpoint: `${ISSUER_URL}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER_URL}/protocol/openid-connect/token`,
  userinfo_endpoint: `${ISSUER_URL}/protocol/openid-connect/userinfo`,
  jwks_uri: `${ISSUER_URL}/protocol/openid-connect/certs`,
};

const USERINFO_RESPONSE = {
  sub: "user-abc-123",
  email: "alice@example.com",
  name: "Alice Smith",
  preferred_username: "alice",
  picture: "https://auth.example.com/avatar/alice.png",
};

/** Generate a real RSA key pair and sign a JWT for testing. */
async function generateTestKeyAndToken(
  claims: Record<string, unknown>,
  issuer: string,
  audience: string,
) {
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = "test-key-1";
  jwk.alg = "RS256";
  jwk.use = "sig";

  const token = await new jose.SignJWT(claims as jose.JWTPayload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime("1h")
    .setIssuedAt()
    .sign(privateKey);

  return { jwk, token, privateKey };
}

// ─── Tests ───

describe("GenericOIDCProvider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OIDC_ISSUER_URL = ISSUER_URL;
    process.env.OIDC_CLIENT_ID = "test-client-id";
    process.env.OIDC_CLIENT_SECRET = "test-client-secret";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // Import fresh each test to reset cached state
  async function createProvider() {
    // Dynamic import to get a fresh module each time is tricky with vitest,
    // so we just create a new instance manually
    const { GenericOIDCProvider } = await import("./oidc.js");
    return new GenericOIDCProvider();
  }

  describe("discover()", () => {
    it("fetches and returns the discovery document", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }));

      const provider = await createProvider();
      const doc = await provider.discover();

      expect(fetchSpy).toHaveBeenCalledWith(`${ISSUER_URL}/.well-known/openid-configuration`);
      expect(doc.authorization_endpoint).toBe(DISCOVERY_DOC.authorization_endpoint);
      expect(doc.token_endpoint).toBe(DISCOVERY_DOC.token_endpoint);
      expect(doc.userinfo_endpoint).toBe(DISCOVERY_DOC.userinfo_endpoint);
      expect(doc.jwks_uri).toBe(DISCOVERY_DOC.jwks_uri);
    });

    it("caches the discovery document for 24h", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }));

      const provider = await createProvider();
      await provider.discover();
      await provider.discover();
      await provider.discover();

      // Only one fetch should have been made
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("re-fetches after cache expires", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }));

      const provider = await createProvider();
      await provider.discover();

      // Advance time past 24h TTL
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);

      await provider.discover();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("throws on failed discovery fetch", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Not found", { status: 404, statusText: "Not Found" }),
      );

      const provider = await createProvider();
      await expect(provider.discover()).rejects.toThrow("OIDC discovery failed: 404 Not Found");
    });

    it("throws when discovery doc is missing required endpoints", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ issuer: ISSUER_URL }), { status: 200 }),
      );

      const provider = await createProvider();
      await expect(provider.discover()).rejects.toThrow(
        "OIDC discovery document missing required endpoints",
      );
    });
  });

  describe("authorizeUrl()", () => {
    it("returns a properly formed authorize URL after prepare()", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }),
      );

      const provider = await createProvider();
      await provider.prepare();

      const url = provider.authorizeUrl("test-state-123");
      const parsed = new URL(url);

      expect(parsed.origin + parsed.pathname).toBe(DISCOVERY_DOC.authorization_endpoint);
      expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("scope")).toBe("openid email profile");
      expect(parsed.searchParams.get("state")).toBe("test-state-123");
      expect(parsed.searchParams.get("redirect_uri")).toContain("/api/auth/oidc/callback");
    });

    it("throws if prepare() was not called", async () => {
      const provider = await createProvider();
      expect(() => provider.authorizeUrl("state")).toThrow("call prepare() first");
    });

    it("uses custom scopes from OIDC_SCOPES env", async () => {
      process.env.OIDC_SCOPES = "openid email";
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }),
      );

      const provider = await createProvider();
      await provider.prepare();

      const url = provider.authorizeUrl("state");
      const parsed = new URL(url);
      expect(parsed.searchParams.get("scope")).toBe("openid email");
    });
  });

  describe("exchangeCode()", () => {
    it("exchanges an auth code for tokens and verifies ID token", async () => {
      const { jwk, token } = await generateTestKeyAndToken(
        { email: "alice@example.com" },
        ISSUER_URL,
        "test-client-id",
      );

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        // 1st call: discovery
        .mockResolvedValueOnce(new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }))
        // 2nd call: token exchange
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: "at-123",
              refresh_token: "rt-456",
              expires_in: 3600,
              id_token: token,
            }),
            { status: 200 },
          ),
        )
        // 3rd call: JWKS fetch (by jose)
        .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));

      const provider = await createProvider();
      const tokens = await provider.exchangeCode("auth-code-xyz");

      expect(tokens.accessToken).toBe("at-123");
      expect(tokens.refreshToken).toBe("rt-456");
      expect(tokens.expiresIn).toBe(3600);

      // Verify that token endpoint was called with correct params
      const tokenCall = fetchSpy.mock.calls[1];
      expect(tokenCall[0]).toBe(DISCOVERY_DOC.token_endpoint);
      expect(tokenCall[1]?.method).toBe("POST");
    });

    it("rejects a tampered ID token signature", async () => {
      // Sign the token with one key but publish a different key in JWKS
      const { token } = await generateTestKeyAndToken(
        { email: "alice@example.com" },
        ISSUER_URL,
        "test-client-id",
      );

      // Generate a completely different key pair for the JWKS
      const { publicKey: wrongKey } = await jose.generateKeyPair("RS256");
      const wrongJwk = await jose.exportJWK(wrongKey);
      wrongJwk.kid = "test-key-1";
      wrongJwk.alg = "RS256";
      wrongJwk.use = "sig";

      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: "at-123",
              id_token: token,
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [wrongJwk] }), { status: 200 }));

      const provider = await createProvider();
      await expect(provider.exchangeCode("auth-code")).rejects.toThrow(
        "OIDC ID token verification failed",
      );
    });

    it("succeeds when no ID token is returned", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "at-no-id", refresh_token: "rt-no-id" }), {
            status: 200,
          }),
        );

      const provider = await createProvider();
      const tokens = await provider.exchangeCode("auth-code");
      expect(tokens.accessToken).toBe("at-no-id");
    });

    it("throws on token exchange HTTP error", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }))
        .mockResolvedValueOnce(
          new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
        );

      const provider = await createProvider();
      await expect(provider.exchangeCode("bad-code")).rejects.toThrow(
        "OIDC token exchange failed: 401 Unauthorized",
      );
    });

    it("throws on OAuth error response", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: "invalid_grant", error_description: "Code expired" }),
            { status: 200 },
          ),
        );

      const provider = await createProvider();
      await expect(provider.exchangeCode("expired-code")).rejects.toThrow(
        "OIDC OAuth error: Code expired",
      );
    });
  });

  describe("fetchUser()", () => {
    it("maps OIDC claims to OAuthUser", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(USERINFO_RESPONSE), { status: 200 }));

      const provider = await createProvider();
      const user = await provider.fetchUser("access-token-xyz");

      expect(user.externalId).toBe("user-abc-123");
      expect(user.email).toBe("alice@example.com");
      expect(user.displayName).toBe("Alice Smith");
      expect(user.avatarUrl).toBe("https://auth.example.com/avatar/alice.png");
    });

    it("falls back to preferred_username when name is missing", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ sub: "u-1", email: "bob@test.com", preferred_username: "bob" }),
            { status: 200 },
          ),
        );

      const provider = await createProvider();
      const user = await provider.fetchUser("token");

      expect(user.displayName).toBe("bob");
      expect(user.avatarUrl).toBeUndefined();
    });

    it("throws on userinfo HTTP error", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify(DISCOVERY_DOC), { status: 200 }))
        .mockResolvedValueOnce(new Response("Forbidden", { status: 403, statusText: "Forbidden" }));

      const provider = await createProvider();
      await expect(provider.fetchUser("bad-token")).rejects.toThrow(
        "OIDC userinfo fetch failed: 403 Forbidden",
      );
    });
  });
});

describe("OIDC provider registration", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("includes oidc provider when OIDC_ISSUER_URL is set", async () => {
    process.env.OIDC_ISSUER_URL = "https://auth.example.com";
    process.env.OIDC_CLIENT_ID = "client";
    process.env.OIDC_CLIENT_SECRET = "secret";

    // Re-import to pick up env changes — we need to reset the module
    vi.resetModules();
    const { getEnabledProviders } = await import("./index.js");
    const providers = getEnabledProviders();
    const oidc = providers.find((p) => p.name === "oidc");
    expect(oidc).toBeDefined();
    expect(oidc!.displayName).toBe("SSO");
  });

  it("uses custom display name from OIDC_DISPLAY_NAME", async () => {
    process.env.OIDC_ISSUER_URL = "https://auth.example.com";
    process.env.OIDC_CLIENT_ID = "client";
    process.env.OIDC_CLIENT_SECRET = "secret";
    process.env.OIDC_DISPLAY_NAME = "Company SSO";

    vi.resetModules();
    const { getEnabledProviders } = await import("./index.js");
    const providers = getEnabledProviders();
    const oidc = providers.find((p) => p.name === "oidc");
    expect(oidc).toBeDefined();
    expect(oidc!.displayName).toBe("Company SSO");
  });

  it("does not include oidc when OIDC_ISSUER_URL is not set", async () => {
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;

    vi.resetModules();
    const { getEnabledProviders } = await import("./index.js");
    const providers = getEnabledProviders();
    expect(providers.find((p) => p.name === "oidc")).toBeUndefined();
  });
});
