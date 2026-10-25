import type { GiteaSettings, OidcSettings } from "@optio/shared";
import { GenericOIDCProvider, type OidcClientConfig } from "./oidc.js";

/**
 * Sign-in with an account on a self-hosted **Gitea** or **Forgejo** server.
 * Its OAuth2 applications are OpenID Connect providers (discovery at
 * `<server>/.well-known/openid-configuration`, ID tokens signed with the
 * server's key), so this is the OIDC client (`GenericOIDCProvider`) under the
 * name `gitea`: authorization code with PKCE and a nonce, the ID token
 * verified against the server's JWKS, and the `groups` claim — the person's
 * organizations and `org:team` pairs — for required and admin groups.
 *
 * Configured in the app (Settings → Sign-in → Gitea / Forgejo) or by
 * `GITEA_OAUTH_CLIENT_ID`, `GITEA_OAUTH_CLIENT_SECRET` and
 * `GITEA_OAUTH_BASE_URL`. The redirect URI to register on the server is
 * `<API origin>/api/auth/gitea/callback`.
 */

/** The OIDC settings a Gitea / Forgejo server signs in with. */
export function giteaOidcSettings(settings: GiteaSettings): OidcSettings {
  return {
    issuerUrl: settings.baseUrl.trim().replace(/\/+$/, ""),
    scopes: settings.scopes?.trim() || "openid profile email groups",
    groupsClaim: "groups",
    usernameClaim: "preferred_username",
    // Gitea says whether the address is confirmed (`email_verified`).
    trustEmail: false,
    usePkce: true,
    caPem: settings.caPem,
    insecureSkipVerify: settings.insecureSkipVerify,
  };
}

async function loadGiteaConfig(): Promise<OidcClientConfig | null> {
  const { resolveProviderConfig } = await import("../sign-in-config-service.js");
  const resolved = await resolveProviderConfig("gitea");
  if (!resolved?.settings) return null;
  return {
    clientId: resolved.clientId,
    clientSecret: resolved.clientSecret,
    settings: giteaOidcSettings(resolved.settings as GiteaSettings),
    source: resolved.source,
    sendNonce: true,
  };
}

/** The `gitea` provider: the OIDC client against the configured server. */
export function createGiteaProvider(
  loadConfig: () => Promise<OidcClientConfig | null> = loadGiteaConfig,
): GenericOIDCProvider {
  return new GenericOIDCProvider(loadConfig, "gitea");
}
