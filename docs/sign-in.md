# Sign-in

How people sign in to an Optio deployment, and how an organization sets up
its Google sign-in from the app. Code: `apps/api/src/services/sign-in-config-service.ts`,
`routes/sign-in.ts`, `services/oauth/google.ts`; web
`components/settings/sign-in-settings.tsx` (Settings → Access → Sign-in, and
the setup wizard's Sign-in step).

## Providers

OAuth providers: **Google**, **GitHub**, **GitLab**, generic **OIDC**. Each
can be configured by environment variables (`<PROVIDER>_OAUTH_CLIENT_ID` /
`_SECRET`, `OIDC_ISSUER_URL` …, Helm `auth.*`). **Google** can also be
configured **in the app**: Settings → Sign-in stores the OAuth client in
`auth_provider_configs` (the secret AES-256-GCM encrypted on the row, AAD
`auth_provider|google`, never returned) together with the **allowed
domains**. A stored, enabled row takes precedence over the environment.
`GET /api/auth/providers` (public) lists what people can sign in with and
says `setupRequired: true` while nothing is configured anywhere.

## Allowed domains

With domains set, a sign-in is refused (`/login?error=domain_not_allowed`)
unless the account's Google Workspace domain (`hd`) is listed **and** its
verified email's domain is listed (`domainDecision`). Public mail domains are
refused when saving (`normalizeAutoJoinDomains`). The CLI's PKCE login shares
the callback, so it is covered too. The `hd=` authorize parameter is sent as a
hint when exactly one domain is allowed.

## Deployment admins

The people who may change how everyone signs in. Instance-wide: a workspace
admin isn't enough, since every signer-in becomes admin of a workspace of
their own. Granted by `users.deployment_admin` (Settings → Sign-in →
Deployment admins, by email, for people who have signed in once) or by
`OPTIO_DEPLOYMENT_ADMINS` (comma-separated emails; Helm
`auth.deploymentAdmins`). `GET /api/auth/me` reports `deploymentAdmin`.

Email-based grants require a verified email assertion from the sign-in
provider, persisted in `users.email_verified`. Existing users populate it at
their next sign-in; an existing explicit `deployment_admin` grant remains in
place. The first bootstrap login must also use the configured provider and
an allowed, verified domain, and only one concurrent login can claim it.

Deployment admins also control deployment-wide secrets: rotating the shared
GitHub token, reading the Claude token proxy, refreshing shared Claude
credentials from a machine, and adding shared agent credentials. The legacy
agent-credential owner value `workspace` stores a global secret, so it needs
this role too. Members can still store personal credentials. Automatic shared-token refresh
checks the machine owner's permission again before using it. For upgrades with
no deployment admin yet, the founding workspace's admin retains shared-credential
administration until a deployment admin is appointed.

## Browser authentication

Browser login starts through the web application's `/api/auth/:provider/login`
proxy. It creates a private verifier cookie and sends its SHA-256 challenge to
the API. The OAuth state and final exchange code retain that challenge, and
the callback exchanges the code only with the originating browser's verifier.
State and exchange codes are consumed atomically in Redis. Native CLI login
continues to use its own PKCE verifier.

With an HTTPS `PUBLIC_URL`, browser session and verifier cookies use the
`__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`, without a
Domain attribute. Upgrading from the old cookie name requires one browser
sign-in; existing PATs are unaffected. HTTP development keeps the original
cookie names. Set the same `PUBLIC_URL` on the web and API containers.

Cookie-authenticated mutations and browser WebSocket upgrades require a
trusted Origin (`PUBLIC_URL`, `PUBLIC_API_URL`, or `OPTIO_ALLOWED_ORIGINS` at
the API; the web proxy accepts its own origin). Native clients without an
Origin header keep explicit credential authentication. WebSocket upgrades
also recheck workspace membership and resolve the current role.

## First install: bootstrap

Install the chart with `publicUrl` and **no provider** (allowed now). Nobody
can sign in, so Optio is in **bootstrap mode**: `/login` sends people to
`/setup`, whose first step is **Sign-in**. The step is reachable without a
session but needs the one-time **setup token**: `OPTIO_SETUP_TOKEN` (Helm
`auth.setupToken`) or, when unset, one the API generates, shares through Redis
(every replica agrees) and prints in its log:

```
kubectl logs -n optio deploy/optio-api | grep "setup token"
```

The step shows the redirect URI to register in Google Cloud Console
(`<origin>/api/auth/google/callback`, the origin being `PUBLIC_API_URL` when
the browser reaches the API at an origin of its own, else `PUBLIC_URL`), takes
the client ID and secret, the allowed domains, and the organization's name,
then **saves and signs in with Google**. The first person through
`completeSignIn`: they become the **deployment admin**, their workspace is
renamed to the organization and gets the allowed domains as auto-join (role
member), and the pending claim is spent. Everyone else from those domains
then lands in that workspace as a member.

The token also lets a signed-in person **claim** the role on a deployment
that has none yet (`POST /api/auth/deployment-admins/claim`, an upgrade from
before the role existed). Once a deployment admin exists the token opens
nothing.

## Endpoints

| Method | Path                                | Who                                               |
| ------ | ----------------------------------- | ------------------------------------------------- |
| GET    | `/api/auth/sign-in`                 | anyone signed in; public in bootstrap mode        |
| PUT    | `/api/auth/sign-in/:provider`       | deployment admin, or the setup token while usable |
| DELETE | `/api/auth/sign-in/:provider`       | same                                              |
| GET    | `/api/auth/deployment-admins`       | same                                              |
| POST   | `/api/auth/deployment-admins`       | same (`{ email }`, an existing user)              |
| DELETE | `/api/auth/deployment-admins/:id`   | same (never the last one)                         |
| POST   | `/api/auth/deployment-admins/claim` | signed in + setup token, only while none exists   |

The setup token travels in `X-Optio-Setup-Token`. The auth plugin lets
`/api/auth/sign-in*` through without a session only while in bootstrap mode.
Only `/api/setup/status` is public among the agent setup endpoints. Credential
probes and repository listing require a signed-in workspace admin, even before
any agent credentials have been stored. Complete the Sign-in step first.

## Testing

`services/sign-in-config-service.test.ts` (the domain decision, the env
list), `services/sign-in-config.int.test.ts` (stored config over env, secret
sealed, bootstrap mode, the shared token, the first sign-in's bootstrap, the
deployment-admin rules).

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

Issuer and discovered endpoint URLs must use HTTPS. Non-production local
development may use HTTP only on literal loopback hosts, which must also be
explicitly permitted by `OPTIO_OUTBOUND_ALLOWED_HOSTS`. Every server-side IdP
request uses the outbound URL policy and DNS-pinned transport; redirects are
refused, including token exchanges. For private IdPs configure the outbound host
allowlist and the IdP's private CA. Disabling TLS verification is rejected unless
the deployment operator explicitly sets `OPTIO_IDP_ALLOW_INSECURE_TLS=true`;
stored settings alone cannot enable it. Prefer supplying the CA.

Optional account linking requires both the new provider assertion and the
existing target account's email to be verified. An unverified existing address
cannot be used to claim that account or inherit its administrator role.

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
is cached per API replica for 24 hours; Test and Save fetch it afresh on the
replica handling that request. After revoking a signing certificate, restart all
API replicas or wait for every cache to expire. A private CA is supported.
Metadata and single sign-on URLs require HTTPS (literal localhost HTTP is allowed
only outside production). Metadata requests obey the deployment outbound allowlist,
refuse redirects and stop reading after 2 MB. Disabling TLS verification requires
`OPTIO_IDP_ALLOW_INSECURE_TLS=true` on the deployment; prefer a private CA.

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
The signature library also accepts SHA-1 signatures/digests from a trusted IdP;
Optio cannot restrict these verification algorithms through node-saml 5's API.
Configure the IdP to sign with SHA-256 or stronger.

Map the **email**, **name**, **username**, **groups** and **stable ID**
attributes. Defaults accept common attribute names, LDAP OIDs and Microsoft
claim URIs. The default stable ID is NameID; for a transient NameID, email
is the fallback. Prefer a persistent NameID or a configured stable ID attribute
so changing a person's email does not create a new account. Signed email
attributes count as verified. Enable email-based account linking only when people
cannot change their own email at the IdP. An email address is required; a missing
configured stable ID attribute rejects sign-in instead of falling back to NameID.
Groups are read from the assertion and follow the access rules below.

Environment configuration: `SAML_METADATA_URL` or `SAML_METADATA_XML`,
`SAML_ENTRY_POINT`, `SAML_IDP_ENTITY_ID`, `SAML_IDP_CERT`, `SAML_SP_ENTITY_ID`,
`SAML_DISPLAY_NAME`, `SAML_EMAIL_ATTRIBUTE`, `SAML_NAME_ATTRIBUTE`,
`SAML_USERNAME_ATTRIBUTE`, `SAML_GROUPS_ATTRIBUTE`, `SAML_ID_ATTRIBUTE`,
`SAML_CA_PEM`, `SAML_WANT_AUTHN_RESPONSE_SIGNED`.

These `SAML_*` variables are environment configuration, not dedicated Helm values.
For Helm installs, configure SAML in Settings → Sign-in or pass these variables
through the chart's `optio.env` deployment environment map.

## Bitbucket Cloud (`bitbucket`)

Create an OAuth consumer in Bitbucket's workspace settings. Register the
callback URL displayed by Optio (`<origin>/api/auth/bitbucket/callback`) and
grant Account, Email and Workspace membership read permissions. Save its
client ID and secret in Optio, or set `BITBUCKET_OAUTH_CLIENT_ID` and
`BITBUCKET_OAUTH_CLIENT_SECRET`.

The account's stable identity is its Bitbucket UUID. Only a confirmed primary
email counts as verified. Workspace slugs are reported as groups.

## Gitea / Forgejo (`gitea`)

Register an OAuth2 application on your server with callback
`<origin>/api/auth/gitea/callback`. Save its server URL (including any path
prefix), client ID and secret in Optio. For Forgejo, set the button label to
“Forgejo”. Environment equivalents are `GITEA_OAUTH_BASE_URL`,
`GITEA_OAUTH_CLIENT_ID`, `GITEA_OAUTH_CLIENT_SECRET`, `GITEA_DISPLAY_NAME`,
`GITEA_OAUTH_SCOPES` and `GITEA_CA_PEM`.

The client uses the server's OpenID Connect discovery, PKCE S256, a nonce,
and JWKS verification. Default scopes are `openid profile email groups`;
organizations and teams are reported in the `groups` claim.
Set a private CA certificate when the server needs one.

See the [Gitea OAuth2 provider documentation](https://docs.gitea.com/development/oauth2-provider/)
for scopes supported by your version and their resource access implications.

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
Both full group DNs and their CNs are returned as provider claims; this split does not grant roles from groups.
Environment configuration uses `LDAP_URL`, `LDAP_USER_BASE_DN`,
`LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`, `LDAP_START_TLS`, `LDAP_CA_PEM`,
`LDAP_USER_FILTER`, `LDAP_USERNAME_ATTRIBUTE`, `LDAP_EMAIL_ATTRIBUTE`,
`LDAP_DISPLAY_NAME_ATTRIBUTE`, `LDAP_GROUP_MODE`, `LDAP_GROUP_BASE_DN`,
`LDAP_GROUP_FILTER` and
`LDAP_DISPLAY_NAME`. The username field's label is set in the app.

`POST /api/auth/ldap/login` takes `{ username, password }` and returns a
one-time browser auth code; `cli: true` returns a personal access token.
Wrong credentials receive the same 401 response. Operations time out after
10 seconds. Requests have a per-IP rate limit; configure the directory's own
per-account lockout policy as well. Unknown usernames return before a password
bind, so response timing can reveal directory membership. Prefer LDAPS or
STARTTLS; plain LDAP without STARTTLS sends credentials without encryption.
The saved bind password belongs to its server: a save that changes the URL,
STARTTLS, certificate verification or CA must enter the password again (an
anonymous bind drops the saved one), and the connection test reuses saved or
environment credentials only for that same URL and transport. Disabling TLS
verification requires `OPTIO_IDP_ALLOW_INSECURE_TLS=true` on the deployment;
prefer a private CA. An Active Directory account flagged disabled
(`userAccountControl` ACCOUNTDISABLE) is refused even if the directory accepts
its bind.

## Access, groups and account linking

Providers with group settings share these rules:

- **Required groups**: membership in at least one is required to sign in.
- **Admin groups**: members become deployment admins; losing a group-granted
  role removes it, except for the last enabled deployment admin or an env admin.
- **Workspace access groups**: provider-qualified groups may join their mapped workspaces, with member or viewer role. Only deployment admins change these mappings.
- **Allowed domains**: require a verified email. Empty means unrestricted.

Group matching is case-insensitive. Workspace membership mappings include the provider and its issuer authority, so another provider's matching group name does not grant access.

Automatic joining of the organization workspace defaults to **off**. Enable
it per provider in Settings → Sign-in (`autoJoinOrganization`; for environment-configured OpenID Connect
`OIDC_AUTO_JOIN_ORGANIZATION`, Helm `auth.oidc.autoJoinOrganization`). Otherwise new
people get their own workspace, or join through existing verified-domain or
group rules. Existing workspaces are never implicitly adopted. Bootstrap marks
its workspace as the organization workspace; an opted-in provider without one
creates a new workspace. An ordinary first joiner receives member access,
not administrator access; deployment admins administer the organization
workspace (they are made its admins when it is created, when appointed in the
app, and when they sign in with organization joining on).

Admin and required groups can also be configured with `OIDC_ADMIN_GROUPS` and `OIDC_REQUIRED_GROUPS` (Helm `auth.oidc.adminGroups` / `auth.oidc.requiredGroups`). All default to empty, with organization joining off. Group-derived admin grants retain provider provenance alongside manually granted roles.

Group-created workspace memberships are re-evaluated at the next sign-in with
that provider: losing the mapped groups removes those memberships. Manual
memberships remain. Only a groups claim that is present (even an empty one)
counts: a sign-in whose token, userinfo or assertion carries no groups claim at
all leaves group memberships and group-granted roles unchanged, so configure
the provider to send the claim to have removals take effect. Signing in through a linked GitHub identity does not refresh
OIDC claims. Existing PATs and sessions are not revoked by an IdP group change
until Optio receives a new assertion. The last enabled deployment admin is
retained even after losing its admin group; Optio logs a warning and another
admin must be appointed before that grant can be removed.

Group strings retain embedded spaces (`Domain Users` is one group); comma-separated
values are supported. Remembered claims are limited to 300 groups per account,
with bounded name lengths and a warning when claims exceed the bound. Only
deployment admins may read the deployment-wide group picker directory.
