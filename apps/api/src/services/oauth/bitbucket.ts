import type { OAuthProvider, OAuthTokens, OAuthUser } from "./provider.js";

/**
 * Sign-in with a **Bitbucket Cloud** account: an OAuth consumer in a
 * Bitbucket workspace (Workspace settings → OAuth consumers) with the
 * `account` and `email` permissions and the callback URL
 * `<API origin>/api/auth/bitbucket/callback`.
 *
 * The person is their Bitbucket account (`uuid`); the email is the primary
 * one, verified when Bitbucket says it is confirmed; their **groups** are
 * the slugs of the workspaces they belong to, so required and admin groups
 * can say "members of workspace acme". Configured in the app (Settings →
 * Sign-in → Bitbucket) or by `BITBUCKET_OAUTH_CLIENT_ID` and
 * `BITBUCKET_OAUTH_CLIENT_SECRET`.
 */

interface BitbucketClient {
  clientId: string;
  clientSecret: string;
}

interface BitbucketUrls {
  /** Where people authorize and the token endpoint live. */
  site: string;
  /** The REST API. */
  api: string;
}

const DEFAULT_URLS: BitbucketUrls = {
  site: "https://bitbucket.org",
  api: "https://api.bitbucket.org/2.0",
};

async function loadBitbucketClient(): Promise<BitbucketClient | null> {
  const { resolveProviderConfig } = await import("../sign-in-config-service.js");
  const resolved = await resolveProviderConfig("bitbucket");
  return resolved ? { clientId: resolved.clientId, clientSecret: resolved.clientSecret } : null;
}

export class BitbucketOAuthProvider implements OAuthProvider {
  name = "bitbucket";
  /** The client `prepare()` read, for the synchronous `authorizeUrl`. */
  private cached: BitbucketClient | null = null;

  constructor(
    private readonly loadClient: () => Promise<BitbucketClient | null> = loadBitbucketClient,
    private readonly urls: BitbucketUrls = DEFAULT_URLS,
  ) {}

  private async client(): Promise<BitbucketClient> {
    const client = await this.loadClient();
    if (!client) throw new Error("Bitbucket sign-in isn't configured");
    return client;
  }

  async prepare(): Promise<void> {
    this.cached = await this.client();
  }

  authorizeUrl(state: string): string {
    if (!this.cached) throw new Error("Bitbucket sign-in isn't configured — call prepare() first");
    // Bitbucket sends the browser back to the consumer's own callback URL.
    const params = new URLSearchParams({
      client_id: this.cached.clientId,
      response_type: "code",
      state,
    });
    return `${this.urls.site}/site/oauth2/authorize?${params}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    const { clientId, clientSecret } = await this.client();
    const res = await fetch(`${this.urls.site}/site/oauth2/access_token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.error) {
      const detail = (data.error_description as string) ?? (data.error as string) ?? "";
      throw new Error(
        `Bitbucket token exchange failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
      );
    }
    if (typeof data.access_token !== "string") {
      throw new Error("Bitbucket token exchange returned no access_token");
    }
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expiresIn: typeof data.expires_in === "number" ? data.expires_in : undefined,
    };
  }

  async fetchUser(accessToken: string): Promise<OAuthUser> {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
    const userRes = await fetch(`${this.urls.api}/user`, { headers });
    if (!userRes.ok) {
      throw new Error(`Bitbucket user fetch failed: ${userRes.status} ${userRes.statusText}`);
    }
    const user = (await userRes.json()) as Record<string, any>;

    let email = "";
    let emailVerified = false;
    const emailsRes = await fetch(`${this.urls.api}/user/emails?pagelen=100`, { headers });
    if (emailsRes.ok) {
      const emails = ((await emailsRes.json()) as { values?: Array<Record<string, any>> }).values;
      const primary = emails?.find((e) => e.is_primary) ?? emails?.[0];
      if (primary?.email) {
        email = String(primary.email);
        emailVerified = primary.is_confirmed === true;
      }
    }

    // The workspaces they belong to stand for groups (best effort: a
    // consumer without the permission still signs people in, groupless).
    const groups: string[] = [];
    const wsRes = await fetch(`${this.urls.api}/user/permissions/workspaces?pagelen=100`, {
      headers,
    }).catch(() => null);
    if (wsRes?.ok) {
      const values = ((await wsRes.json()) as { values?: Array<Record<string, any>> }).values;
      for (const v of values ?? []) {
        const slug = v.workspace?.slug;
        if (typeof slug === "string" && slug && !groups.includes(slug)) groups.push(slug);
      }
    }

    const externalId = String(user.uuid ?? user.account_id ?? "");
    if (!externalId) throw new Error("Bitbucket returned no account id");
    return {
      externalId,
      email,
      displayName: user.display_name || user.nickname || user.username || email || externalId,
      username: user.username || user.nickname || undefined,
      avatarUrl: user.links?.avatar?.href,
      emailVerified,
      groups,
    };
  }
}
