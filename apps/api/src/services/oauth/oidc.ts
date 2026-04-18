import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OAuthProvider, OAuthTokens, OAuthUser } from "./provider.js";
import { getCallbackUrl } from "./provider.js";

interface OIDCDiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class GenericOIDCProvider implements OAuthProvider {
  name = "oidc";

  private discoveryCache: { doc: OIDCDiscoveryDocument; fetchedAt: number } | null = null;
  private jwksGetter: ReturnType<typeof createRemoteJWKSet> | null = null;

  private get issuerUrl(): string {
    return (process.env.OIDC_ISSUER_URL ?? "").replace(/\/$/, "");
  }

  private get clientId(): string {
    return process.env.OIDC_CLIENT_ID ?? "";
  }

  private get clientSecret(): string {
    return process.env.OIDC_CLIENT_SECRET ?? "";
  }

  private get scopes(): string {
    return process.env.OIDC_SCOPES ?? "openid email profile";
  }

  async discover(): Promise<OIDCDiscoveryDocument> {
    const now = Date.now();
    if (this.discoveryCache && now - this.discoveryCache.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
      return this.discoveryCache.doc;
    }

    const url = `${this.issuerUrl}/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText}`);
    }
    const doc = (await res.json()) as OIDCDiscoveryDocument;

    if (
      !doc.authorization_endpoint ||
      !doc.token_endpoint ||
      !doc.userinfo_endpoint ||
      !doc.jwks_uri
    ) {
      throw new Error("OIDC discovery document missing required endpoints");
    }

    this.discoveryCache = { doc, fetchedAt: now };
    // Reset JWKS getter when discovery changes
    this.jwksGetter = null;
    return doc;
  }

  private getJWKS(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
    if (!this.jwksGetter) {
      this.jwksGetter = createRemoteJWKSet(new URL(jwksUri));
    }
    return this.jwksGetter;
  }

  async prepare(): Promise<void> {
    await this.discover();
  }

  authorizeUrl(state: string): string {
    if (!this.discoveryCache) {
      throw new Error("OIDC discovery document not loaded — call prepare() first");
    }
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: getCallbackUrl("oidc"),
      response_type: "code",
      scope: this.scopes,
      state,
    });
    return `${this.discoveryCache.doc.authorization_endpoint}?${params}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    const discovery = await this.discover();

    const res = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: getCallbackUrl("oidc"),
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      throw new Error(`OIDC token exchange failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as Record<string, any>;
    if (data.error) {
      throw new Error(`OIDC OAuth error: ${data.error_description ?? data.error}`);
    }

    // Verify the ID token signature if present
    if (data.id_token) {
      const jwks = this.getJWKS(discovery.jwks_uri);
      try {
        await jwtVerify(data.id_token, jwks, {
          issuer: this.issuerUrl,
          audience: this.clientId,
        });
      } catch (err) {
        throw new Error(
          `OIDC ID token verification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  async fetchUser(accessToken: string): Promise<OAuthUser> {
    const discovery = await this.discover();

    const res = await fetch(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`OIDC userinfo fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as Record<string, any>;
    return {
      externalId: String(data.sub),
      email: data.email ?? "",
      displayName: data.name ?? data.preferred_username ?? "",
      avatarUrl: data.picture,
    };
  }
}
