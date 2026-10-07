export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

export interface OAuthUser {
  externalId: string;
  email: string;
  displayName: string;
  /** The provider's handle (GitHub login, GitLab username), when it has one. */
  username?: string;
  avatarUrl?: string;
  /**
   * The provider vouches that the person controls `email` (Google
   * `verified_email`, OIDC `email_verified`, GitHub's verified primary,
   * GitLab's confirmed email). Joining a workspace by email domain needs it.
   */
  emailVerified?: boolean;
  /**
   * The account's organization domain when the provider has one (Google
   * Workspace `hd`); null for a consumer account. The allowed-domains check
   * compares it (see services/sign-in-config-service.ts).
   */
  hostedDomain?: string | null;
}

export interface OAuthProvider {
  name: string;
  /** Optional async initialization (e.g. OIDC discovery). Called before authorizeUrl(). */
  prepare?(): Promise<void>;
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthTokens>;
  fetchUser(accessToken: string): Promise<OAuthUser>;
}

export function getCallbackUrl(provider: string): string {
  return `${publicApiOrigin()}/api/auth/${provider}/callback`;
}

/**
 * The origin the browser reaches the API at. `PUBLIC_API_URL` when the API has
 * an origin of its own (a NodePort install, an API on a separate host): origin
 * only, the same value the web's `window.__OPTIO_CONFIG.publicApiUrl` carries;
 * a trailing `/api` or `/` is dropped so either spelling works. Otherwise
 * `PUBLIC_URL` (web and API behind one ingress), else the API's own port.
 */
export function publicApiOrigin(): string {
  const own = process.env.PUBLIC_API_URL?.trim();
  if (own) return own.replace(/\/+$/, "").replace(/\/api$/i, "");
  const shared = process.env.PUBLIC_URL?.trim();
  if (shared) return shared.replace(/\/+$/, "");
  return `http://localhost:${process.env.API_PORT ?? 4000}`;
}
