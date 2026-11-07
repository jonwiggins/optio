# Credential health

Optio checks the tokens it holds that a person can renew, warns before one
expires, and stops a gateway run before its pod when the gateway would refuse
the token anyway. It is on by default and only reads: a check never changes a
token. `OPTIO_CREDENTIAL_HEALTH=false` turns the checks off;
`OPTIO_GATEWAY_PREFLIGHT=false` turns the run pre-flight off.

## What is checked

| Token                                                             | Whose                                                                            | How                                                                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Gateway token (`gateway:<providerId>`)                            | a person's (pasted or made by Optio), the organization's, a gateway's shared one | LiteLLM `GET /key/info`, OpenRouter `GET /api/v1/key` with the token; other types `GET /v1/models` (accepted or not) |
| `GITLAB_TOKEN`, `GITLAB_TOKEN_<HOST>`, `GITLAB_USER_ACCESS_TOKEN` | a person's, the organization's (global)                                          | `GET /api/v4/personal_access_tokens/self`                                                                            |

Each token goes only where it is already used:

- A gateway token is read through the gateway's own consent check, for the
  gateway it was given for. Adding a gateway never sends anyone's token to it,
  and a token stored before the gateway's URL changed is not sent at all (its
  row says so).
- A GitLab token goes only to a GitLab host a deployment admin named (the
  setup wizard's `GITLAB_HOST`, `GITLAB_HOSTS`); a `GITLAB_TOKEN_<HOST>` only
  to the host it names. gitlab.com is asked only when no host is named, and
  never with `OPTIO_MODEL_ACCESS=gateway`. A repo's host is never enough.

All requests go through the deployment's outbound policy with redirects
refused, and the answers are size-capped and schema-checked.

Every token is checked at most every 15 minutes
(`OPTIO_CREDENTIAL_CHECK_MINUTES`), a few at a time, on the housekeeping tick.
A service that can't be reached is `unknown`, never `error`.

## What a check finds

- **ok**: accepted, nothing near its end.
- **warning**: expires within 30 days, lacks GitLab's `api` scope, or has used
  80% of its gateway budget.
- **error**: refused (expired, revoked, blocked, wrong) or over its budget.
- **unknown**: the service didn't answer, or there is nowhere it may be sent.

Settings → My tokens → **Health** lists the tokens you look after, worst
first: your own; a workspace admin also sees the workspace's (its gateways'
tokens, a GitLab token stored for it); a deployment admin also the
deployment-wide ones. **Check now** checks your own at once (a token checked
in the last minute keeps its result). Rows hold what the check read (host,
scopes, spend and budget), never a token.

## Warnings by email

Sent through the email notifications (Settings → Notifications, where each
person can turn them off), once per threshold per token:

- `token.expiring`: 30, 7 and 1 days before a token expires (a renewed token's
  new date starts over);
- `token.invalid`: the service refuses it (not a gateway that only won't
  describe it);
- `budget.exceeded`: a gateway token spent its budget (once per budget
  period).

A person's token warns that person; the organization's warns its workspace's
admins, or the deployment admins for a deployment-wide one. A warning that
couldn't go out (email isn't set up yet) stays due.

## The gateway pre-flight

Before a gateway run's pod is made, Optio asks the gateway about the token the
run will carry (LiteLLM `/key/info`, OpenRouter `/api/v1/key`). When the
gateway already refuses it, the run fails at once with whose token it is,
until when and where to fix it:

    Your gateway token is over budget until 2026-11-01 00:00 UTC (5.10 of 5.00 USD spent): Settings → My tokens

For the organization's token or a gateway's shared one, which everyone who can
see the run reads, the message names no amounts and asks for an Optio admin:

    The organization's gateway token is over budget until 2026-11-01 00:00 UTC: ask an Optio admin to fix it (Settings → My tokens)

The run fails only on what the gateway says about the token itself: over
budget, expired, blocked, or a refusal in the shape the gateway answers a bad
key with (LiteLLM's `auth_error`, OpenRouter's 401). A bare 403, or a 401 in
any other shape, is how a LiteLLM with `allowed_routes` or
`disable_admin_endpoints` (or a proxy in front of it) guards `/key/info` for
keys that still work for models, so the run goes on and Optio logs it once.
Health then asks `/v1/models` instead. A gateway that can't be reached, or
whose type reports no budget, also lets the run go on.

## Not yet

GitHub tokens, team tokens, and connections other features add (ticket
providers, remote workspaces) follow with those features.
