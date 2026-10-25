import type { PublicSignInProvider } from "@optio/shared";
import type { OAuthProvider } from "./provider.js";
import { GitHubOAuthProvider } from "./github.js";
import { GoogleOAuthProvider } from "./google.js";
import { GitLabOAuthProvider } from "./gitlab.js";
import { GenericOIDCProvider } from "./oidc.js";
import { BitbucketOAuthProvider } from "./bitbucket.js";
import { createGiteaProvider } from "./gitea.js";
import { SamlProvider, resetSamlMetadataCache } from "./saml.js";

/**
 * The redirect-based sign-in providers (`GET /api/auth/:provider/login` →
 * callback). LDAP is a password form and goes through
 * `POST /api/auth/ldap/login` instead; SAML's identity provider answers with
 * a POST to `/api/auth/saml/callback` (routes/auth.ts).
 */
const providers: Record<string, OAuthProvider> = {
  github: new GitHubOAuthProvider(),
  google: new GoogleOAuthProvider(),
  gitlab: new GitLabOAuthProvider(),
  oidc: new GenericOIDCProvider(),
  bitbucket: new BitbucketOAuthProvider(),
  gitea: createGiteaProvider(),
  saml: new SamlProvider(),
};

export function getOAuthProvider(name: string): OAuthProvider | undefined {
  return providers[name];
}

/** The SAML provider (its callback is a POST of its own). */
export function getSamlProvider(): SamlProvider {
  return providers.saml as SamlProvider;
}

/** Forget cached OIDC discovery and SAML metadata after the sign-in settings changed. */
export function resetOAuthProviders(): void {
  (providers.oidc as GenericOIDCProvider).reset();
  (providers.gitea as GenericOIDCProvider).reset();
  resetSamlMetadataCache();
}

export interface EnabledProvider {
  name: string;
  displayName: string;
  /** "redirect" (a button to the provider) or "password" (LDAP: a form on the login page). */
  method?: PublicSignInProvider["method"];
  /** LDAP: the label above the username field. */
  usernameLabel?: string | null;
}

/**
 * The providers people can sign in with: configured in the app (Settings →
 * Sign-in) or by environment variables. What `GET /api/auth/providers` lists.
 */
export async function listEnabledProviders(): Promise<EnabledProvider[]> {
  const { listSignInProviders } = await import("../sign-in-config-service.js");
  const views = await listSignInProviders();
  const out: EnabledProvider[] = [];
  for (const name of [
    "github",
    "google",
    "gitlab",
    "oidc",
    "ldap",
    "bitbucket",
    "gitea",
    "saml",
  ] as const) {
    const view = views.find((v) => v.provider === name);
    if (!view?.enabled) continue;
    if (name === "ldap") {
      const settings = view.settings as { usernameLabel?: string | null } | null;
      out.push({
        name,
        displayName: view.displayName,
        method: "password",
        usernameLabel: settings?.usernameLabel ?? null,
      });
    } else {
      out.push({ name, displayName: view.displayName, method: "redirect" });
    }
  }
  return out;
}

/** Returns providers that have their client ID configured by the environment alone. */
export function getEnabledProviders(): EnabledProvider[] {
  const result: EnabledProvider[] = [];
  if (process.env.GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_APP_CLIENT_ID) {
    result.push({ name: "github", displayName: "GitHub" });
  }
  if (process.env.GOOGLE_OAUTH_CLIENT_ID) {
    result.push({ name: "google", displayName: "Google" });
  }
  if (process.env.GITLAB_OAUTH_CLIENT_ID) {
    result.push({ name: "gitlab", displayName: "GitLab" });
  }
  if (process.env.OIDC_ISSUER_URL) {
    result.push({
      name: "oidc",
      displayName: process.env.OIDC_DISPLAY_NAME || "SSO",
    });
  }
  if (process.env.BITBUCKET_OAUTH_CLIENT_ID) {
    result.push({ name: "bitbucket", displayName: "Bitbucket" });
  }
  if (process.env.GITEA_OAUTH_CLIENT_ID && process.env.GITEA_OAUTH_BASE_URL) {
    result.push({ name: "gitea", displayName: process.env.GITEA_DISPLAY_NAME || "Gitea" });
  }
  if (
    process.env.SAML_METADATA_URL ||
    process.env.SAML_METADATA_XML ||
    process.env.SAML_ENTRY_POINT
  ) {
    result.push({ name: "saml", displayName: process.env.SAML_DISPLAY_NAME || "SSO" });
  }
  return result;
}

export function isAuthDisabled(): boolean {
  return process.env.OPTIO_AUTH_DISABLED === "true";
}

export { type OAuthProvider } from "./provider.js";
