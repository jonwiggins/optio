# Credential health: every token checked ahead of time

Optio works with other people's tokens: the organization's GitHub or GitLab
token (webhooks, pull or merge requests, merges), each team's and each
person's GitHub and GitLab token, a gateway token for every run, Jira and remote-workspace connections. When one of
them expires or runs out of budget, work stops, and the service usually tells
only the token's own (often a bot's) mailbox.

So Optio checks each of them on a schedule, shows what it found, warns the
token's owner by email before it expires and when it stops working, and asks
the gateway about a run's token before the run gets a pod.

## What is checked

| Credential                                                                                               | Asked                                                                                                                                                                                                | Read                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **GitHub token**: the organization's, each team's, each person's (`GITHUB_TOKEN`), and the environment's | `GET /user` on the GitHub of the owner's repos (`api.github.com` or a GitHub Enterprise Server)                                                                                                      | expiry (`github-authentication-token-expiration`), refused; for a classic token, its scopes (`repo` is needed)                                                           |
| **GitLab token**: the organization's, each team's, each person's (`GITLAB_TOKEN`), and the environment's | `GET /api/v4/personal_access_tokens/self` on the deployment's GitLab                                                                                                                                 | expiry, scopes (`api` is needed), revoked; for the organization's token, its access on the projects that carry Optio's webhooks (Maintainer needed)                      |
| **Gateway token**: the gateway's shared one, the organization's, each team's, each person's              | LiteLLM `GET /key/info`, OpenRouter `GET /api/v1/key` with the token                                                                                                                                 | expiry, blocked, spend against the budget, the reset; a gateway whose type reports none (Portkey, generic) only says whether the token works                             |
| **Jira connection** (each enabled ticket provider on Jira)                                               | the connection's **Test** (`/serverInfo`, `/myself`) with its stored credentials                                                                                                                     | whether Jira accepts it, the account, the server                                                                                                                         |
| **Remote-workspace connection** (each enabled one)                                                       | the connection's **Test** with its stored token: Coder `/api/v2/users/me` (and, for a session token, `/api/v2/users/me/keys/<id>`), Daytona `/api-keys/current`, E2B `/v2/templates`, GitHub `/user` | whether the provider accepts it, the account, the token's expiry where the provider gives one (Coder, Daytona, GitHub's `github-authentication-token-expiration` header) |

A GitHub token is sent to the GitHub of its owner's GitHub repos, and to
`api.github.com` when the owner has none, unless models are reached through
a gateway only (`OPTIO_MODEL_ACCESS=gateway`). A
GitHub App's tokens renew themselves and aren't listed.

A GitLab token is sent only to a GitLab a deployment admin named: the setup
wizard's GitLab host (the `GITLAB_HOST` deployment secret) and the chart's
`gitlab.hosts`. Of those, a token goes to the ones its owner's work uses (the
repos of the person's workspaces, of the team's workspace, of every workspace
for the organization's token), and to all of them only when the owner has no
GitLab repo yet. A repo on a host nobody named is never asked — any workspace
admin adds repos — so a token whose owner works only there shows **Unknown**
("No GitLab host to check it against"): add the host to `gitlab.hosts`.
`gitlab.com` is never asked with `OPTIO_MODEL_ACCESS=gateway`. A GitLab older
than 15.5 has no `/personal_access_tokens/self`: Optio then checks only that
the token signs in. TLS to every service trusts the chart's `caBundle` (and a
Jira or remote-workspace connection's own CA field, `OPTIO_GATEWAY_CA_PEM` for the
gateway).

LiteLLM authenticates `/key/info` like every other route, so an expired key
never gets its info back: LiteLLM answers 400 `expired_key` ("Expired Key.
Key Expiry time …"), which Optio shows as **Failing**, `Expired on <time>`.
A wrong, deleted or blocked key gets a 401.

Each credential gets one of:

| Status      | Means                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **OK**      | The service accepts it and nothing is near its end                                                                                      |
| **Warning** | It works, but expires within 30 days, lacks the `api` scope, isn't Maintainer where Optio keeps webhooks, or has used 80% of its budget |
| **Failing** | The service refuses it (expired, revoked, wrong, blocked) or its budget is spent: work that uses it fails                               |
| **Unknown** | The service couldn't be reached, or doesn't say                                                                                         |

and one sentence that says why, for example `Expires in 7 days (2026-11-01
00:00 UTC)`, `Over budget until 2026-11-01 00:00 UTC: 5.10 of 5.00 USD
spent`, `GitLab at gitlab.example.test refused it (401): expired, revoked or
wrong`, `Not Maintainer on platform/app: Optio can't keep the webhook
there`. Optio never stores or shows a token's value.

## Where to see it

- **Settings → System health** (deployment admins, workspace admins and team
  admins): one row per credential with what it is, whose, its status and
  why, when it expires, when it was last checked, and **Check now**.
  - A **deployment admin** sees every credential (the organization's GitLab
    and gateway tokens are deployment-wide secrets) and has **Check all**.
  - A **team admin** sees their teams' tokens and connections.
  - A **workspace admin** sees what their workspace's admins manage: its
    organization Jira and remote-workspace connections and the shared token of its
    gateways (a gateway whose token source is one stored token, Settings →
    Model gateway).
- **Settings → My tokens → Health** (everyone): your own GitLab and gateway
  tokens and your private Jira and remote-workspace connections, with **Check my
  tokens**. A token you just saved has no row until it is checked: press it.

Someone else's credential is a 404 to you, the same as one that doesn't
exist.

## Warnings by email

Through the deployment's relay ([notifications.md](notifications.md)), and on the
person's own chat hook when they set one, each at most once per threshold
per credential (a warning no channel could take stays due until one can):

| Kind              | When                                                                                       | Settings → Notifications label |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------ |
| `token.expiring`  | 30, 7 and 1 days before the expiry (a token first seen 5 days out gets only the 7-day one) | Token expiring                 |
| `token.invalid`   | The service refuses it: expired, revoked, wrong, blocked                                   | Token refused                  |
| `budget.exceeded` | A gateway token spent its budget                                                           | Gateway budget used up         |

- **Who gets it:** a person's token, that person; a team's, the team's
  admins; the organization's, the deployment admins — and for one a
  workspace's admins manage (its Jira and remote-workspace connections, its gateways'
  shared token), that workspace's admins too. Each person gets it once.
- The email says whose token it is, what stops with it and where to fix it
  (`Settings → My tokens`, `Teams → Platform → Tokens`, `Settings → Model
gateway`, the deployment secret `GITLAB_TOKEN`), with a link to the page.
- A renewed token (another expiry date) gets its own warnings. A token that
  works again is news again the next time it fails.
- A warning counts as sent when someone got it, chose not to get it, or
  there is no one to tell. It also counts when the team's channel took it,
  even if no admin of the team could be reached, so the channel gets each
  warning once. Someone with no usable email address and no chat hook counts
  as no one, as before chat hooks. A warning for someone who has an address
  but no hook, while email isn't set up yet, stays due and goes out once the
  relay is set.
- While no relay is set up, warnings stay due and go out once it is.
- Each person turns each kind off under Settings → Notifications.

## Before a run: the gateway pre-flight

Before a Task, Job run, PR review or agent turn gets its pod, Optio asks the
gateway (`/key/info`) about the token the run will carry, and fails the run
at once when the gateway already refuses it:

```
Your gateway token is over budget until 2026-11-01 00:00 UTC (5.10 of 5.00 USD spent) — Settings → My tokens
The Platform team's gateway token was rejected by the gateway (401: Authentication Error, Invalid proxy server token passed) — put in a new one under Teams → Platform → Tokens
The organization's gateway token expired on 2026-10-01 00:00 UTC and is rejected by the gateway — put in a new one under Settings → Model gateway
```

An expired key is known by LiteLLM's own refusal (`expired_key`), which says
when it expired. A LiteLLM that checks budgets on `/key/info` too answers an
over-budget key with its refusal only, so there is no reset to show: `… is
over budget (2.50 of 2.00 USD spent); the gateway refuses it until its budget
resets or is raised — Settings → My tokens`.

An expiring token is not refused. A gateway that can't be reached, or whose
type doesn't report a token's budget, lets the run go on: the pre-flight only
stops what it knows will fail. A refusal also updates the token's row at once. The chart's
`credentialHealth.gatewayPreflight: false` (`OPTIO_GATEWAY_PREFLIGHT=false`)
turns it off.

Upstream checks the Claude OAuth token before a run, and under the gateway
that check doesn't apply; this is the gateway's.

## Failure messages that name this deployment's fix

When a run fails anyway, its error is classified ahead of upstream's rules
with `OPTIO_MODEL_ACCESS=gateway` (`packages/shared/src/error-classifier-site.ts`):

| The error says                                                                                                                                                                                                                       | Shown as                                 | The fix it names                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `budget_exceeded`, `ExceededBudget`, `ExceededTokenBudget`, `Budget has been exceeded!`, the pre-flight's "over budget"                                                                                                              | **Gateway budget used up**               | the spend and reset; whose token (the team's, yours, the organization's) and where to change it                                          |
| `Invalid proxy server token`, `Expired Key`, `Invalid API key · Please run /login`, the pre-flight's "rejected by the gateway"                                                                                                       | **Gateway token rejected**               | put in a token the gateway accepts, where that token lives                                                                               |
| `Add your gateway token …`, `… has no gateway token …`                                                                                                                                                                               | **Gateway token missing**                | where to add it                                                                                                                          |
| a 429, `rate limit`, `No deployments available`, a 503 from the gateway or its Redis                                                                                                                                                 | **Gateway rate limit**                   | wait and retry; the gateway's admin raises the token's limits                                                                            |
| `self signed certificate in certificate chain`, `unable to get local issuer certificate`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, git's `SSL certificate problem`, `x509: certificate signed by unknown authority` (not in an image pull) | **Private CA not trusted**               | the chart's `caBundle` (or the connection's own CA field, `OPTIO_GATEWAY_CA_PEM`)                                                        |
| `ErrImagePull` / `ImagePullBackOff` with one of those certificate errors                                                                                                                                                             | **Registry CA not trusted by the nodes** | the nodes' trust for the registry (RKE2 / K3s `registries.yaml`, containerd `certs.d`): the chart's `caBundle` doesn't reach the kubelet |
| `GitLab API error 401/403`, `HTTP Basic: Access denied`, `Authentication failed for '…'`, `The requested URL returned error: 403`, `glab … 401`                                                                                      | **GitLab token refused**                 | which token Optio used (team → yours → the organization's) and where each is replaced, with the `api` scope                              |
| `No GitLab token available`                                                                                                                                                                                                          | **GitLab token missing**                 | the order of tokens and where to add one                                                                                                 |

Other messages upstream answers with an earlier rule (an image that can't be
pulled, a pod that didn't start, a secret) keep upstream's answer.

With `OPTIO_MODEL_ACCESS=gateway` no message sends anyone to the Claude
Keychain, `claude setup-token`, Max subscription or "switch to API key
auth". With the default model access (`any`) the classifier is upstream's,
unchanged.

## Configuration

| Chart value                         | Environment                                | Default | Means                                                                                                                      |
| ----------------------------------- | ------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `credentialHealth.intervalMinutes`  | `OPTIO_CREDENTIAL_HEALTH_INTERVAL_MINUTES` | `0`     | Minutes between passes (e.g. `15`); `0` or unset leaves the periodic checks and their warnings off (Check now still works) |
| `credentialHealth.gatewayPreflight` | `OPTIO_GATEWAY_PREFLIGHT`                  | `true`  | Ask the gateway about a run's token before its pod; unset in the chart renders nothing, `false` turns it off               |

One API instance runs each pass (the `poller:credential-health` lease), so
several replicas check each token once. The first pass runs a minute after
the API starts.

## API

| Call                                     | Who                  | Does                                                                                 |
| ---------------------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| `GET /api/credential-health[?mine=true]` | anyone signed in     | the rows the caller may see, worst first (`mine`: their own only), and `canCheckAll` |
| `POST /api/credential-health/check`      | anyone (viewers too) | `{ key }`: checks one credential the caller may see now (404 otherwise)              |
| `POST /api/credential-health/check-mine` | anyone (viewers too) | checks every credential that is the caller's own                                     |
| `POST /api/credential-health/check-all`  | deployment admins    | starts a pass over everything (202)                                                  |

## Not checked yet

The LDAP bind account, OIDC discovery and the CA bundle's own expiry are not
checked here; Settings → Sign-in's **Test** buttons check the first two by
hand.

## Where it lives

| Piece                  | Code                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| The pass, Check now    | `apps/api/src/services/credential-health.ts`, `workers/credential-health-worker.ts`                             |
| What there is to check | `services/credential-health/inventory.ts` (keys in `keys.ts`)                                                   |
| Asking each service    | `services/credential-health/checks.ts`; the rules in `outcome.ts` (pure)                                        |
| Warnings               | `services/credential-health/alerts.ts`; kinds in `services/notify/kinds.ts`                                     |
| Rows and who sees them | `services/credential-health/store.ts`; table `credential_checks` (migration `1792730000_credential_health.sql`) |
| The pre-flight         | `services/credential-health/gateway-preflight.ts`, called from `resolveGatewayRun` (`gateway-run-service.ts`)   |
| Routes                 | `apps/api/src/routes/credential-health.ts`                                                                      |
| Failure messages       | `packages/shared/src/error-classifier-site.ts`, one call in `error-classifier.ts`                               |
| Web                    | `apps/web/src/components/settings/system-health.tsx`, `lib/credential-health-api.ts`                            |
