import { gitLabFetch } from "../gitlab-instance-runtime.js";
import type { OAuthProvider, OAuthTokens, OAuthUser } from "./provider.js";
import { getCallbackUrl } from "./provider.js";

/**
 * "Use my GitLab account for my work" (`GITLAB_OAUTH_STORE_USER_TOKEN`, off by
 * default): sign-in asks for the API too and gitlab-user-token-service.ts
 * keeps the person's tokens.
 */
export function gitlabUserTokensEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["true", "1", "yes", "on"].includes(
    (env.GITLAB_OAUTH_STORE_USER_TOKEN ?? "").trim().toLowerCase(),
  );
}

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
      // "Use my GitLab account for my work" (opt-in): the API too, so the
      // token sign-in keeps can do the person's work (gitlab-user-token-service.ts).
      scope: gitlabUserTokensEnabled() ? "read_user api" : "read_user",
      state,
    });
    return `${this.baseUrl}/oauth/authorize?${params}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    const res = await gitLabFetch(`${this.baseUrl}/oauth/token`, {
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
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      ...(typeof data.expires_in === "number" ? { expiresIn: data.expires_in } : {}),
    };
  }

  async fetchUser(accessToken: string): Promise<OAuthUser> {
    const res = await gitLabFetch(`${this.baseUrl}/api/v4/user`, {
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
      emailVerified: !!data.email && !!data.confirmed_at,
    };
  }
}
