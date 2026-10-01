import type { OAuthProvider, OAuthTokens, OAuthUser } from "./provider.js";
import { getCallbackUrl } from "./provider.js";

export class GoogleOAuthProvider implements OAuthProvider {
  name = "google";

  private get clientId(): string {
    return process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
  }

  private get clientSecret(): string {
    return process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
  }

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: getCallbackUrl("google"),
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
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
    };
  }
}
