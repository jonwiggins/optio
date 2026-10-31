import { createHash, randomBytes } from "node:crypto";
import { guardedFetch } from "../../utils/outbound-url.js";
import {
  secureIdentityProviderUrl,
  insecureIdentityProviderTlsAllowed,
} from "../../utils/idp-url.js";
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify } from "jose";
import type { OidcPreset, OidcSettings } from "@optio/shared";
import type { OAuthFlowState, OAuthProvider, OAuthTokens, OAuthUser } from "./provider.js";
import { getCallbackUrl } from "./provider.js";
import { envConfig } from "../sign-in-env.js";

/**
 * OpenID Connect sign-in against the organization's own provider (Auth0,
 * Authentik, Authelia, ADFS, Entra ID, Keycloak, Okta, Zitadel…), configured
 * in the app (Settings → Sign-in; `resolveProviderConfig("oidc")`) or by the
 * `OIDC_*` environment variables. The same client signs in through a Gitea or
 * Forgejo server (`name: "gitea"`, services/oauth/gitea.ts), whose OAuth2
 * applications are OpenID Connect underneath.
 *
 * - Discovery (`<issuer>/.well-known/openid-configuration`) is cached per
 *   issuer for 24 h; a settings change resets it.
 * - Authorization code flow; the ID token, when the provider sends one, is
 *   verified against the provider's JWKS (issuer, audience) and its claims
 *   merged with userinfo (the ID token wins for `sub`). A provider set up in
 *   the app also uses PKCE (S256, unless turned off) and a nonce; the
 *   environment's turns PKCE on with `OIDC_USE_PKCE=true`.
 * - The person's groups come from the configured claim (ID token, then
 *   userinfo); a role claim shaped like Keycloak's `realm_access.roles` is
 *   read with a dotted path.
 * - A private CA (`caPem`) is trusted for discovery, JWKS, token and userinfo
 *   requests through the DNS-pinned outbound transport, so the deployment-wide
 *   `NODE_EXTRA_CA_CERTS` isn't required for the identity provider alone.
 *   Every request obeys the outbound policy and refuses redirects.
 */

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  scopes_supported?: string[];
  claims_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

/** What the provider needs at request time; `settings` is the stored shape. */
export interface OidcClientConfig {
  clientId: string;
  clientSecret: string;
  settings: OidcSettings;
  /** Where it was configured: the app also sends a nonce; the environment doesn't. */
  source?: "database" | "environment";
  /** Send a nonce whatever the source (a provider with no older setup to stay compatible with). */
  sendNonce?: boolean;
}

/** Whether this config's authorization request carries a nonce. */
function sendsNonce(config: OidcClientConfig): boolean {
  return config.sendNonce ?? config.source !== "environment";
}

const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Defaults a preset implies; an explicit setting always wins. */
export function oidcPresetDefaults(preset: OidcPreset | undefined): Partial<OidcSettings> {
  switch (preset) {
    case "keycloak":
      // Keycloak needs a "groups" mapper on the client (Client scopes → add
      // mapper → Group Membership, claim name `groups`, full path off).
      return { scopes: "openid profile email", groupsClaim: "groups" };
    case "authentik":
      return { scopes: "openid profile email", groupsClaim: "groups" };
    case "adfs":
      // ADFS: `allatclaims` carries the group claims an issuance rule emits.
      return { scopes: "openid profile email allatclaims", groupsClaim: "groups" };
    case "entra":
      return { scopes: "openid profile email", groupsClaim: "groups" };
    case "okta":
      return { scopes: "openid profile email groups", groupsClaim: "groups" };
    case "zitadel":
      return {
        scopes: "openid profile email urn:zitadel:iam:org:project:roles",
        groupsClaim: "urn:zitadel:iam:org:project:roles",
      };
    case "authelia":
      return { scopes: "openid profile email groups", groupsClaim: "groups" };
    case "auth0":
      // Auth0 sends groups only from a post-login Action that sets the claim.
      return { scopes: "openid profile email", groupsClaim: "groups" };
    default:
      return { scopes: "openid profile email", groupsClaim: "groups" };
  }
}

/** The settings with every default filled in. */
export function effectiveOidcSettings(
  settings: OidcSettings,
): Required<
  Pick<
    OidcSettings,
    | "issuerUrl"
    | "scopes"
    | "groupsClaim"
    | "emailClaim"
    | "nameClaim"
    | "usernameClaim"
    | "trustEmail"
    | "usePkce"
    | "tokenAuthMethod"
    | "insecureSkipVerify"
  >
> &
  OidcSettings {
  const preset = oidcPresetDefaults(settings.preset);
  return {
    ...settings,
    issuerUrl: settings.issuerUrl.trim().replace(/\/+$/, ""),
    scopes: settings.scopes?.trim() || preset.scopes || "openid profile email",
    groupsClaim: settings.groupsClaim?.trim() || preset.groupsClaim || "groups",
    emailClaim: settings.emailClaim?.trim() || "email",
    nameClaim: settings.nameClaim?.trim() || "name",
    usernameClaim: settings.usernameClaim?.trim() || "preferred_username",
    trustEmail: settings.trustEmail ?? false,
    usePkce: settings.usePkce ?? true,
    tokenAuthMethod: settings.tokenAuthMethod ?? "client_secret_post",
    insecureSkipVerify: settings.insecureSkipVerify ?? false,
  };
}

/** `a.b.c` into a claims object; an array of strings, a single string, or nothing. */
/** Whether `path` (a claim name, or `a.b.c` into the claims) is there at all. */
export function claimPresent(claims: Record<string, unknown>, path: string): boolean {
  if (Object.hasOwn(claims, path)) return claims[path] !== undefined && claims[path] !== null;
  let node: unknown = claims;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object" || !Object.hasOwn(node, part)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return node !== undefined && node !== null;
}

export function claimAsList(claims: Record<string, unknown>, path: string): string[] {
  let node: unknown = Object.hasOwn(claims, path) ? claims[path] : claims;
  for (const part of Object.hasOwn(claims, path) ? [] : path.split(".")) {
    if (!node || typeof node !== "object") return [];
    node = (node as Record<string, unknown>)[part];
  }
  if (Array.isArray(node)) return node.filter((g): g is string => typeof g === "string");
  if (typeof node === "string")
    return node
      .split(",")
      .map((group) => group.trim())
      .filter(Boolean);
  if (path === "urn:zitadel:iam:org:project:roles" && node && typeof node === "object") {
    return Object.keys(node);
  }
  return [];
}

/**
 * `a.b.c` into a claims object as one string: a string claim whole (a name
 * keeps its spaces), else the first of a list.
 */
function claimAsString(claims: Record<string, unknown>, path: string): string | undefined {
  const raw = claims[path];
  if (typeof raw === "string") return raw;
  let node: unknown = claims;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node === "string") return node;
  return claimAsList(claims, path)[0];
}

/**
 * The fetch for this provider's requests: the global one, or — with a private
 * CA or verification turned off — an undici fetch bound to that TLS trust.
 */
export function oidcFetch(
  settings: Pick<OidcSettings, "caPem" | "insecureSkipVerify">,
): ((input: string | URL, init?: RequestInit) => Promise<Response>) | null {
  if (settings.insecureSkipVerify && !insecureIdentityProviderTlsAllowed()) {
    throw new Error("Insecure identity-provider TLS is disabled by deployment policy");
  }
  const tls = {
    ...(settings.caPem?.trim() ? { ca: settings.caPem } : {}),
    ...(settings.insecureSkipVerify ? { rejectUnauthorized: false } : {}),
  };
  return (input: string | URL, init?: RequestInit): Promise<Response> => {
    if (!secureIdentityProviderUrl(input.toString()))
      throw new Error("Identity-provider endpoints must use https://");
    return guardedFetch(input, { ...init, tls, redirect: "error", timeoutMs: REQUEST_TIMEOUT_MS });
  };
}

export async function discoverOidc(
  settings: Pick<OidcSettings, "issuerUrl" | "caPem" | "insecureSkipVerify">,
): Promise<OidcDiscoveryDocument> {
  const issuer = settings.issuerUrl.trim().replace(/\/+$/, "");
  if (!secureIdentityProviderUrl(issuer))
    throw new Error("The issuer URL must start with https://");
  const tlsFetch = oidcFetch(settings);
  const url = `${issuer}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = tlsFetch ? await tlsFetch(url) : await fetch(url);
  } catch (err) {
    throw new Error(`Could not reach ${issuer}: ${describeFetchError(err)}`);
  }
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText}`);
  const doc = (await res.json()) as Partial<OidcDiscoveryDocument>;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error(
      "OIDC discovery document missing required endpoints (authorization_endpoint, token_endpoint, jwks_uri)",
    );
  }
  if (!doc.issuer) throw new Error("OIDC discovery document missing required issuer");
  if (doc.issuer.replace(/\/+$/, "") !== issuer) {
    throw new Error(
      `The provider says its issuer is ${doc.issuer}, not ${issuer} — use that exact URL`,
    );
  }
  for (const endpoint of [
    doc.authorization_endpoint,
    doc.token_endpoint,
    doc.userinfo_endpoint,
    doc.jwks_uri,
  ]) {
    if (endpoint && !secureIdentityProviderUrl(endpoint))
      throw new Error("Identity-provider endpoints must use https://");
  }
  return doc as OidcDiscoveryDocument;
}

/** The underlying cause of a failed fetch, for the admin (a TLS error names the fix). */
export function describeFetchError(err: unknown): string {
  const cause = (err as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? "";
  const message = err instanceof Error ? err.message : "";
  if (
    /CERT_|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY_LEAF_SIGNATURE|certificate|self.signed/i.test(
      `${code} ${message}`,
    )
  )
    return "The identity provider's TLS certificate is not trusted; configure its certificate authority";
  if (/timeout|aborted/i.test(`${code} ${message}`))
    return "The identity provider request timed out";
  return "Could not connect to the identity provider";
}

export class GenericOIDCProvider implements OAuthProvider {
  private discoveryCache: {
    issuer: string;
    doc: OidcDiscoveryDocument;
    fetchedAt: number;
  } | null = null;
  private jwks: { uri: string; getter: ReturnType<typeof createRemoteJWKSet> } | null = null;
  /** The config `prepare()` read, for the synchronous `authorizeUrl`. */
  private cachedConfig: OidcClientConfig | null = null;

  /**
   * How the config is read (swapped in tests); `name`: the provider whose
   * callback this is (`oidc`, or `gitea` for a Gitea / Forgejo server).
   */
  constructor(
    private readonly loadConfig: () => Promise<OidcClientConfig | null> = defaultLoadConfig,
    readonly name: string = "oidc",
  ) {}

  private async config(): Promise<OidcClientConfig> {
    const config = await this.loadConfig();
    if (!config) throw new Error(`${this.name} sign-in isn't configured`);
    return config;
  }

  async discover(): Promise<OidcDiscoveryDocument> {
    const { settings } = await this.config();
    const issuer = settings.issuerUrl.trim().replace(/\/+$/, "");
    const now = Date.now();
    if (
      this.discoveryCache &&
      this.discoveryCache.issuer === issuer &&
      now - this.discoveryCache.fetchedAt < DISCOVERY_CACHE_TTL_MS
    ) {
      return this.discoveryCache.doc;
    }
    const doc = await discoverOidc(settings);
    this.discoveryCache = { issuer, doc, fetchedAt: now };
    this.jwks = null;
    return doc;
  }

  /** Forget cached discovery (after the settings change). */
  reset(): void {
    this.discoveryCache = null;
    this.jwks = null;
  }

  /** Read the config and discovery before `authorizeUrl`, which is synchronous. */
  async prepare(): Promise<void> {
    this.cachedConfig = await this.loadConfig();
    await this.discover();
  }

  beginFlow(): OAuthFlowState {
    return {
      codeVerifier: randomBytes(32).toString("base64url"),
      nonce: randomBytes(16).toString("hex"),
    };
  }

  authorizeUrl(state: string, flow?: OAuthFlowState): string {
    if (!this.discoveryCache) {
      throw new Error("OIDC discovery document not loaded — call prepare() first");
    }
    const config = this.cachedConfig;
    if (!config) throw new Error(`${this.name} sign-in isn't configured`);
    const settings = effectiveOidcSettings(config.settings);
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: getCallbackUrl(this.name),
      response_type: "code",
      scope: settings.scopes,
      state,
    });
    if (flow?.nonce && sendsNonce(config)) params.set("nonce", flow.nonce);
    if (settings.usePkce && flow?.codeVerifier) {
      params.set(
        "code_challenge",
        createHash("sha256").update(flow.codeVerifier).digest("base64url"),
      );
      params.set("code_challenge_method", "S256");
    }
    return `${this.discoveryCache.doc.authorization_endpoint}?${params}`;
  }

  async exchangeCode(code: string, flow?: OAuthFlowState): Promise<OAuthTokens> {
    const config = await this.config();
    const settings = effectiveOidcSettings(config.settings);
    const discovery = await this.discover();
    const send = oidcFetch(settings) ?? fetch;
    const nonce = sendsNonce(config) ? flow?.nonce : undefined;

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: getCallbackUrl(this.name),
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (settings.tokenAuthMethod === "client_secret_basic") {
      headers.Authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
      ).toString("base64")}`;
    } else {
      body.set("client_id", config.clientId);
      body.set("client_secret", config.clientSecret);
    }
    if (settings.usePkce && flow?.codeVerifier) body.set("code_verifier", flow.codeVerifier);

    let res: Response;
    try {
      res = await send(discovery.token_endpoint, { method: "POST", headers, body });
    } catch (err) {
      throw new Error(`OIDC token exchange failed: ${describeFetchError(err)}`);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const detail = (data.error_description as string) ?? (data.error as string) ?? "";
    if (!res.ok) {
      throw new Error(
        `OIDC token exchange failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
      );
    }
    if (data.error) throw new Error(`OIDC OAuth error: ${detail}`);
    if (typeof data.access_token !== "string") {
      throw new Error("OIDC token exchange returned no access_token");
    }

    if (typeof data.id_token === "string") {
      await this.verifyIdToken(data.id_token, config, settings, discovery, nonce);
    } else if (nonce) {
      throw new Error("The provider returned no ID token (is the openid scope allowed?)");
    }

    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expiresIn: typeof data.expires_in === "number" ? data.expires_in : undefined,
      idToken: typeof data.id_token === "string" ? data.id_token : undefined,
    };
  }

  private async verifyIdToken(
    idToken: string,
    config: OidcClientConfig,
    settings: ReturnType<typeof effectiveOidcSettings>,
    discovery: OidcDiscoveryDocument,
    nonce: string | undefined,
  ): Promise<void> {
    if (!this.jwks || this.jwks.uri !== discovery.jwks_uri) {
      const tlsFetch = oidcFetch(settings)!;
      this.jwks = {
        uri: discovery.jwks_uri,
        getter: createRemoteJWKSet(
          new URL(discovery.jwks_uri),
          tlsFetch
            ? {
                [customFetch]: tlsFetch as unknown as NonNullable<
                  Parameters<typeof createRemoteJWKSet>[1]
                >[typeof customFetch],
              }
            : undefined,
        ),
      };
    }
    try {
      const { payload } = await jwtVerify(idToken, this.jwks.getter, {
        issuer: discovery.issuer ?? settings.issuerUrl,
        audience: config.clientId,
      });
      if (nonce && payload.nonce !== nonce) throw new Error("nonce mismatch");
    } catch (err) {
      throw new Error(
        `OIDC ID token verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async fetchUser(accessToken: string, tokens?: OAuthTokens): Promise<OAuthUser> {
    const config = await this.config();
    const settings = effectiveOidcSettings(config.settings);
    const discovery = await this.discover();

    // The ID token's claims (verified in exchangeCode), then userinfo on top
    // of them — a provider often puts groups in only one of the two.
    const idToken = tokens?.idToken;
    const idClaims: Record<string, unknown> = idToken
      ? (decodeJwt(idToken) as Record<string, unknown>)
      : {};
    let userinfo: Record<string, unknown> = {};
    if (discovery.userinfo_endpoint) {
      const send = oidcFetch(settings) ?? fetch;
      let res: Response;
      try {
        res = await send(discovery.userinfo_endpoint, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        });
      } catch (err) {
        throw new Error(`OIDC userinfo fetch failed: ${describeFetchError(err)}`);
      }
      if (!res.ok) throw new Error(`OIDC userinfo fetch failed: ${res.status} ${res.statusText}`);
      userinfo = (await res.json()) as Record<string, unknown>;
    } else if (!idToken) {
      throw new Error("The provider has no userinfo endpoint and sent no ID token");
    }
    const claims = { ...userinfo, ...idClaims };
    if (userinfo.sub && idClaims.sub && userinfo.sub !== idClaims.sub) {
      throw new Error("OIDC userinfo belongs to a different subject than the ID token");
    }

    const sub = claims.sub;
    if (typeof sub !== "string" || !sub) throw new Error("OIDC claims carry no sub");
    const email = claimAsString(claims, settings.emailClaim) ?? "";
    const username = claimAsString(claims, settings.usernameClaim);
    const name = claimAsString(claims, settings.nameClaim);
    const groups = [
      ...new Set([
        ...claimAsList(idClaims, settings.groupsClaim),
        ...claimAsList(userinfo, settings.groupsClaim),
      ]),
    ];
    const groupsClaimMissing =
      !claimPresent(idClaims, settings.groupsClaim) &&
      !claimPresent(userinfo, settings.groupsClaim);
    // `trustEmail` stands in for a missing claim, never for a "false" one.
    const verifiedClaim = claims.email_verified;
    const asserted = !!email && (verifiedClaim === true || verifiedClaim === "true");
    const emailVerified =
      asserted || (!!email && verifiedClaim === undefined && !!settings.trustEmail);
    return {
      externalId: sub,
      email,
      displayName: name || username || email || sub,
      username: username ?? undefined,
      avatarUrl: typeof claims.picture === "string" ? claims.picture : undefined,
      emailVerified,
      emailVerifiedByProvider: asserted,
      groups,
      ...(groupsClaimMissing ? { groupsClaimMissing } : {}),
    };
  }
}

/**
 * The stored settings, else the environment's (`resolveProviderConfig`).
 * Under test with no `DATABASE_URL`, nothing stored can apply: the
 * environment alone, without asking a Postgres at the default address.
 */
async function defaultLoadConfig(): Promise<OidcClientConfig | null> {
  if (process.env.NODE_ENV === "test" && !process.env.DATABASE_URL) {
    const env = envConfig("oidc");
    return (
      env && {
        clientId: env.clientId,
        clientSecret: env.clientSecret,
        settings: env.settings as OidcSettings,
        source: "environment",
      }
    );
  }
  const { resolveProviderConfig } = await import("../sign-in-config-service.js");
  const resolved = await resolveProviderConfig("oidc");
  if (!resolved) return null;
  return {
    clientId: resolved.clientId,
    clientSecret: resolved.clientSecret,
    settings: resolved.settings as OidcSettings,
    source: resolved.source,
  };
}
