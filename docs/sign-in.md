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

The step shows the redirect URI to register in Google Cloud Console, takes
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

## Testing

`services/sign-in-config-service.test.ts` (the domain decision, the env
list), `services/sign-in-config.int.test.ts` (stored config over env, secret
sealed, bootstrap mode, the shared token, the first sign-in's bootstrap, the
deployment-admin rules).
