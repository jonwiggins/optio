import type { OAuthProvider, OAuthTokens, OAuthUser } from "./provider.js";
import { getCallbackUrl } from "./provider.js";

export class GitHubOAuthProvider implements OAuthProvider {
  name = "github";

  private get clientId(): string {
    return process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_OAUTH_CLIENT_ID ?? "";
  }

  private get clientSecret(): string {
    return process.env.GITHUB_APP_CLIENT_SECRET ?? process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "";
  }

  private get isGitHubApp(): boolean {
    return !!(process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET);
  }

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: getCallbackUrl("github"),
      state,
    });
    if (!this.isGitHubApp) {
      params.set("scope", "read:user user:email");
    }
    return `https://github.com/login/oauth/authorize?${params}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: getCallbackUrl("github"),
      }),
    });
    if (!res.ok) {
      throw new Error(`GitHub token exchange failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as Record<string, string | number>;
    if (data.error) {
      throw new Error(`GitHub OAuth error: ${(data.error_description as string) ?? data.error}`);
    }
    return {
      accessToken: data.access_token as string,
      refreshToken: data.refresh_token as string | undefined,
      expiresIn: (data.expires_in as number | undefined) ?? undefined,
    };
  }

  async fetchUser(accessToken: string): Promise<OAuthUser> {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };

    const userRes = await fetch("https://api.github.com/user", { headers });
    if (!userRes.ok) {
      throw new Error(`GitHub user fetch failed: ${userRes.status} ${userRes.statusText}`);
    }
    const user = (await userRes.json()) as Record<string, any>;

    // The /user/emails endpoint requires the "email addresses" account permission.
    // GitHub Apps may not have this configured, so fall back to the public email
    // from /user if the emails endpoint is inaccessible.
    let email = user.email ?? "";
    const emailsRes = await fetch("https://api.github.com/user/emails", { headers });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      const primaryEmail = emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email;
      if (primaryEmail) {
        email = primaryEmail;
      }
    }

    return {
      externalId: String(user.id),
      email,
      displayName: user.name || user.login || "",
      avatarUrl: user.avatar_url,
    };
  }
}
