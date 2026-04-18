import type { OAuthProvider } from "./provider.js";
import { GitHubOAuthProvider } from "./github.js";
import { GoogleOAuthProvider } from "./google.js";
import { GitLabOAuthProvider } from "./gitlab.js";
import { GenericOIDCProvider } from "./oidc.js";

const providers: Record<string, OAuthProvider> = {
  github: new GitHubOAuthProvider(),
  google: new GoogleOAuthProvider(),
  gitlab: new GitLabOAuthProvider(),
  oidc: new GenericOIDCProvider(),
};

export function getOAuthProvider(name: string): OAuthProvider | undefined {
  return providers[name];
}

export interface EnabledProvider {
  name: string;
  displayName: string;
}

/** Returns providers that have their client ID configured. */
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
  return result;
}

export function isAuthDisabled(): boolean {
  return process.env.OPTIO_AUTH_DISABLED === "true";
}

export { type OAuthProvider } from "./provider.js";
