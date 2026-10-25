# Sign-in options

Configure providers independently in **Settings → Access → Sign-in** or in
its setup wizard. Bitbucket Cloud, Gitea / Forgejo, GitHub, GitLab, Google,
LDAP / Active Directory, OpenID Connect and SAML 2.0 can be enabled together.
Every additional provider is off until configured. Existing Google, GitHub,
GitLab and environment-configured OIDC clients continue to work.

`GET /api/auth/providers` lists enabled providers. The login page shows each
one, with a password form for LDAP and a redirect button for the others.
`optio login --server https://optio.example.com --list-providers` lists the
same choices; select one with `--provider <name>`. Redirect providers use the
CLI's browser and PKCE loopback flow; LDAP prompts for a username and hidden
password and issues a personal access token.

## Bitbucket Cloud (`bitbucket`)

Create an OAuth consumer in Bitbucket's workspace settings. Register the
callback URL displayed by Optio (`<origin>/api/auth/bitbucket/callback`) and
grant Account, Email and Workspace membership read permissions. Save its
client ID and secret in Optio, or set `BITBUCKET_OAUTH_CLIENT_ID` and
`BITBUCKET_OAUTH_CLIENT_SECRET`.

The account's stable identity is its Bitbucket UUID. Only a confirmed primary
email counts as verified. Workspace slugs act as groups for the access rules.

## Gitea / Forgejo (`gitea`)

Register an OAuth2 application on your server with callback
`<origin>/api/auth/gitea/callback`. Save its server URL (including any path
prefix), client ID and secret in Optio. For Forgejo, set the button label to
“Forgejo”. Environment equivalents are `GITEA_OAUTH_BASE_URL`,
`GITEA_OAUTH_CLIENT_ID`, `GITEA_OAUTH_CLIENT_SECRET`, `GITEA_DISPLAY_NAME`,
`GITEA_OAUTH_SCOPES` and `GITEA_CA_PEM`.

The client uses the server's OpenID Connect discovery, PKCE S256, a nonce,
and JWKS verification. Default scopes are `openid profile email groups`;
organizations and teams in the `groups` claim feed the common group rules.
Set a private CA certificate when the server needs one.

See the [Gitea OAuth2 provider documentation](https://docs.gitea.com/development/oauth2-provider/)
for scopes supported by your version and their resource access implications.

## GitHub (`github`)

Set `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`, or use the
GitHub App's `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`. Register
`<origin>/api/auth/github/callback`. A GitHub App sign-in keeps its user access
and refresh tokens for git operations. Configuration remains environment-based.

## GitLab (`gitlab`)

Set `GITLAB_OAUTH_CLIENT_ID` and `GITLAB_OAUTH_CLIENT_SECRET`. For a
self-managed instance, also set `GITLAB_OAUTH_BASE_URL` (default
`https://gitlab.com`). Register `<origin>/api/auth/gitlab/callback`.
Configuration remains environment-based. GitLab may alternatively be used
through the generic OIDC slot when its OIDC claims are needed.

**Use my GitLab account for my work** is the GitLab counterpart, off by
default: with `GITLAB_OAUTH_STORE_USER_TOKEN=true` (chart
`auth.gitlab.storeUserToken`) GitLab sign-in also asks for the `api` scope
and keeps each person's access and refresh tokens (GitLab's last two hours)
as their own secrets, refreshed five minutes before they expire, one
instance at a time. That person's work on the GitLab sign-in uses
(`GITLAB_OAUTH_BASE_URL`) then runs with it: after a GitLab token they saved
themselves (Settings → My tokens) and before the organization's; a team's
work still uses the team's token. When GitLab refuses the refresh token
(revoked, expired), the stored tokens are dropped and the next sign-in
stores new ones. Off, sign-in asks for `read_user` only and keeps nothing.

## Google (`google`)

Create a Web application OAuth client in Google Cloud Console, registering
`<origin>/api/auth/google/callback`. Save the client ID, secret and allowed
Google Workspace domains in Optio, or set `GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET`. Allowed domains check both the verified address
and the account's Google Workspace `hd` claim; public mail domains cannot be
used as an organization restriction. With no allowed domains, any Google
account may sign in.

## LDAP / Active Directory (`ldap`)

Save the directory URL (`ldap://` or `ldaps://`), user base DN and search-bind
DN/password. An empty bind DN uses an anonymous search. A login searches as
the service account, then binds **as the user** to verify the password.
Choose LDAPS or STARTTLS and configure a private CA when needed. Test can
bind and look up a sample username without saving the settings.

The default user filter is
`(|(sAMAccountName={{username}})(uid={{username}})(mail={{username}}))`.
Values substituted into filters are escaped. Customize the username, email
and display-name attributes as needed. The stable ID is `objectGUID` (AD),
then `entryUUID`, then the DN. A directory-supplied email counts as verified.

Groups come from `memberOf`, or a group search with base DN and filter
(default `(|(member={{dn}})(uniqueMember={{dn}})(memberUid={{username}}))`).
Both full group DNs and their CNs are available to the rules below.
Environment configuration uses `LDAP_URL`, `LDAP_USER_BASE_DN`,
`LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`, `LDAP_START_TLS`, `LDAP_CA_PEM`,
`LDAP_USER_FILTER`, `LDAP_USERNAME_ATTRIBUTE`, `LDAP_EMAIL_ATTRIBUTE`,
`LDAP_DISPLAY_NAME_ATTRIBUTE`, `LDAP_GROUP_MODE`, `LDAP_GROUP_BASE_DN`,
`LDAP_GROUP_FILTER`, `LDAP_ADMIN_GROUPS`, `LDAP_REQUIRED_GROUPS` and
`LDAP_DISPLAY_NAME`. The username field's label is set in the app.

`POST /api/auth/ldap/login` takes `{ username, password }` and returns a
one-time browser auth code; `cli: true` returns a personal access token.
Wrong credentials receive the same 401 response. Operations time out after
10 seconds. For ongoing access checks, enable [LDAP directory sync](directory-sync.md).

## OpenID Connect (`oidc`)

One OIDC client slot supports these presets; explicit scopes and claim names
always override a preset. The issuer placeholders are shown in the form.

| Preset                 | Issuer template                                                   | Scopes / groups claim                                                                         |
| ---------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ADFS                   | `https://adfs.example.com/adfs`                                   | `openid profile email allatclaims`; `groups` from an issuance rule                            |
| Auth0                  | `https://{tenant}.{region}.auth0.com/`                            | `openid profile email`; a post-login Action supplies `groups` (or a namespaced claim)         |
| Authelia               | `https://auth.example.com`                                        | `openid profile email groups`; `groups`                                                       |
| Authentik              | `https://authentik.example.com/application/o/{application-slug}/` | `openid profile email`; `groups`                                                              |
| Generic OpenID Connect | `https://sso.example.com`                                         | `openid profile email`; `groups`                                                              |
| Keycloak               | `https://keycloak.example.com/realms/{realm}`                     | `openid profile email`; `groups` from a Group Membership mapper                               |
| Microsoft Entra ID     | `https://login.microsoftonline.com/{tenant-id}/v2.0`              | `openid profile email`; `groups` enabled in Token configuration (usually group object IDs)    |
| Okta                   | `https://{your-org}.okta.com/oauth2/default`                      | `openid profile email groups`; configure a groups claim on the authorization server           |
| Zitadel                | `https://{instance}.zitadel.cloud`                                | `openid profile email urn:zitadel:iam:org:project:roles`; `urn:zitadel:iam:org:project:roles` |

Set the issuer URL, client ID and secret, and register
`<origin>/api/auth/oidc/callback`. Default account claims are `email`, `name`
and `preferred_username`. A dotted groups path such as `realm_access.roles`
works. Discovery is cached for 24 hours; saving settings invalidates it.
Test displays discovered endpoints and advertised claims/scopes before saving.

App-configured clients use PKCE S256 and a nonce by default. ID tokens are
verified against JWKS with issuer, audience and nonce checks; userinfo must
identify the same subject. The private CA applies to discovery, JWKS, token
and userinfo requests. Token authentication supports `client_secret_post`
and `client_secret_basic`.

Environment clients retain their existing flow: `OIDC_ISSUER_URL`,
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_DISPLAY_NAME`, `OIDC_SCOPES`,
`OIDC_GROUPS_CLAIM`, `OIDC_EMAIL_CLAIM`, `OIDC_NAME_CLAIM`,
`OIDC_USERNAME_CLAIM`, `OIDC_CA_PEM`; PKCE is enabled with `OIDC_USE_PKCE=true`.
Move the client into the app to use nonce enforcement. `trustEmail` and
`OIDC_TRUST_EMAIL` default to **false**. Opting in treats an unverified address
as verified for domain rules, but never authorizes cross-provider linking.

## SAML 2.0 (`saml`)

Configure the identity provider's **metadata URL** or paste its **metadata
XML**. Alternatively enter its single sign-on URL (HTTP-Redirect), entity ID
and signing certificate (PEM). Explicit fields override metadata. URL metadata
is cached for 24 hours; Test and Save fetch it afresh. A private CA is supported.

Give your IdP Optio's service-provider metadata at
`<origin>/api/auth/saml/metadata`. It contains the SP entity ID (default: that
metadata URL) and the assertion consumer service (ACS):
`<origin>/api/auth/saml/callback`. The IdP sends an HTTP-POST `SAMLResponse`
and echoes `RelayState`. Initiate sign-in from Optio; unsolicited IdP-initiated
responses are refused.

Assertions **must be signed** with the configured IdP certificate. Optio uses
`@node-saml/node-saml` to verify signatures, audience, validity and request
correlation; it also checks the signed assertion's issuer and callback
recipient. Requests expire after 10 minutes, permit 60 seconds of clock skew,
and cannot be replayed. Optionally require the entire response to be signed.

Map the **email**, **name**, **username**, **groups** and **stable ID**
attributes. Defaults accept common attribute names, LDAP OIDs and Microsoft
claim URIs. The default stable ID is NameID; for a transient NameID, email
is the fallback. Prefer a persistent NameID or a configured stable ID attribute
so changing a person's email does not create a new account. Signed email
attributes count as verified. Groups feed the same rules as OIDC and LDAP.

Environment configuration: `SAML_METADATA_URL` or `SAML_METADATA_XML`,
`SAML_ENTRY_POINT`, `SAML_IDP_ENTITY_ID`, `SAML_IDP_CERT`, `SAML_SP_ENTITY_ID`,
`SAML_DISPLAY_NAME`, `SAML_EMAIL_ATTRIBUTE`, `SAML_NAME_ATTRIBUTE`,
`SAML_USERNAME_ATTRIBUTE`, `SAML_GROUPS_ATTRIBUTE`, `SAML_ID_ATTRIBUTE`,
`SAML_CA_PEM`, `SAML_WANT_AUTHN_RESPONSE_SIGNED`.

## Access, groups and account linking

Providers with group settings share these rules:

- **Required groups**: membership in at least one is required to sign in.
- **Admin groups**: members become deployment admins; losing a group-granted
  role removes it, except for the last enabled deployment admin or an env admin.
- **Team mappings**: map group names in a workspace's team settings. Groups
  from LDAP, OIDC, SAML and SCIM follow the same mappings.
- **Workspace access groups**: groups may join their mapped workspaces. The
  directory sync also removes memberships it previously granted when groups change.
- **Allowed domains**: require a verified email. Empty means unrestricted.

Group matching is case-insensitive. SCIM groups are merged into sign-in groups
for provisioned accounts; see [Directory sync](directory-sync.md).

Automatic joining of the organization workspace defaults to **off**. Enable
it per provider (`autoJoinOrganization`, or `OIDC_AUTO_JOIN_ORGANIZATION`,
`LDAP_AUTO_JOIN_ORGANIZATION`, `SAML_AUTO_JOIN_ORGANIZATION`). Otherwise new
people get their own workspace, or join through existing verified-domain or
group rules. Existing workspaces are never implicitly adopted: bootstrap or
an explicit deployment-admin action marks one as the organization workspace.
An opted-in provider without one creates a new workspace.

By default an account is its `(provider, externalId)` identity, as upstream.
Optional `OPTIO_LINK_ACCOUNTS_BY_EMAIL=true` (Helm
`auth.linkAccountsByEmail: true`) links a new identity only when the provider
itself verifies the email and exactly one account matches it. An OIDC or
LDAP provider can also turn this on for itself alone (`linkByEmail`: Settings
→ Sign-in → Access, "Keep existing accounts by email"; `OIDC_LINK_BY_EMAIL` /
`LDAP_LINK_BY_EMAIL` from the environment; off by default). Turn it on only
where people can't change their own email at the provider. `trustEmail`
alone never links: it stands in only for a missing `email_verified` claim,
never for an explicit `false`. Links are additive in `user_identities`; the original
account's provider/ID remain intact. SCIM account claiming is separately
opted in by selecting its sign-in provider.

## Configuration, setup and recovery

Only deployment admins may change sign-in settings. Secrets are encrypted
with AES-256-GCM and provider-specific AAD; reads return `hasClientSecret`,
never plaintext secrets. A saved enabled configuration takes precedence over
environment settings; deleting it restores the environment configuration.
`PUBLIC_API_URL`, else `PUBLIC_URL`, determines registered callback URLs.

With no configured provider, `/login` redirects to setup. Unlock the Sign-in
step with `OPTIO_SETUP_TOKEN`, or the generated token printed in the API log.
The first sign-in after setup becomes deployment admin and marks their workspace
as the organization workspace. Google bootstrap keeps its existing allowed-domain
joining behavior. For an upgraded deployment without an admin, use Settings →
Sign-in and the setup token to claim the role. `OPTIO_DEPLOYMENT_ADMINS` grants
named email addresses that role; the last enabled admin cannot remove themselves.
`OPTIO_AUTH_DISABLED=true` remains available for local development.
