export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  /** The OIDC ID token, when the provider sent one (already verified). */
  idToken?: string;
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
   * The provider itself asserted the email (OIDC `email_verified`, a SAML
   * assertion, the LDAP directory's own attribute) — never an administrator's
   * `trustEmail`. Unset: `emailVerified` is the provider's own word (Google,
   * GitHub, GitLab). Linking an account to another by email needs it
   * (services/session-service.ts).
   */
  emailVerifiedByProvider?: boolean;
  /**
   * The account's organization domain when the provider has one (Google
   * Workspace `hd`); null for a consumer account. The allowed-domains check
   * compares it (see services/sign-in-config-service.ts).
   */
  hostedDomain?: string | null;
  /** Provider-asserted group claims. */
  groups?: string[];
  /**
   * True when the provider sent no groups claim at all (as opposed to an
   * empty one); `groups` is then empty and says nothing, so sign-in leaves
   * group memberships and group-granted roles as they were.
   */
  groupsClaimMissing?: boolean;
}

/** What a redirect-based sign-in keeps between the authorize and callback legs. */
export interface OAuthFlowState {
  /** PKCE verifier (S256); the challenge went in the authorize URL. */
  codeVerifier?: string;
  /** OIDC nonce, echoed in the ID token. */
  nonce?: string;
}

export interface OAuthProvider {
  name: string;
  /** Optional async initialization (e.g. OIDC discovery). Called before authorizeUrl(). */
  prepare?(): Promise<void>;
  /** The flow state to keep for `state` (PKCE, nonce); none for providers that need none. */
  beginFlow?(): OAuthFlowState;
  /** The browser authorization URL. */
  authorizeUrl(state: string, flow?: OAuthFlowState): string | Promise<string>;
  exchangeCode(code: string, flow?: OAuthFlowState): Promise<OAuthTokens>;
  /** `tokens`: all the exchange returned, for a provider that reads the ID token too. */
  fetchUser(accessToken: string, tokens?: OAuthTokens): Promise<OAuthUser>;
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
