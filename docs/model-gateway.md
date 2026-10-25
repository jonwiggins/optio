# Model gateways

A **model gateway** is a model provider (`model_providers` with `kind = "gateway"`)
that agents reach their models through: an Anthropic- / OpenAI-compatible endpoint
with a catalog of the models it serves (the admin's names, context windows,
prices), and a token per person, per team or for the organization. Its **type**
says what it is, and the type decides which of Optio's gateway features it
offers: Settings shows only what the type supports, and the API refuses the
rest, so a feature a type lacks is hidden, never half-run.

## Gateway types

|                                                       | LiteLLM                                                                   | OpenAI- / Anthropic-compatible                     | OpenRouter                                                                             | Portkey                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `gatewayType`                                         | `litellm`                                                                 | `generic`                                          | `openrouter`                                                                           | `portkey`                                              |
| Base URL                                              | the proxy (`https://litellm.example.com`)                                 | the endpoint (`https://gateway.example.com`)       | `https://openrouter.ai/api`                                                            | `https://api.portkey.ai`                               |
| Catalog sync                                          | `/model/info` + `/v1/models`: ids, context windows, output limits, prices | `/v1/models`: ids (Anthropic-style pages followed) | `/api/v1/models`: context lengths, output limits, prices for the ids the catalog lists | `/v1/models`: ids                                      |
| A token's own budget (Overview, health, pre-flight)   | `/key/info`                                                               | —                                                  | `/api/v1/key`                                                                          | —                                                      |
| Keys Optio makes                                      | with the admin key (`/key/*`, `/team/*`)                                  | —                                                  | with a management key (`/api/v1/keys`)                                                 | with an admin API key (`/v1/api-keys`)                 |
| Budget periods                                        | any duration (`30d`, `1mo`, `12h`)                                        | —                                                  | daily, weekly, monthly (UTC)                                                           | weekly, monthly, 1–365 days; whole USD, 1 or more      |
| A team's budget                                       | a LiteLLM team its keys share                                             | —                                                  | the team key's own limit                                                               | the team key's own limit                               |
| Spend Optio reads (80% / 100% warnings, usage panels) | yes                                                                       | —                                                  | yes                                                                                    | no (Portkey's own alerts)                              |
| Keys limited to some models                           | yes                                                                       | —                                                  | no                                                                                     | no                                                     |
| Rotate keeps the period's spend                       | yes: carried as the new key's spend                                       | —                                                  | yes: carried as a lower limit                                                          | yes: the same key gets a new value                     |
| A leaver's key                                        | blocked (`/key/block`; spend kept)                                        | —                                                  | disabled (usage kept)                                                                  | deleted (Portkey documents no disable)                 |
| Extra env for Claude Code                             | —                                                                         | —                                                  | — (no `ANTHROPIC_API_KEY` beside the token, as on every gateway)                       | `ANTHROPIC_CUSTOM_HEADERS: x-portkey-api-key: <token>` |

The columns are `modelGatewayCapabilities(type)` in
`packages/shared/src/model-gateways.ts`:

| Flag                | Means                                                                       | litellm | generic | openrouter | portkey |
| ------------------- | --------------------------------------------------------------------------- | ------- | ------- | ---------- | ------- |
| `catalog`           | Sync reads the models the gateway serves                                    | ✓       | ✓       | ✓          | ✓       |
| `catalogDetails`    | … and their context windows, output limits and prices                       | ✓       |         | ✓          |         |
| `catalogAddsModels` | Sync adds every model the gateway lists (else it refreshes the ones listed) | ✓       | ✓       |            | ✓       |
| `tokenBudget`       | A token's spend, budget and expiry can be read with the token               | ✓       |         | ✓          |         |
| `managedKeys`       | Optio makes, rotates and revokes people's and teams' keys                   | ✓       |         | ✓          | ✓       |
| `budgets`           | A key Optio makes carries a spending limit                                  | ✓       |         | ✓          | ✓       |
| `spend`             | Optio reads what a key it made has spent                                    | ✓       |         | ✓          |         |
| `keyModels`         | A key can be limited to some of the catalog's models                        | ✓       |         |            |         |

A gateway's type is set when it is created (`POST /api/model-providers {
kind: "gateway", gatewayType }`, `litellm` when none is given) and can change
while no key Optio made on it is active (`PATCH`; revoke them first, since
they live in the old type's admin API). A gateway saved before types existed
is a LiteLLM one (migration `1792834600_model_gateway_types` sets
`gateway_type = 'litellm'` on every gateway row). Code: the shared flags and
labels `packages/shared/src/model-gateways.ts`; the catalog, the token test
and a token's budget per type `services/model-gateway-service.ts`; a key
driver per type, `services/gateway-admin.ts` → `litellm-admin.ts`,
`openrouter-admin.ts`, `portkey-admin.ts`.

### LiteLLM

A LiteLLM proxy. The admin key is the master key or a proxy admin's key;
its management API answers at the **sync URL** when that is set, else the
base URL. Everything below works as described, and the end-to-end suite
runs it against a LiteLLM stand-in.

### OpenAI- / Anthropic-compatible

Any endpoint that speaks the Anthropic Messages API for Claude Code and the
OpenAI API (at `<base URL>/v1`) for OpenCode: a base URL and a token, the
catalog's ids from `GET /v1/models` (an Anthropic-style list is read page by
page through `has_more` / `last_id`, with the `anthropic-version` header).
People paste their own tokens; Optio makes no keys and reads no budget, so
the Overview's budget row says the gateway doesn't report one and the run
pre-flight lets every run go on. Checked against an in-process stand-in.

### OpenRouter

Base URL `https://openrouter.ai/api` (Claude Code calls its Anthropic
endpoint there; OpenCode its OpenAI one at `/api/v1`). As OpenRouter's
Claude Code guide asks, a run's token goes in `ANTHROPIC_AUTH_TOKEN` and no
`ANTHROPIC_API_KEY` is set beside it (no gateway run sets one: pods drop it,
machines unset it).

- **Catalog**: OpenRouter lists hundreds of models, so Sync doesn't add
  them: an admin adds the ids they want to the catalog
  (`anthropic/claude-sonnet-4.5`), and Sync fills in `context_length`,
  `top_provider.max_completion_tokens` and the prices (`pricing.prompt`,
  `completion`, `input_cache_read`, `input_cache_write`: USD per token, × 1e6;
  a negative price, as a router's, is left out) and flags ids it no longer
  serves. Sync on an empty catalog says how many models OpenRouter serves.
- **A token's budget**: `GET /api/v1/key` with the token: the limit, what
  remains of it, the reset (`limit_reset`: the next midnight, Monday or 1st,
  UTC) and the expiry, read in `/key/info`'s shape, so the Overview, the
  credential health check and the run pre-flight treat it as they treat
  LiteLLM's. `POST /api/model-providers/:id/test` tries the token on
  `/api/v1/key` first (the model list answers anyone).
- **Keys Optio makes** with a **management key** (OpenRouter's Settings →
  Management keys; it can't call models itself): `POST /api/v1/keys { name,
limit, limit_reset, expires_at }` → the key once, and its `hash`, which
  Optio keeps (`gateway_issued_keys.gateway_key_id`). A budget period is
  OpenRouter's nearest reset (`1d` daily, up to `7d` weekly, longer monthly),
  and an expiry is sent to the second, as OpenRouter wants. OpenRouter keeps
  no teams: a team's key carries the team's budget as its own limit, and
  setting the team's budget `PATCH`es that limit. A person leaving gets the
  key disabled (`PATCH { disabled: true }`; its usage stays); giving a key up
  or deleting the gateway deletes it (`DELETE /api/v1/keys/{hash}`). The
  admin key is tried on `GET /api/v1/keys`.
- **Rotate** makes a new key and deletes the old one. OpenRouter's usage
  can't be set, so what the old key spent this period is carried as a
  **lower limit** on the new one (budget less the carried amount); once that
  period ends the housekeeping check sets the limit back to the budget. The
  spend Optio shows and warns at adds the carried amounts back, so a
  person's budget reads the same before and after a rotation.

Checked against OpenRouter's published API reference (API Keys: create, get,
update, delete, list; the current key; the model list; the Claude Code
guide) and an in-process stand-in (`test-utils/fake-openrouter.ts`), not
against a live OpenRouter account.

### Portkey

Base URL `https://api.portkey.ai` (Claude Code calls `/v1/messages` there,
OpenCode `/v1`). As Portkey's Claude Code guide shows, the token goes in
`ANTHROPIC_AUTH_TOKEN` and as Portkey's own header
(`ANTHROPIC_CUSTOM_HEADERS: x-portkey-api-key: <token>`). Name the catalog's
models as Portkey's Model Catalog does (`@provider-slug/model`), so no
provider header is needed.

- **Catalog**: `GET /v1/models` with `x-portkey-api-key`: the ids.
- **A token's budget**: Portkey's key API doesn't report a key's usage, so
  Optio reads none: the Overview's row says so, the pre-flight lets runs go
  on, and Optio sends no budget warnings (Portkey's alert thresholds can).
- **Keys Optio makes** with an **admin API key** at the control plane:
  `https://api.portkey.ai/v1`, or a self-hosted control plane's URL (the
  **Control plane URL** field). `POST /api-keys/workspace/service { name,
scopes: ["completions.write"], workspace_id, usage_limits: { type: "cost",
credit_limit, periodic_reset | periodic_reset_days }, expires_at, defaults:
{ metadata } }` → the key and its UUID, which Optio keeps. The person's
  email goes in the metadata as `_user` (Portkey's user field), with
  Optio's ids. A budget is whole USD, 1 or more; a period is weekly, monthly
  or 1–365 days (`periodic_reset_days`). The **workspace** the keys are made
  in is a key-issuing setting (`defaults.workspace`; empty = the admin key's
  own). A team's key carries the team's budget as its cost limit (`PUT
/api-keys/{id} { usage_limits }`); Portkey documents no way to take a
  limit off, so a key's budget can be changed but not removed (revoke it and
  make one without). Portkey documents no way to disable a key: a leaver's
  key is deleted. The admin key is tried on `GET /api-keys`.
- **Rotate** gives the same key a new value (`POST /api-keys/{id}/rotate {
key_transition_period_ms: 1800000 }`), so its limit and usage stay with
  it; the old value keeps working for Portkey's minimum transition, 30
  minutes. Giving a key up and getting another starts a new key (and a new
  limit).

Checked against Portkey's published Admin API reference (API keys: create,
list, retrieve, update, rotate, delete), its inference API reference
(`/v1/models`), its budget-limit guide and its Claude Code guide, and an
in-process stand-in (`test-utils/fake-portkey.ts`), not against a live
Portkey account.

## The pieces

- **Gateway** (Settings → Model gateway; `/api/model-providers`): its
  `gatewayType`, `baseUrl`, the agents it serves (`claude-code`, `opencode`),
  `authHeader` (`bearer` → `ANTHROPIC_AUTH_TOKEN` / `Authorization: Bearer`,
  or `api-key` → `ANTHROPIC_API_KEY` / `x-api-key`), an optional `syncUrl`
  (LiteLLM: where its management API answers; Portkey: the control plane)
  and the **catalog**:
  ```json
  {
    "claude-code": [
      {
        "id": "claude-sonnet-internal",
        "label": "Sonnet (internal)",
        "contextWindow": 200000,
        "maxOutputTokens": 32000,
        "efforts": ["low", "medium", "high", "xhigh", "max"],
        "defaultEffort": "high",
        "prices": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 },
        "role": "sonnet"
      }
    ]
  }
  ```
  `prices` are USD per million tokens (what the organization pays its
  gateway, or the public list price — the Usage page labels them estimates).
  `role` (`opus` | `sonnet` | `haiku`) says which of Claude Code's built-in
  aliases the model stands in for; the picked model is the default for every
  role it doesn't name.
  A gateway's `region` is empty, and the `podCredential` follows its
  `tokenSource` (`none` for `personal`, `bearer-token` for `stored`).
  With `OPTIO_MODEL_ACCESS=gateway` (Helm `modelAccess: gateway`), only
  gateways are offered and `POST /api/model-providers` refuses
  `kind: bedrock` (400). The default, `any`, offers both Bedrock and gateways.
- **Default gateway** (`workspaces.default_model_provider_id`, set with
  `PUT /api/workspaces/:id/default-gateway { providerId }` by an admin;
  the organization's first gateway stands in while none is named): the New
  work form offers its catalog instead of the stock Anthropic list
  (`GET /api/agents/anthropic/options` answers with it — or with any
  gateway's, `?provider=<id>` — as a `ProviderCatalog`: the models with
  their efforts, `claudeContextWindow` hidden since the catalog says it,
  `claudeEffort` kept), and a gateway-only deployment never probes
  api.anthropic.com. The setup wizard creates it (its type picked there),
  and counts it as the agent source (`GET /api/setup/status` →
  `steps.modelGateway`).
- **Tokens**: the secret named by the gateway's auth header
  (`ANTHROPIC_AUTH_TOKEN` by default, `ANTHROPIC_API_KEY` for `api-key`;
  `OPENAI_API_KEY` for a gateway serving OpenCode alone —
  `gatewayTokenSecretName`), at **user** scope (Settings → My tokens;
  `PUT /api/gateway/me/token { token }` stores it and tries it), **team**
  scope (Teams → a team → Tokens) or **global** (admins; Settings → Model
  gateway). `GET /api/gateway/me` says where the viewer stands: the default
  gateway, whether they have a token, the gateway's budget for it (where the
  type reports one), which of their teams have one, whether the organization
  does. A run gets exactly one (`resolveGatewayToken` in
  `services/model-gateway-service.ts`): personal work its owner's, a team's
  work the team's, the organization's work the organization's — and **fails
  with a clear message when it's missing** ("Add your gateway token under
  Settings → My tokens"; "This team has no gateway token yet — a team admin
  adds one under Teams → _team_ → Tokens"; "The organization has no gateway
  token — an admin adds one under Settings → Model gateway"). There is no
  silent fallback to someone else's key, so the gateway's spend ledger stays
  per person.
  Before the run's pod, the **gateway pre-flight** asks the gateway about
  that token (LiteLLM `/key/info`, OpenRouter `/api/v1/key`) and fails the
  run at once when the gateway already refuses it ("Your gateway token is
  over budget until <reset> … — Settings → My tokens"; "… was rejected by
  the gateway …"), and every token is checked on a schedule with warnings
  before it expires ([credential-health.md](credential-health.md)).
  A PR review runs on its asker's token (the organization's for a
  webhook's), or the team's when a team's work opened the PR
  (`reviewOwnerTeam`, `workers/pr-review-worker.ts`). The GitLab token and
  a pod's secrets keep a fallback the gateway token doesn't: a team's work
  tries the team's, then the organization's — never its creator's own
  (`docs/teams.md`).
  A person's or a team's token can be pasted, or made by Optio on the
  gateway ("Get my token", "Create team key"), as the gateway's type and its
  admin allow: see "Keys Optio makes" below.
  `tokenSource: "stored"` instead seals one shared bearer token on the
  provider (`credentials: { type: "bearer-token" }`), for a lab.
  OpenCode takes the same token as `OPENAI_API_KEY` against `<baseUrl>/v1`,
  with the model as `OPTIO_OPENCODE_MODEL`.
  An OpenCode run in a pod never stops to ask: every `opencode.json` Optio
  writes carries a `permission` block (questions denied, paths outside the
  worktree denied except OpenCode's own tool-output directory, `sudo` /
  `apt` / `apt-get` / `dpkg` denied, everything else allowed), a global
  `AGENTS.md` says the same, and `opencode run` gets
  `--dangerously-skip-permissions` (approve what no rule denies). Without
  them OpenCode 1.14 aborts with exit 1 when a tool touches a path outside
  the worktree, such as a venv under `/tmp`
  (`packages/agent-adapters/src/opencode-headless.ts`, the keys of PR
  #585). This holds for every kind of pod run — Repo Tasks, reviews, Job
  runs, persistent agents and interactive sessions: each OpenCode run gets
  its own `opencode.json` (`OPENCODE_CONFIG`) with the block whether or not
  it has MCP servers, and the rules file where no adapter wrote one
  (`apps/api/src/services/opencode-run-setup.ts`).

## Keys Optio makes

Getting a key from the gateway and pasting it is the first wall for a new
person, and a team's spend can't be capped by hand. So a gateway whose type
has managed keys (LiteLLM, OpenRouter, Portkey) can have Optio make the keys
itself, with a budget, an expiry and, on LiteLLM, the catalog's models. Per
gateway, a workspace admin chooses which ways people get a token
(**Settings → Model gateway → the gateway → How people get tokens**; the
organization's gateway, one where each run uses its owner's token):

| Mode             | What people do                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `personalPasted` | Paste a key they got from the gateway: Settings → My tokens, Teams → a team → Tokens (the default, and a gateway saved before modes existed; the only way on a generic gateway) |
| `optioIssued`    | Press **Get my token** (Settings → My tokens) or, as a team admin, **Create team key** (Teams → a team → Tokens): Optio makes the key on the gateway and stores it              |

At least one stays on. With both on, each person chooses: "Get my token"
replaces a pasted token, and a key pasted later replaces the one Optio made
(Optio then deletes its key on the gateway at the next check). With pasting
off, a pasted personal or team token for the gateway is refused on every
way in: `PUT /api/gateway/me/token`, `POST /api/secrets` (user or team
scope, the gateway's token name) and `POST /api/agents/credentials`, with a
400 that says where to press instead. The organization's token stays an
admin's to paste.

### What the admin sets

- **The gateway's admin key**: LiteLLM's master key or a proxy admin's key;
  an OpenRouter management key; a Portkey admin API key. Sealed on the
  gateway row (`model_providers.encrypted_admin_key`, AES-256-GCM with the
  row id in the AAD), never returned, tried against the gateway when saved
  (LiteLLM `/key/list`, OpenRouter `/api/v1/keys`, Portkey `/api-keys`; the
  answer says whether the gateway took it; the key is kept either way).
  Optio uses it only to make, rotate, block, delete and read the keys it
  makes (and, on LiteLLM, its teams), at the type's management API (see
  "Gateway types"), through the same TLS trust as the catalog sync
  (`NODE_EXTRA_CA_CERTS`, `OPTIO_GATEWAY_CA_PEM`). Turning `optioIssued` on
  needs it.
- **A new key's defaults** (`model_providers.key_defaults`): a person's
  budget in USD (`maxBudget`; empty = no cap) and its period
  (`budgetDuration`: `1d`, `7d`, `30d`, `1mo`, …; stored as the nearest
  period the gateway's type takes), the models a key may call (LiteLLM only;
  none = every model in the catalog; only catalog ids are taken), how long a
  key lives (`keyDuration`; none = until rotated or revoked), a team's budget
  and period — what a new team key starts with and the most a team admin may
  set (a workspace admin may set any amount) — and, on Portkey, the
  `workspace` keys are made in.
- **A model the catalog stopped serving** (LiteLLM). When a later sync flags
  a picked model as missing, or it leaves the catalog, the form shows it
  ticked and flagged "no longer served" (`staleModels` in the API's answer).
  Saving other fields still works, and new keys leave it out. If none of the
  picks is served any more, **Get my token** and **Create team key** are
  refused (409) until an admin picks again. Optio won't fall back to every
  model, which would allow more than the admin picked.

`GET` / `PUT /api/model-providers/:id/key-issuing` (workspace admins):
`{ modes, adminKey (write only; null clears it), defaults }`; the answer also
names the `gatewayType` and its `capabilities`. A change is audited as
`model_provider.key_issuing` (the fields, never the key), a budget change as
`budget.set`.

### A person's key

**Get my token** (`POST /api/gateway/me/key`) makes a key named
`optio-<the email's local part>` with the budget, period and expiry, and
`metadata` naming the Optio user, gateway and workspace — on LiteLLM
`POST /key/generate` with `user_id` = the person's email and the models; on
OpenRouter `POST /api/v1/keys`; on Portkey `POST /api-keys/workspace/service`
with the email as `_user`. The key is stored **exactly where a pasted token
goes** (the person's secret named by the gateway, `ANTHROPIC_AUTH_TOKEN` by
default), so runs find it the same way, and is tried (`/v1/models`). Optio
keeps the SHA-256 of the key (`key_hash`, also LiteLLM's id for it) and the
gateway's own id where that differs (`gateway_key_id`: OpenRouter's hash,
Portkey's UUID) in `gateway_issued_keys`, never the value; the API answers
with the alias and the last four characters.

**Rotate** (`POST /api/gateway/me/key/rotate`) makes a new key and deletes
the old one on the gateway. On LiteLLM the old key is renamed
`<alias>-rotated-<time>` first so the new one takes the alias (LiteLLM wants
aliases unique; an alias someone else's key holds gets a 4-character
suffix). On Portkey the same key gets a new value instead (above). Runs
going with the old key stop at their next model call. **Give up**
(`DELETE /api/gateway/me/key`) deletes it on the gateway and removes the
token.
LiteLLM and OpenRouter count a budget per key, and a key's period starts
with the key (LiteLLM) or the calendar (OpenRouter). So a new key **starts
with what the person's earlier keys spent in periods still running**:
LiteLLM takes it as the new key's `spend` (`/key/generate`), OpenRouter as a
lower `limit`. That is the rotated key's spend read live, or a given-up
key's last spend, which Optio reads before deleting it. Each amount carries
only **until its own key's period ends** (`gateway_issued_keys.carried_spend`:
`[{ usd, until }]`). Then the housekeeping check takes it off (LiteLLM:
`/key/update` with `spend`; OpenRouter: the limit back to the budget).
Rotating, or giving a key up and getting another, never starts a budget
over, and spend never piles up across rotations: a rotation every month, or
every day, counts each dollar for the period it was spent in and no longer
(`services/gateway-key-carry.ts`).
`GET /api/gateway/me/key` says which ways the gateway allows, whether Optio
can make a key now, the key it made (alias, last four, budget, expiry, the
spend at the last check, where the gateway reports one), what a new key gets
and the gateway's type. Only the person gets, rotates or gives up their own;
a viewer may not get one.

### A team's key and budget

**Create team key** (`POST /api/gateway/teams/:teamId/key { maxBudget,
budgetDuration }`; the team's admins and workspace admins). On LiteLLM: a
LiteLLM team (`POST /team/new`, alias `optio-<team>`, the budget and models;
made once, reused for the team's later keys and made again if someone
removed it in LiteLLM, on a new key or a rotation) and a key bound to it
(`team_id`, alias `optio-team-<team>`); every key of the LiteLLM team shares
its budget. On OpenRouter and Portkey: one key, alias `optio-team-<team>`,
whose own limit is the team's budget. Either way it is stored as the team's
gateway token, and **the gateway refuses the team's calls once the budget is
spent**, until the period resets. Pressed again, it rotates the key (same
LiteLLM team; on Portkey the same key). `PUT /api/gateway/teams/:teamId/budget`
sets the budget (LiteLLM `/team/update`; elsewhere the key's limit),
`DELETE /api/gateway/teams/:teamId/key` deletes the key (on LiteLLM the
team and its spend stay). `GET /api/gateway/teams/:teamId` is the team's
members' to read (the key's alias, the budget and its spend read live where
the gateway reports it); anyone else gets 404. A team admin's budget is
capped by the gateway's team budget; a workspace admin's isn't. Only a
raise counts: a team admin may always rotate (no budget sent), change only
the period, or lower the budget, even one a workspace admin set above the
cap or left without one. Raising it past the cap is refused (403).

### Keys that should stop working

- **Someone leaves.** Removing a person from the workspace
  (`DELETE /api/workspaces/:id/members/:userId`) blocks the keys Optio made
  them there (LiteLLM `POST /key/block`: the key stops, its spend stays;
  `/key/delete` on a LiteLLM without the route; OpenRouter: disabled;
  Portkey: deleted) and removes their token. Disabling an account
  (`services/offboarding.ts`, the directory sync or a deployment admin)
  calls the same hook for every workspace. Other code can too:

  ```ts
  import { revokeIssuedGatewayKeys } from "./gateway-keys.js";
  // every workspace, or one; never throws; { revoked, failed }
  await revokeIssuedGatewayKeys(userId, { reason: "disabled in the directory" });
  await revokeIssuedGatewayKeys(userId, { workspaceId, reason: "left the workspace", req });
  ```

  Each key revoked is audited as `gateway_key.revoke` with the person as
  `targetUserId`. A key the gateway couldn't be reached for stays active and
  is tried again by the check below.

- **The gateway is deleted.** Its keys are deleted on the gateway first,
  while Optio still holds the admin key. The people's and teams' tokens that
  held them are removed, and each key is audited as `gateway_key.revoke`
  ("gateway removed"). If the gateway can't delete them (unreachable, the
  admin key refused, or none stored), `DELETE /api/model-providers/:id`
  answers **409** saying why, and nothing changes. Settings then asks
  whether to delete it anyway (`?force=true`). The keys then stay on the
  gateway for someone to delete there, and the trail says so ("gateway
  removed; still in <type>").
- **The housekeeping check** (`services/gateway-key-check.ts`, on the
  housekeeping tick, each active key once every
  `OPTIO_GATEWAY_KEY_CHECK_MINUTES`, 10 by default; Helm
  `gatewayKeys.checkMinutes`; a key made in the last two minutes is left
  alone): a person's key whose person was deleted, disabled or is no longer
  in the gateway's workspace is blocked; a key whose token was replaced
  (pasted over, or removed) is deleted, and so is a team's key whose team is
  gone. Only a token that isn't there counts as replaced. A token Optio
  can't read (a database error, or a value that won't decrypt after
  `OPTIO_ENCRYPTION_KEY` changed) is a failed check, tried again next time.
  Deleting a key on the gateway can't be undone. The same check takes a
  key's carried spend off once its period ends (above).

### Budget warnings

Where the gateway reports a key's spend (LiteLLM, OpenRouter), the same
check reads it (LiteLLM `/key/info`, a team's `/team/info`; OpenRouter
`/api/v1/keys/{hash}`) and saves it (shown under My tokens and on the
team). At **80%** of the budget it sends `budget.warning`, at **100%**
`budget.exceeded` (docs/notifications.md), each once per budget period (a
new `budget_reset_at`, or a new budget, starts them over): a person's key
to its owner, a team's to the team's admins. The email says what was spent
of what, when it resets, and that the gateway refuses the runs once it is
spent. A Portkey key's spend isn't readable: Optio sends no warning for it,
and Settings says to use Portkey's own alerts.

### Audit

`gateway_key.issue`, `gateway_key.rotate`, `gateway_key.revoke`,
`team_key.create`, `budget.set` and `model_provider.key_issuing`
(docs/audit.md), with the key's alias, the budget and its period — never a
key. Like tokens, they are admins' reading: a member's Activity feed leaves
them out.

### Database

Migration `1792750000_gateway_keys` (additive): `key_modes`, `key_defaults`
and the sealed admin key (`encrypted_admin_key`, `admin_key_iv`,
`admin_key_auth_tag`) on `model_providers`, and `gateway_issued_keys` (one
row per key made: the gateway, person or team, the secret it is stored as,
the key's hash, alias, last four, models, budget, expiry, status, the
spend, the spend carried from earlier keys and the warnings sent). The
person and team columns go null when they are deleted, so the check still
revokes the key. Migration `1792834600_model_gateway_types` (additive):
`model_providers.gateway_type` (LiteLLM for every gateway saved before it)
and `gateway_issued_keys.gateway_key_id` (the gateway's own id for a key,
when it isn't the hash). Code: `services/gateway-keys.ts`,
`services/gateway-admin.ts` with `litellm-admin.ts`, `openrouter-admin.ts`
and `portkey-admin.ts`, `services/gateway-key-check.ts`,
`services/gateway-key-carry.ts`, `routes/gateway-keys.ts`,
`packages/shared/src/gateway-keys.ts`, `packages/shared/src/model-gateways.ts`;
web `components/settings/gateway-key-issuing.tsx`, `my-gateway-key.tsx`,
`components/teams/team-gateway-key.tsx`, `components/usage/team-usage-panel.tsx`.
Tests run against in-process stand-ins (`test-utils/fake-litellm.ts`,
`fake-openrouter.ts`, `fake-portkey.ts`; `services/gateway-keys.int.test.ts`,
`services/gateway-key-types.int.test.ts`).

## What a Claude Code run gets

From `gatewayRuntime(agent, gateway, pick, token)` in
`packages/shared/src/types/model-provider.ts`, for pods and machines alike
(`podProviderRuntime(row, agent, pick, token)` and `providerLaunch(row,
{ agent, pick, token })` in `services/model-provider-service.ts` call it;
`gatewayModelPick(gateway, agent, agentOptions)` turns the work's
`claudeModel` / `claudeEffort` into the pick — the first served model when
the work names none, and the server refuses a `claudeModel` the gateway
doesn't serve):

| env                                                                                                                                                         | value                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_BASE_URL`                                                                                                                                        | the gateway's `baseUrl`                                                                                                                   |
| `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`)                                                                                                             | the token                                                                                                                                 |
| `ANTHROPIC_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`                                                                                                             | the picked model id                                                                                                                       |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_MODEL` / `_HAIKU_MODEL`                                                                                           | the catalog model with that `role`, else the picked model (so background and "haiku" tasks never ask for an id the gateway doesn't serve) |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS`                                                                                                                             | the model's `maxOutputTokens`                                                                                                             |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`                                                                                         | the model's `contextWindow` (Claude Code assumes 200k for an id it doesn't know; see "Model names")                                       |
| `CLAUDE_CODE_EFFORT_LEVEL`                                                                                                                                  | the picked effort, only when the model's `efforts` include it                                                                             |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | `1` — nothing leaves the network, no pre-release beta headers a gateway would reject                                                      |
| `ANTHROPIC_CUSTOM_HEADERS` (Portkey)                                                                                                                        | `x-portkey-api-key: <token>`, as Portkey's Claude Code guide shows                                                                        |

plus `skipWebFetchPreflight: true` in the settings file (the WebFetch domain
check would call api.anthropic.com), and `--effort` only when the model's
`efforts` include the pick. The `[1m]` context suffix is never added to a
gateway model: the catalog says what the context is.

### Model names

Claude Code reads a model id that starts with `claude-` as one of
Anthropic's and keeps that family's context window: the
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` Optio sets applies only to ids it doesn't
know. Checked with Claude Code 2.1.308 through LiteLLM: `qwen-internal`
with a 32k catalog window ran with 32k; `claude-sonnet-internal`, same
model and catalog, ran with 200k and Sonnet's price guess. So name a
gateway model `claude-…` only when it really is that Claude model; a
smaller model behind such a name overflows instead of compacting. The
gateway editor marks such entries "context not applied". (Optio's usage
and cost always come from the catalog, whatever the name.)

## Catalog sync

`POST /api/model-providers/:id/sync` (admins) reads what the gateway serves
with the organization's token (or the stored one, or the caller's), per its
type (see "Gateway types"), and merges it into the catalog of every agent
the gateway serves. On LiteLLM it reads `/model/info` (and `/v1/models`) at
`syncUrl` (or `baseUrl`): `model_name` → `id`,
`model_info.max_input_tokens` → `contextWindow`, `max_output_tokens`,
`input_cost_per_token × 1e6` → `prices.input`, the output / cache-read /
cache-creation costs likewise; OpenRouter's `/api/v1/models` gives the same
numbers for the ids already listed; a generic gateway's and Portkey's
`/v1/models` give ids (at most 50 new ones per agent). Labels, efforts and
roles are the admin's to set and survive a sync (a new id containing
`claude` gets all five efforts, default `high`). Models the gateway stopped
serving are kept but flagged `missing: true` (and offered with a note); the
row's `lastSyncedAt` records the sync.
`POST /api/model-providers/:id/test { token? }` calls `/v1/models` with the
given token, else the caller's own, and answers `{ ok, modelCount }`.

The API reaches the gateway through undici with the deployment's TLS trust:
the chart's CA bundle is in `NODE_EXTRA_CA_CERTS`; `OPTIO_GATEWAY_CA_PEM`
names a CA for the gateway alone, and `OPTIO_GATEWAY_INSECURE_SKIP_VERIFY=true`
is for a lab with none.

## Usage

Claude Code's `total_cost_usd` is its own guess from the public price list;
it's wrong for an internal name. A pod run's `result` carries `modelUsage`
(tokens per model it actually called); Optio recomputes the cost from the
catalog's prices for each (`costBasis: "estimated"`) and records that, with
the model id as the gateway names it (no `[1m]`). A model without prices
leaves the cost unknown, never zero. The Overview's "Usage limits" panel
shows the gateway's own budget for the viewer's token (`gatewayKeyInfo`:
spend, budget, reset — LiteLLM `/key/info`, OpenRouter `/api/v1/key`; null
on a type that reports none, and the row then says so). The Usage page has
a Teams panel: each team's work, whoever started it, with the team's
gateway budget when Optio made its key (docs/usage.md "Teams").

## On a machine

A spawn on a paired machine (Optio Local, a remote workspace) carries the
gateway env including the person's own token — it is their token going to
their own machine — and its Claude Code reads `claude-gateway.json`, the
daemon's hooks settings plus `skipWebFetchPreflight: true`
(`apps/cli/src/local/agent-command.ts`). With `OPTIO_MODEL_ACCESS=gateway`
the gateway is the one way agents reach their models.
