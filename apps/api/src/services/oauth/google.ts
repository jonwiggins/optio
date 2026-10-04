import type { OAuthProvider, OAuthTokens, OAuthUser } from "./provider.js";
import { getCallbackUrl } from "./provider.js";
import { resolveProviderConfig } from "../sign-in-config-service.js";

/**
 * Google sign-in. Its client comes from Settings → Sign-in when one is stored
 * there (`auth_provider_configs`), else from `GOOGLE_OAUTH_CLIENT_ID` /
 * `GOOGLE_OAUTH_CLIENT_SECRET`. `prepare()` loads it before `authorizeUrl`;
 * `exchangeCode` loads it again (a different replica may answer the callback).
 */
export class GoogleOAuthProvider implements OAuthProvider {
  name = "google";

  private config: { clientId: string; clientSecret: string; allowedDomains: string[] } | null =
    null;

  private async load() {
    const resolved = await resolveProviderConfig("google");
    this.config = resolved
      ? {
          clientId: resolved.clientId,
          clientSecret: resolved.clientSecret,
          allowedDomains: resolved.allowedDomains,
        }
      : {
          clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
          clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
          allowedDomains: [],
        };
    return this.config;
  }

  async prepare(): Promise<void> {
    await this.load();
  }

  authorizeUrl(state: string): string {
    const cfg = this.config ?? {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      allowedDomains: [] as string[],
    };
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: getCallbackUrl("google"),
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "offline",
      prompt: "consent",
    });
    // A hint to Google's account chooser only; the callback enforces the
    // domains (`domainDecision`) from what Google actually returns.
    if (cfg.allowedDomains.length === 1) params.set("hd", cfg.allowedDomains[0]);
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    const cfg = await this.load();
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: getCallbackUrl("google"),
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as Record<string, any>;
    if (data.error) {
      throw new Error(`Google OAuth error: ${data.error_description ?? data.error}`);
    }
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
  }

  async fetchUser(accessToken: string): Promise<OAuthUser> {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Google user fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as Record<string, any>;
    return {
      externalId: String(data.id),
      email: data.email ?? "",
      displayName: data.name ?? "",
      avatarUrl: data.picture,
      emailVerified: data.verified_email === true,
      // Set for Google Workspace accounts only; what the allowed domains check.
      hostedDomain: typeof data.hd === "string" && data.hd ? data.hd : null,
    };
  }
}
