export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

export interface OAuthUser {
  externalId: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
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
  const base = process.env.PUBLIC_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
  return `${base}/api/auth/${provider}/callback`;
}
