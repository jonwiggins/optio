import { setOutboundDefaults } from "../../utils/outbound-url.js";
let restoreOutbound: (() => void) | undefined;
/**
 * OpenID Connect set up in the app (Settings → Sign-in): presets, a private
 * CA, PKCE and a nonce, claims mapping and groups. The environment-configured
 * provider's behaviour is covered by oidc.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const fetchMock = vi.fn();
vi.mock("undici", () => ({
  Agent: class {
    constructor(public opts: unknown) {}
    close() {
      return Promise.resolve();
    }
    destroy() {
      return Promise.resolve();
    }
  },
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

// The stored settings: a unit test without a database never reads them.
const resolveProviderConfig = vi.fn(async () => {
  throw new Error("no database in a unit test");
});
vi.mock("../sign-in-config-service.js", () => ({ resolveProviderConfig }));

import {
  GenericOIDCProvider,
  claimAsList,
  describeFetchError,
  effectiveOidcSettings,
  oidcPresetDefaults,
  type OidcClientConfig,
} from "./oidc.js";

const ISSUER = "https://sso.example.com/realms/optio";
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  userinfo_endpoint: `${ISSUER}/protocol/openid-connect/userinfo`,
  jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
  scopes_supported: ["openid", "profile", "email", "groups"],
  code_challenge_methods_supported: ["S256"],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };

async function idToken(claims: Record<string, unknown>, opts: { nonce?: string } = {}) {
  return new SignJWT({ ...claims, ...(opts.nonce ? { nonce: opts.nonce } : {}) })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience("optio-client")
    .setSubject(String(claims.sub ?? "u1"))
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

const config = (settings: Partial<OidcClientConfig["settings"]> = {}): OidcClientConfig => ({
  clientId: "optio-client",
  clientSecret: "shh",
  settings: { issuerUrl: ISSUER, ...settings },
});

/** Routes the mocked fetch by URL: discovery, JWKS, token, userinfo. */
function serve(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const key = Object.keys(handlers).find((k) => String(url).startsWith(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    return handlers[key]!(init);
  });
}

beforeEach(async () => {
  keys = await generateKeyPair("RS256");
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
  vi.stubEnv("PUBLIC_URL", "https://optio.example.com");
  fetchMock.mockReset();
  restoreOutbound = setOutboundDefaults({
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  // Without a private CA the provider uses the global fetch (jose's JWKS too).
  vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));
});

afterEach(() => {
  restoreOutbound?.();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("effectiveOidcSettings and presets", () => {
  it("fills the defaults and trims the issuer", () => {
    const s = effectiveOidcSettings({ issuerUrl: `${ISSUER}/ ` });
    expect(s).toMatchObject({
      issuerUrl: ISSUER,
      scopes: "openid profile email",
      groupsClaim: "groups",
      emailClaim: "email",
      // An email counts as verified only when the provider says so, unless an admin trusts it.
      trustEmail: false,
      usePkce: true,
      tokenAuthMethod: "client_secret_post",
    });
    expect(effectiveOidcSettings({ issuerUrl: ISSUER, trustEmail: true }).trustEmail).toBe(true);
  });

  it("has an Auth0 preset among the others", () => {
    expect(oidcPresetDefaults("auth0")).toEqual({
      scopes: "openid profile email",
      groupsClaim: "groups",
    });
  });

  it("a preset sets its scopes and groups claim; explicit settings win", () => {
    expect(oidcPresetDefaults("okta").scopes).toContain("groups");
    expect(effectiveOidcSettings({ issuerUrl: ISSUER, preset: "zitadel" }).groupsClaim).toBe(
      "urn:zitadel:iam:org:project:roles",
    );
    expect(
      effectiveOidcSettings({ issuerUrl: ISSUER, preset: "okta", groupsClaim: "roles" })
        .groupsClaim,
    ).toBe("roles");
  });

  it("claimAsList reads arrays, strings and dotted paths", () => {
    expect(claimAsList({ groups: ["a", "b"] }, "groups")).toEqual(["a", "b"]);
    expect(claimAsList({ groups: "a, b" }, "groups")).toEqual(["a", "b"]);
    expect(claimAsList({ groups: "Domain Users" }, "groups")).toEqual(["Domain Users"]);
    expect(claimAsList({ realm_access: { roles: ["admin"] } }, "realm_access.roles")).toEqual([
      "admin",
    ]);
    expect(claimAsList({}, "groups")).toEqual([]);
  });

  it("describeFetchError names the CA fix for certificate errors", () => {
    const err = new TypeError("fetch failed", {
      cause: {
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        message: "unable to verify the first certificate",
      },
    });
    expect(describeFetchError(err)).toMatch(/certificate authority/);
    expect(describeFetchError(new Error("boom"))).toBe(
      "Could not connect to the identity provider",
    );
  });
});

describe("GenericOIDCProvider", () => {
  it("discovers once per issuer through the configured CA and builds a PKCE + nonce authorize URL", async () => {
    const provider = new GenericOIDCProvider(async () =>
      config({
        caPem: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----",
        scopes: "openid email",
      }),
    );
    serve({ [`${ISSUER}/.well-known`]: () => jsonResponse(DISCOVERY) });
    await provider.prepare();
    await provider.prepare();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(
      (init as { dispatcher: { opts: { connect: { ca: string } } } }).dispatcher.opts.connect.ca,
    ).toMatch(/BEGIN CERTIFICATE/);

    const flow = provider.beginFlow();
    expect(flow.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const url = new URL(provider.authorizeUrl("st4te", flow));
    expect(url.origin + url.pathname).toBe(DISCOVERY.authorization_endpoint);
    expect(url.searchParams.get("client_id")).toBe("optio-client");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://optio.example.com/api/auth/oidc/callback",
    );
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("nonce")).toBe(flow.nonce);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(flow.codeVerifier!).digest("base64url"),
    );
  });

  it("refuses a discovery document whose issuer differs or lacks endpoints", async () => {
    const provider = new GenericOIDCProvider(async () => config());
    serve({
      [`${ISSUER}/.well-known`]: () => jsonResponse({ ...DISCOVERY, issuer: "https://other" }),
    });
    await expect(provider.prepare()).rejects.toThrow(/issuer is https:\/\/other/);
    provider.reset();
    serve({ [`${ISSUER}/.well-known`]: () => jsonResponse({ issuer: ISSUER }) });
    await expect(provider.prepare()).rejects.toThrow(/missing required endpoints/);
    provider.reset();
    serve({ [`${ISSUER}/.well-known`]: () => jsonResponse({}, 404) });
    await expect(provider.prepare()).rejects.toThrow(/discovery failed: 404/);
  });

  it("exchanges the code with the verifier, verifies the ID token and nonce, and merges claims", async () => {
    const provider = new GenericOIDCProvider(async () =>
      config({ groupsClaim: "groups", trustEmail: true }),
    );
    const flow = provider.beginFlow();
    const token = await idToken(
      { sub: "u1", email: "ada@example.com", name: "Ada", groups: ["developers"] },
      { nonce: flow.nonce },
    );
    let tokenBody: URLSearchParams | undefined;
    serve({
      [`${ISSUER}/.well-known`]: () => jsonResponse(DISCOVERY),
      [DISCOVERY.jwks_uri]: () => jsonResponse(jwks),
      [DISCOVERY.token_endpoint]: (init) => {
        tokenBody = init?.body as URLSearchParams;
        return jsonResponse({ access_token: "at", id_token: token, expires_in: 300 });
      },
      [DISCOVERY.userinfo_endpoint]: (init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer at");
        return jsonResponse({
          sub: "u1",
          preferred_username: "ada",
          groups: ["developers", "platform-admins"],
          picture: "https://p/ada.png",
        });
      },
    });
    await provider.prepare();
    const tokens = await provider.exchangeCode("c0de", flow);
    expect(tokens).toMatchObject({ accessToken: "at", idToken: token, expiresIn: 300 });
    expect(tokenBody?.get("grant_type")).toBe("authorization_code");
    expect(tokenBody?.get("code_verifier")).toBe(flow.codeVerifier);
    expect(tokenBody?.get("client_secret")).toBe("shh");

    const user = await provider.fetchUser(tokens.accessToken, tokens);
    expect(user).toEqual({
      externalId: "u1",
      email: "ada@example.com",
      displayName: "Ada",
      username: "ada",
      avatarUrl: "https://p/ada.png",
      // Trusted by the admin's setting, not asserted by the provider.
      emailVerified: true,
      emailVerifiedByProvider: false,
      groups: ["developers", "platform-admins"],
    });
  });

  it("counts an email verified by default only when the provider asserts it", async () => {
    for (const [claim, verified] of [
      [undefined, false],
      [true, true],
    ] as const) {
      const provider = new GenericOIDCProvider(async () => config());
      const flow = provider.beginFlow();
      const token = await idToken(
        {
          sub: "u3",
          email: "cy@example.com",
          ...(claim === undefined ? {} : { email_verified: claim }),
        },
        { nonce: flow.nonce },
      );
      serve({
        [`${ISSUER}/.well-known`]: () => jsonResponse(DISCOVERY),
        [DISCOVERY.jwks_uri]: () => jsonResponse(jwks),
        [DISCOVERY.token_endpoint]: () => jsonResponse({ access_token: "at", id_token: token }),
        [DISCOVERY.userinfo_endpoint]: () => jsonResponse({ sub: "u3" }),
      });
      await provider.prepare();
      const tokens = await provider.exchangeCode("c", flow);
      const user = await provider.fetchUser(tokens.accessToken, tokens);
      expect(user.emailVerified).toBe(verified);
      expect(user.emailVerifiedByProvider).toBe(verified);
    }
  });

  it("sends the secret as basic auth when configured, and trusts email only as told", async () => {
    const provider = new GenericOIDCProvider(async () =>
      config({ tokenAuthMethod: "client_secret_basic", trustEmail: false, usePkce: false }),
    );
    const token = await idToken({ sub: "u2", email: "bo@example.com", email_verified: false });
    let headers: Record<string, string> | undefined;
    serve({
      [`${ISSUER}/.well-known`]: () => jsonResponse(DISCOVERY),
      [DISCOVERY.jwks_uri]: () => jsonResponse(jwks),
      [DISCOVERY.token_endpoint]: (init) => {
        headers = init?.headers as Record<string, string>;
        return jsonResponse({ access_token: "at", id_token: token });
      },
      [DISCOVERY.userinfo_endpoint]: () => jsonResponse({ sub: "u2" }),
    });
    await provider.prepare();
    const url = new URL(provider.authorizeUrl("s"));
    expect(url.searchParams.has("code_challenge")).toBe(false);
    const tokens = await provider.exchangeCode("c");
    expect(headers?.Authorization).toBe(
      `Basic ${Buffer.from("optio-client:shh").toString("base64")}`,
    );
    const user = await provider.fetchUser(tokens.accessToken, tokens);
    expect(user.emailVerified).toBe(false);
    expect(user.displayName).toBe("bo@example.com");
  });

  it("honors explicit email trust when the claim is absent, never overriding a false claim", async () => {
    const provider = new GenericOIDCProvider(async () =>
      config({ usePkce: false, trustEmail: true }),
    );
    let claims: Record<string, unknown> = {};
    serve({
      [`${ISSUER}/.well-known`]: () => jsonResponse(DISCOVERY),
      [DISCOVERY.token_endpoint]: () => jsonResponse({ access_token: "at" }),
      [DISCOVERY.userinfo_endpoint]: () => jsonResponse(claims),
    });
    await provider.prepare();
    const signIn = async (c: Record<string, unknown>) => {
      claims = { sub: "u3", email: "admin@acme.com", ...c };
      return (await provider.fetchUser("at", { accessToken: "at" })).emailVerified;
    };
    expect(await signIn({})).toBe(true);
    expect(await signIn({ email_verified: true })).toBe(true);
    expect(await signIn({ email_verified: "true" })).toBe(true);
    expect(await signIn({ email_verified: false })).toBe(false);
    expect(await signIn({ email_verified: "false" })).toBe(false);
  });

  it("rejects a tampered ID token, a wrong nonce, and a token error", async () => {
    const provider = new GenericOIDCProvider(async () => config());
    const flow = provider.beginFlow();
    const good = await idToken({ sub: "u1" }, { nonce: flow.nonce });
    const tampered = good.slice(0, -4) + "AAAA";
    let reply: unknown = { access_token: "at", id_token: tampered };
    serve({
      [`${ISSUER}/.well-known`]: () => jsonResponse(DISCOVERY),
      [DISCOVERY.jwks_uri]: () => jsonResponse(jwks),
      [DISCOVERY.token_endpoint]: () => jsonResponse(reply),
    });
    await provider.prepare();
    await expect(provider.exchangeCode("c", flow)).rejects.toThrow(/ID token verification failed/);

    reply = { access_token: "at", id_token: await idToken({ sub: "u1" }, { nonce: "other" }) };
    await expect(provider.exchangeCode("c", flow)).rejects.toThrow(/nonce mismatch/);

    reply = { error: "invalid_grant", error_description: "Code not valid" };
    await expect(provider.exchangeCode("c", flow)).rejects.toThrow(/Code not valid/);

    reply = { access_token: "at" };
    await expect(provider.exchangeCode("c", flow)).rejects.toThrow(/no ID token/);
  });

  it("works without a userinfo endpoint from the ID token alone, and refuses a subject mismatch", async () => {
    const provider = new GenericOIDCProvider(async () => config());
    const { userinfo_endpoint: _omit, ...noUserinfo } = DISCOVERY;
    void _omit;
    serve({ [`${ISSUER}/.well-known`]: () => jsonResponse(noUserinfo) });
    await provider.prepare();
    const token = await idToken({ sub: "u3", email: "cy@example.com", name: "Cy" });
    expect(await provider.fetchUser("at", { accessToken: "at", idToken: token })).toMatchObject({
      externalId: "u3",
      email: "cy@example.com",
      displayName: "Cy",
      groups: [],
    });

    const withUserinfo = new GenericOIDCProvider(async () => config());
    serve({
      [`${ISSUER}/.well-known`]: () => jsonResponse(DISCOVERY),
      [DISCOVERY.userinfo_endpoint]: () => jsonResponse({ sub: "someone-else" }),
    });
    await withUserinfo.prepare();
    await expect(
      withUserinfo.fetchUser("at", { accessToken: "at", idToken: token }),
    ).rejects.toThrow(/different subject/);
  });

  it("reads the environment alone under test without a DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("OIDC_ISSUER_URL", ISSUER);
    vi.stubEnv("OIDC_CLIENT_ID", "env-client");
    serve({ [`${ISSUER}/.well-known`]: () => jsonResponse(DISCOVERY) });
    const provider = new GenericOIDCProvider();
    await provider.prepare();
    const url = new URL(provider.authorizeUrl("st4te", provider.beginFlow()));
    expect(url.searchParams.get("client_id")).toBe("env-client");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(resolveProviderConfig).not.toHaveBeenCalled();

    // With a database, the stored settings come first.
    vi.stubEnv("DATABASE_URL", "postgres://optio@db.invalid/optio");
    provider.reset();
    await expect(provider.prepare()).rejects.toThrow(/no database in a unit test/);
    expect(resolveProviderConfig).toHaveBeenCalledWith("oidc");
  });

  it("says so when the sign-in isn't configured", async () => {
    const provider = new GenericOIDCProvider(async () => null);
    await expect(provider.prepare()).rejects.toThrow(/isn't configured/);
  });
});

describe("GenericOIDCProvider — the environment's OIDC", () => {
  const envConfig = (settings: Partial<OidcClientConfig["settings"]> = {}): OidcClientConfig => ({
    ...config({ scopes: "openid email profile", trustEmail: false, usePkce: false, ...settings }),
    source: "environment",
  });

  it("asks for no nonce and no PKCE unless OIDC_USE_PKCE turned it on", async () => {
    serve({ [`${ISSUER}/.well-known`]: () => jsonResponse(DISCOVERY) });
    const plain = new GenericOIDCProvider(async () => envConfig());
    await plain.prepare();
    const flow = plain.beginFlow();
    const url = new URL(plain.authorizeUrl("st4te", flow));
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("nonce")).toBeNull();
    expect(url.searchParams.get("code_challenge")).toBeNull();

    const pkce = new GenericOIDCProvider(async () => envConfig({ usePkce: true }));
    await pkce.prepare();
    const withPkce = new URL(pkce.authorizeUrl("st4te", pkce.beginFlow()));
    expect(withPkce.searchParams.get("code_challenge_method")).toBe("S256");
    expect(withPkce.searchParams.get("nonce")).toBeNull();
  });

  it("accepts a token response without an ID token and trusts only a verified email", async () => {
    const provider = new GenericOIDCProvider(async () => envConfig());
    serve({
      [`${ISSUER}/.well-known`]: () => jsonResponse(DISCOVERY),
      [DISCOVERY.token_endpoint]: () => jsonResponse({ access_token: "at" }),
      [DISCOVERY.userinfo_endpoint]: () =>
        jsonResponse({ sub: "u9", email: "dee@acme.com", name: "Dee Doe" }),
    });
    const tokens = await provider.exchangeCode("code", provider.beginFlow());
    expect(tokens).toMatchObject({ accessToken: "at", idToken: undefined });
    expect(await provider.fetchUser(tokens.accessToken, tokens)).toMatchObject({
      externalId: "u9",
      email: "dee@acme.com",
      displayName: "Dee Doe",
      emailVerified: false,
    });
  });
});
