/** The providers present in this sign-in stack. */
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
  saml: "SSO (SAML 2.0)",
  gitea: "Gitea / Forgejo",
  bitbucket: "Bitbucket",
};

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
  /** Link only a unique, provider-verified email; disabled by default. */
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
   * claim (default false). An explicit
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

export interface SignInProviderTestResult {
  /** SAML: what the metadata (or the settings) say about the identity provider. */
  saml?: {
    entityId: string | null;
    entryPoint: string | null;
    /** The signing certificates: subject and expiry, never the key. */
    certificates: Array<{ subject: string; notAfter: string; fingerprint256: string }>;
  };

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

export interface PublicSignInProvider {
  name: "google" | "github" | "gitlab" | "oidc" | "saml" | "gitea" | "bitbucket" | "ldap";
  displayName: string;
  /** "redirect": a button that sends the browser to the provider; "password": a form on the login page. */
  method: "redirect" | "password";
  /** LDAP: the label above the username field. */
  usernameLabel?: string | null;
}

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
  OidcSettings | SamlSettings | GiteaSettings | BitbucketSettings | LdapSignInSettings;
