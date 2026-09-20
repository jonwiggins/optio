import type { OAuthProvider, OAuthTokens, OAuthUser } from "./provider.js";
import { getCallbackUrl } from "./provider.js";

export class GitLabOAuthProvider implements OAuthProvider {
  name = "gitlab";

  private get baseUrl(): string {
    return process.env.GITLAB_OAUTH_BASE_URL ?? "https://gitlab.com";
  }

  private get clientId(): string {
    return process.env.GITLAB_OAUTH_CLIENT_ID ?? "";
  }

  private get clientSecret(): string {
    return process.env.GITLAB_OAUTH_CLIENT_SECRET ?? "";
  }

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: getCallbackUrl("gitlab"),
      response_type: "code",
      scope: "read_user",
      state,
    });
    return `${this.baseUrl}/oauth/authorize?${params}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    const res = await fetch(`${this.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: getCallbackUrl("gitlab"),
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      throw new Error(`GitLab token exchange failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as Record<string, any>;
    if (data.error) {
      throw new Error(`GitLab OAuth error: ${data.error_description ?? data.error}`);
    }
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
  }

  async fetchUser(accessToken: string): Promise<OAuthUser> {
    const res = await fetch(`${this.baseUrl}/api/v4/user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`GitLab user fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as Record<string, any>;
    return {
      externalId: String(data.id),
      email: data.email ?? "",
      displayName: data.name ?? data.username ?? "",
      username: data.username ?? undefined,
      avatarUrl: data.avatar_url,
    };
  }
}
