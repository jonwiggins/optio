/**
 * How people sign in to an Optio deployment: the providers an administrator
 * can configure from the setup wizard and Settings → Sign-in (or the
 * environment), and what the API says about them. See docs/sign-in.md.
 *
 * - **github**, **gitlab**, **google** — sign-in with an account on those
 *   services (OAuth). Google can be configured in the app; GitHub and GitLab
 *   by environment variables.
 * - **oidc** — OpenID Connect against the organization's own SSO (presets for
 *   ADFS, Auth0, Authelia, Authentik, Keycloak, Microsoft Entra ID, Okta,
 *   Zitadel; anything standard works as generic OIDC).
 * - **ldap** — a username + password form checked against LDAP or Active
 *   Directory.
 * - **saml** — SAML 2.0 single sign-on (SP-initiated; signed assertions
 *   verified with the identity provider's certificate).
 * - **bitbucket** — sign-in with a Bitbucket Cloud account (OAuth).
 * - **gitea** — sign-in with an account on a self-hosted Gitea or Forgejo.
 *
 * Every provider is off until an administrator configures it.
 */

export const SIGN_IN_PROVIDERS = [
  "bitbucket",
  "gitea",
  "github",
  "gitlab",
  "google",
  "ldap",
  "oidc",
  "saml",
] as const;
export type SignInProviderName = (typeof SIGN_IN_PROVIDERS)[number];

export const SIGN_IN_PROVIDER_LABEL: Record<SignInProviderName, string> = {
  google: "Google",
  github: "GitHub",
  gitlab: "GitLab",
  oidc: "SSO (OpenID Connect)",
  ldap: "LDAP / Active Directory",
  bitbucket: "Bitbucket",
  gitea: "Gitea / Forgejo",
  saml: "SSO (SAML 2.0)",
};

/** Presets fill in sensible defaults (scopes, the groups claim) for well-known servers. */
export const OIDC_PRESETS = [
  "adfs",
  "auth0",
  "authelia",
  "authentik",
  "generic",
  "keycloak",
  "entra",
  "okta",
  "zitadel",
] as const;
export type OidcPreset = (typeof OIDC_PRESETS)[number];

export const OIDC_PRESET_LABEL: Record<OidcPreset, string> = {
  generic: "Generic OpenID Connect",
  keycloak: "Keycloak",
  authentik: "Authentik",
  adfs: "ADFS (Windows Server)",
  entra: "Microsoft Entra ID",
  okta: "Okta",
  zitadel: "Zitadel",
  authelia: "Authelia",
  auth0: "Auth0",
};

/**
 * The issuer URL each preset expects, with the parts to fill in braced
 * (`{tenant-id}`): what the settings form offers as the issuer's placeholder.
 */
export const OIDC_PRESET_ISSUER_TEMPLATE: Record<OidcPreset, string> = {
  generic: "https://sso.example.com",
  keycloak: "https://keycloak.example.com/realms/{realm}",
  authentik: "https://authentik.example.com/application/o/{application-slug}/",
  adfs: "https://adfs.example.com/adfs",
  entra: "https://login.microsoftonline.com/{tenant-id}/v2.0",
  okta: "https://{your-org}.okta.com/oauth2/default",
  zitadel: "https://{instance}.zitadel.cloud",
  authelia: "https://auth.example.com",
  auth0: "https://{tenant}.{region}.auth0.com/",
};

/** What every provider shares: who gets in, and what they become. */
export interface SignInAccessSettings {
  /**
   * Groups (as the provider names them) whose members become deployment
   * admins and admins of the organization workspace. Empty: only the
   * person who completed setup, and whoever they add.
   */
  adminGroups?: string[];
  /** Only members of one of these groups may sign in. Empty: everyone the provider knows. */
  requiredGroups?: string[];
  /**
   * Everyone who signs in joins the organization workspace (default off:
   * each person gets a workspace of their own, as without this setting).
   */
  autoJoinOrganization?: boolean;
  /** The workspace role people get when they auto-join (default member). */
  defaultRole?: "member" | "viewer";
  /**
   * A first sign-in whose verified email matches exactly one existing
   * account signs in to that account, which moves to this provider (default
   * off). Only for a provider whose people can't change their own email.
   */
  linkByEmail?: boolean;
}

export interface OidcSettings extends SignInAccessSettings {
  preset?: OidcPreset;
  /** The issuer: `<issuerUrl>/.well-known/openid-configuration` must exist. */
  issuerUrl: string;
  /** Space-separated; default "openid profile email" plus the preset's groups scope. */
  scopes?: string;
  /** The claim that carries the person's groups (default "groups"). */
  groupsClaim?: string;
  /** Claims used for the account (defaults: email, name, preferred_username). */
  emailClaim?: string;
  nameClaim?: string;
  usernameClaim?: string;
  /**
   * Treat the email as verified when the provider sends no `email_verified`
   * claim (most self-hosted providers don't; default true when set up in the
   * app, false for the environment's `OIDC_TRUST_EMAIL`). An explicit
   * `email_verified: false` is never overridden, and it never links an
   * account to another by email.
   */
  trustEmail?: boolean;
  /**
   * PKCE (S256) on the authorization request (default true when set up in
   * the app; the environment's OIDC uses it with `OIDC_USE_PKCE=true`).
   */
  usePkce?: boolean;
  /** How the client secret is sent to the token endpoint (default post). */
  tokenAuthMethod?: "client_secret_post" | "client_secret_basic";
  /** PEM bundle of the CA that signed the provider's certificate, when it's a private one. */
  caPem?: string | null;
  /** Skip certificate verification (test labs only). */
  insecureSkipVerify?: boolean;
}

export interface LdapSignInSettings extends SignInAccessSettings {
  /** ldap:// or ldaps:// URL, e.g. ldaps://ad.example.com:636 */
  url: string;
  /** Upgrade a plain ldap:// connection with STARTTLS before binding. */
  startTls?: boolean;
  caPem?: string | null;
  insecureSkipVerify?: boolean;
  /** Service account for the search bind; empty = anonymous bind. Its password is stored sealed. */
  bindDn?: string | null;
  /** Where users live, e.g. OU=People,DC=example,DC=com */
  userBaseDn: string;
  /** Filter with a {{username}} placeholder. Default matches sAMAccountName, uid or mail. */
  userFilter?: string | null;
  usernameAttribute?: string | null;
  emailAttribute?: string | null;
  displayNameAttribute?: string | null;
  /** "memberOf" (the attribute on the user, default) or "search" (a group search). */
  groupMode?: "memberOf" | "search";
  groupBaseDn?: string | null;
  /** For groupMode "search": filter with {{dn}} / {{username}} placeholders. */
  groupFilter?: string | null;
  /** Shown above the username field ("Corporate account"). */
  usernameLabel?: string | null;
}

/**
 * SAML 2.0 (SP-initiated, HTTP-Redirect to the identity provider, HTTP-POST
 * back to `/api/auth/saml/callback`). The identity provider is described by
 * its metadata (a URL, re-read daily, or the XML pasted in) or by hand: its
 * single sign-on URL, entity ID and signing certificate. The assertion must
 * be signed with that certificate.
 */
export interface SamlSettings extends SignInAccessSettings {
  /** The identity provider's metadata URL (entry point, entity ID, certificates). */
  metadataUrl?: string | null;
  /** Or its metadata XML, pasted in. */
  metadataXml?: string | null;
  /** The single sign-on URL (HTTP-Redirect binding); from the metadata when empty. */
  entryPoint?: string | null;
  /** The identity provider's entity ID (the response's Issuer, checked); from the metadata when empty. */
  idpEntityId?: string | null;
  /** PEM certificate(s) the identity provider signs with; from the metadata when empty. */
  idpCert?: string | null;
  /** Optio's entity ID, the audience (default `<API origin>/api/auth/saml/metadata`). */
  spEntityId?: string | null;
  /** The NameID format to ask for (default: none, the identity provider picks). */
  nameIdFormat?: string | null;
  /** The attribute holding a stable ID (default: the NameID). */
  idAttribute?: string | null;
  /** Attribute names; empty: the common names (email, mail, the WS-Fed claim URIs, the OIDs). */
  emailAttribute?: string | null;
  nameAttribute?: string | null;
  usernameAttribute?: string | null;
  groupsAttribute?: string | null;
  /** Require the whole response to be signed too (default false: the assertion must be). */
  wantAuthnResponseSigned?: boolean;
  /** Require the assertion to be signed (default true). */
  wantAssertionsSigned?: true;
  /** PEM bundle of the CA behind the metadata URL's certificate. */
  caPem?: string | null;
  insecureSkipVerify?: boolean;
}

/** A self-hosted Gitea or Forgejo: an OAuth2 application on it (OpenID Connect underneath). */
export interface GiteaSettings extends SignInAccessSettings {
  /** The server's URL, e.g. https://git.example.com */
  baseUrl: string;
  /** Space-separated; default "openid profile email groups". */
  scopes?: string;
  /** PEM bundle of the CA behind the server's certificate. */
  caPem?: string | null;
  insecureSkipVerify?: boolean;
}

/**
 * Bitbucket Cloud (an OAuth consumer). The person's groups are the
 * workspaces they belong to (their slugs), for required and admin groups.
 */
export type BitbucketSettings = SignInAccessSettings;

/** Any provider's settings beyond its client ID and secret. */
export type AnySignInSettings =
  | OidcSettings
  | LdapSignInSettings
  | SamlSettings
  | GiteaSettings
  | BitbucketSettings;

export type SignInProviderSettings =
  | { provider: "oidc"; settings: OidcSettings }
  | { provider: "ldap"; settings: LdapSignInSettings }
  | { provider: "saml"; settings: SamlSettings }
  | { provider: "gitea"; settings: GiteaSettings }
  | { provider: "bitbucket"; settings: BitbucketSettings };

/** What the Sign-in page shows for one provider (never a secret). */
export interface SignInProviderView {
  provider: SignInProviderName;
  displayName: string;
  /** Can be edited in the app (all but GitHub and GitLab, which come from the environment). */
  configurable: boolean;
  enabled: boolean;
  source: "database" | "environment" | "none";
  /** The OAuth / OIDC client id (none for LDAP and SAML). */
  clientId: string | null;
  /** A client secret is stored; LDAP: a bind password is stored. */
  hasClientSecret: boolean;
  /** Email domains allowed to sign in (empty: any). */
  allowedDomains: string[];
  /** The provider's settings (null for Google, GitHub and GitLab). */
  settings: AnySignInSettings | null;
  /** The redirect URI to register with the provider (SAML: the ACS URL; none for LDAP). */
  callbackUrl: string | null;
  /** SAML: Optio's service-provider metadata URL, for the identity provider. */
  metadataUrl?: string | null;
  updatedAt: string | null;
}

/** `PUT /api/auth/sign-in/:provider` body. */
export interface SaveSignInProviderInput {
  /** OAuth / OIDC client id (ignored for LDAP and SAML). */
  clientId?: string;
  /** Client secret / LDAP bind password: replaces the stored one; absent keeps it. */
  clientSecret?: string | null;
  allowedDomains?: string[];
  enabled?: boolean;
  displayName?: string | null;
  settings?: AnySignInSettings;
  /** Bootstrap only: the organization's name (the first signer-in's workspace takes it). */
  organizationName?: string;
}

/** `POST /api/auth/sign-in/:provider/test` result. */
export interface SignInProviderTestResult {
  ok: boolean;
  error?: string;
  /** OIDC: what discovery found. */
  oidc?: {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userinfoEndpoint: string | null;
    jwksUri: string;
    scopesSupported: string[];
    claimsSupported: string[];
    /** Whether the configured groups claim is advertised (null when the server lists no claims). */
    groupsClaimAdvertised: boolean | null;
    pkceSupported: boolean | null;
  };
  /** SAML: what the metadata (or the settings) say about the identity provider. */
  saml?: {
    entityId: string | null;
    entryPoint: string | null;
    /** The signing certificates: subject and expiry, never the key. */
    certificates: Array<{ subject: string; notAfter: string; fingerprint256: string }>;
  };
  /** LDAP: what a bind and a sample search found. */
  ldap?: {
    boundAs?: string;
    serverInfo?: { vendor?: string; namingContexts?: string[] };
    sample?: {
      dn: string;
      username: string;
      email: string;
      displayName: string;
      groups: string[];
    } | null;
  };
}

/** `GET /api/auth/providers`: how the login page lets people in. */
export interface PublicSignInProvider {
  name: SignInProviderName;
  displayName: string;
  /** "redirect": a button that sends the browser to the provider; "password": a form on the login page. */
  method: "redirect" | "password";
  /** LDAP: the label above the username field. */
  usernameLabel?: string | null;
}
