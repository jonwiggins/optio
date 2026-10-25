import { SIGN_IN_PROVIDER_LABEL, type GiteaSettings, type SamlSettings } from "@optio/shared";
import type { ResolvedProviderConfig, SignInProviderName } from "./sign-in-config-service.js";

// The sign-in providers the environment configures (Helm `auth.*`). Apart
// from the stored settings (sign-in-config-service.ts) so the OIDC provider
// can read it without loading the database client.

function envList(name: string): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * A provider configured by environment variables (Helm `auth.*`), for
 * deployments that keep sign-in in their values file.
 *
 * The environment's OIDC signs in the way it always has unless told
 * otherwise: the email counts as verified only when the provider says so,
 * no PKCE, nobody is added to the organization workspace, and no existing
 * account is taken over by email (`OIDC_TRUST_EMAIL`, `OIDC_USE_PKCE`,
 * `OIDC_AUTO_JOIN_ORGANIZATION`, `OIDC_LINK_BY_EMAIL`; for LDAP,
 * `LDAP_LINK_BY_EMAIL`).
 */
export function envConfig(
  provider: SignInProviderName,
): Omit<ResolvedProviderConfig, "source" | "allowedDomains"> | null {
  const env = process.env;
  switch (provider) {
    case "google":
      return env.GOOGLE_OAUTH_CLIENT_ID
        ? {
            clientId: env.GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
          }
        : null;
    case "github":
      return env.GITHUB_OAUTH_CLIENT_ID || env.GITHUB_APP_CLIENT_ID
        ? {
            clientId: (env.GITHUB_OAUTH_CLIENT_ID ?? env.GITHUB_APP_CLIENT_ID)!,
            clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET ?? env.GITHUB_APP_CLIENT_SECRET ?? "",
          }
        : null;
    case "gitlab":
      return env.GITLAB_OAUTH_CLIENT_ID
        ? {
            clientId: env.GITLAB_OAUTH_CLIENT_ID,
            clientSecret: env.GITLAB_OAUTH_CLIENT_SECRET ?? "",
          }
        : null;
    case "oidc":
      if (!env.OIDC_ISSUER_URL) return null;
      return {
        clientId: env.OIDC_CLIENT_ID ?? "",
        clientSecret: env.OIDC_CLIENT_SECRET ?? "",
        displayName: env.OIDC_DISPLAY_NAME || "SSO",
        settings: {
          issuerUrl: env.OIDC_ISSUER_URL,
          scopes: env.OIDC_SCOPES || "openid email profile",
          groupsClaim: env.OIDC_GROUPS_CLAIM || undefined,
          emailClaim: env.OIDC_EMAIL_CLAIM || undefined,
          nameClaim: env.OIDC_NAME_CLAIM || undefined,
          usernameClaim: env.OIDC_USERNAME_CLAIM || undefined,
          adminGroups: envList("OIDC_ADMIN_GROUPS"),
          requiredGroups: envList("OIDC_REQUIRED_GROUPS"),
          trustEmail: envBool("OIDC_TRUST_EMAIL") ?? false,
          usePkce: envBool("OIDC_USE_PKCE") ?? false,
          caPem: env.OIDC_CA_PEM || undefined,
          autoJoinOrganization: envBool("OIDC_AUTO_JOIN_ORGANIZATION") ?? false,
          linkByEmail: envBool("OIDC_LINK_BY_EMAIL") ?? false,
        },
      };
    case "bitbucket":
      return env.BITBUCKET_OAUTH_CLIENT_ID
        ? {
            clientId: env.BITBUCKET_OAUTH_CLIENT_ID,
            clientSecret: env.BITBUCKET_OAUTH_CLIENT_SECRET ?? "",
            displayName: SIGN_IN_PROVIDER_LABEL.bitbucket,
            settings: {
              adminGroups: envList("BITBUCKET_ADMIN_GROUPS"),
              requiredGroups: envList("BITBUCKET_REQUIRED_GROUPS"),
            },
          }
        : null;
    case "gitea":
      if (!env.GITEA_OAUTH_CLIENT_ID || !env.GITEA_OAUTH_BASE_URL) return null;
      return {
        clientId: env.GITEA_OAUTH_CLIENT_ID,
        clientSecret: env.GITEA_OAUTH_CLIENT_SECRET ?? "",
        displayName: env.GITEA_DISPLAY_NAME || SIGN_IN_PROVIDER_LABEL.gitea,
        settings: {
          baseUrl: env.GITEA_OAUTH_BASE_URL,
          scopes: env.GITEA_OAUTH_SCOPES || undefined,
          caPem: env.GITEA_CA_PEM || undefined,
          adminGroups: envList("GITEA_ADMIN_GROUPS"),
          requiredGroups: envList("GITEA_REQUIRED_GROUPS"),
        } satisfies GiteaSettings,
      };
    case "saml":
      if (!env.SAML_METADATA_URL && !env.SAML_METADATA_XML && !env.SAML_ENTRY_POINT) return null;
      return {
        clientId: "",
        clientSecret: "",
        displayName: env.SAML_DISPLAY_NAME || "SSO",
        settings: {
          metadataUrl: env.SAML_METADATA_URL || undefined,
          metadataXml: env.SAML_METADATA_XML || undefined,
          entryPoint: env.SAML_ENTRY_POINT || undefined,
          idpEntityId: env.SAML_IDP_ENTITY_ID || undefined,
          idpCert: env.SAML_IDP_CERT || undefined,
          spEntityId: env.SAML_SP_ENTITY_ID || undefined,
          emailAttribute: env.SAML_EMAIL_ATTRIBUTE || undefined,
          nameAttribute: env.SAML_NAME_ATTRIBUTE || undefined,
          usernameAttribute: env.SAML_USERNAME_ATTRIBUTE || undefined,
          idAttribute: env.SAML_ID_ATTRIBUTE || undefined,
          wantAuthnResponseSigned: envBool("SAML_WANT_AUTHN_RESPONSE_SIGNED") ?? false,
          groupsAttribute: env.SAML_GROUPS_ATTRIBUTE || undefined,
          caPem: env.SAML_CA_PEM || undefined,
          adminGroups: envList("SAML_ADMIN_GROUPS"),
          requiredGroups: envList("SAML_REQUIRED_GROUPS"),
          autoJoinOrganization: envBool("SAML_AUTO_JOIN_ORGANIZATION") ?? false,
        } satisfies SamlSettings,
      };
    case "ldap":
      break;
  }
  if (!env.LDAP_URL) return null;
  return {
    clientId: "",
    clientSecret: env.LDAP_BIND_PASSWORD ?? "",
    displayName: env.LDAP_DISPLAY_NAME || "Corporate account",
    settings: {
      url: env.LDAP_URL,
      startTls: envBool("LDAP_START_TLS"),
      caPem: env.LDAP_CA_PEM || undefined,
      bindDn: env.LDAP_BIND_DN || undefined,
      userBaseDn: env.LDAP_USER_BASE_DN ?? "",
      userFilter: env.LDAP_USER_FILTER || undefined,
      usernameAttribute: env.LDAP_USERNAME_ATTRIBUTE || undefined,
      emailAttribute: env.LDAP_EMAIL_ATTRIBUTE || undefined,
      displayNameAttribute: env.LDAP_DISPLAY_NAME_ATTRIBUTE || undefined,
      groupMode: env.LDAP_GROUP_MODE === "search" ? "search" : undefined,
      groupBaseDn: env.LDAP_GROUP_BASE_DN || undefined,
      groupFilter: env.LDAP_GROUP_FILTER || undefined,
      adminGroups: envList("LDAP_ADMIN_GROUPS"),
      requiredGroups: envList("LDAP_REQUIRED_GROUPS"),
      autoJoinOrganization: envBool("LDAP_AUTO_JOIN_ORGANIZATION") ?? false,
      linkByEmail: envBool("LDAP_LINK_BY_EMAIL") ?? false,
    },
  };
}
