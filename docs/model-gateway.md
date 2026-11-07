# Model gateways

A **model gateway** is a model provider (`model_providers` with `kind = "gateway"`)
that agents reach their models through: an Anthropic- / OpenAI-compatible endpoint
with a catalog of the models it serves (the admin's names, context windows,
prices), and a token per person or for the organization. Its **type**
says what it is, and the type decides which of Optio's gateway features it
offers: Settings shows only what the type supports, and the API refuses the
rest, so a feature a type lacks is hidden, never half-run.

## Gateway types

### LiteLLM

A LiteLLM proxy. Its catalog and token-info API answers at the **sync URL** when that is set, else the base URL.

### OpenAI- / Anthropic-compatible

Any endpoint that speaks the Anthropic Messages API for Claude Code and the
OpenAI API (at `<base URL>/v1`) for OpenCode: a base URL and a token, the
catalog's ids from `GET /v1/models` (an Anthropic-style list is read page by
page through `has_more` / `last_id`, with the `anthropic-version` header).
People paste their own tokens; Optio makes no keys and reads no budget, so
the Overview's budget row says the gateway doesn't report one and runs use the configured token.

## Configuration

Settings → Model providers saves the gateway's base URL, agents, auth header,
optional LiteLLM sync URL and catalog. The setup wizard's Model gateway step
creates it and syncs its catalog. An admin chooses the workspace default, or
the organization's first gateway stands in.

`OPTIO_MODEL_ACCESS` (Helm `modelAccess`) decides when work runs through a
gateway:

- `any` (the default): only work that picks a gateway runs through it. Work
  that picks no model provider, a PR review and a session chat reach their
  vendor as before, so adding a gateway never reroutes them.
- `gateway`: gateways are the only provider kind offered; work that picks
  none runs through the default gateway (the New work form shows the same);
  and the API refuses any run that would reach a vendor instead: an agent no
  gateway serves (Codex, Gemini, Copilot, Cursor, pi, OpenClaw), a Bedrock
  pick, or no gateway serving the agent.

## Tokens

A token is the secret `gateway:<providerId>`, never a vendor's env name, so it
can't be read as (or overwrite) the deployment's own `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY`, and a run that doesn't use the gateway never sees it. The
run maps it to the env name the agent CLI reads only at launch (below).

- Settings → My tokens stores your own (`PUT /api/gateway/me/token`, at user
  scope). Your work gets your token only.
- An admin stores the organization's there too (`PUT
/api/model-providers/:id/token`), bound to the gateway's workspace.
  Organization work gets it.
- `tokenSource: stored` instead seals one shared bearer token on the provider.

Each token is stored with its consent: the gateway and the base and sync
URLs it was given for. Every read checks it, so after the gateway's URL
changes its tokens read as missing until they are entered again (a stored
gateway's shared token is asked for with the change). `POST /api/secrets`
refuses `gateway:*` names, and gateway tokens are never pod secrets. A
missing token fails the run with a message saying where to add it.

An earlier build of this feature stored tokens under `ANTHROPIC_AUTH_TOKEN`
/ `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. At boot,
`migrateLegacyGatewayTokens` moves those it wrote (the rows carrying a
gateway consent) to `gateway:<providerId>`; a vendor key without one is
never touched. An organization token saved then through Settings → Secrets
has no consent, so an admin enters it again.

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
| `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY` for an `api-key` gateway)                                                                                    | the token                                                                                                                                 |
| `ANTHROPIC_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`                                                                                                             | the picked model id                                                                                                                       |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_MODEL` / `_HAIKU_MODEL`                                                                                           | the catalog model with that `role`, else the picked model (so background and "haiku" tasks never ask for an id the gateway doesn't serve) |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS`                                                                                                                             | the model's `maxOutputTokens`                                                                                                             |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`                                                                                         | the model's `contextWindow` (Claude Code assumes 200k for an id it doesn't know; see "Model names")                                       |
| `CLAUDE_CODE_EFFORT_LEVEL`                                                                                                                                  | the picked effort, only when the model's `efforts` include it                                                                             |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | `1` — nothing leaves the network, no pre-release beta headers a gateway would reject                                                      |

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
cache-creation costs likewise; a generic gateway's `/v1/models` gives ids. Labels, efforts and
roles are the admin's to set and survive a sync (a new id containing
`claude` gets all five efforts, default `high`). Models the gateway stopped
serving are kept but flagged `missing: true` (and offered with a note); the
row's `lastSyncedAt` records the sync.
Both answers are schema-checked, a body over 4 MB isn't read, and a sync
adds at most 50 models per agent. `POST /api/model-providers/:id/test
{ token? }` calls `/v1/models` with the given token, else the caller's own,
and answers `{ ok, modelCount }`.

The API reaches the gateway through undici with the deployment's TLS trust:
the chart's CA bundle is in `NODE_EXTRA_CA_CERTS`; `OPTIO_GATEWAY_CA_PEM`
names a CA for the gateway alone, and `OPTIO_GATEWAY_INSECURE_SKIP_VERIFY=true`
is for a lab with none.

## Usage

Claude Code's `total_cost_usd` is its own guess from the public price list;
it's wrong for an internal name. For a gateway run Optio recomputes the cost
from the catalog's prices for the model the run reported (per model, when
the agent reports a `modelUsage` split) as `costBasis: "estimated"`, with
the model id as the gateway names it (no `[1m]`). A model without prices
leaves the cost unknown, never zero. The Overview's "Usage limits" panel
shows the gateway's own budget for the viewer's token (`gatewayKeyInfo`:
spend, budget, reset — LiteLLM `/key/info`; null on a type that reports none).

The Claude Code adapter takes a run's token totals and its `modelUsage` split
from the last `result` event, which is cumulative for the process and counts
calls that never appear as assistant events (background Haiku calls). A run
that ended without a result event falls back to the assistant events, counted
once per message id: Claude Code repeats a message's usage on every content
block it streams.

## On a machine

A spawn on a paired machine (Optio Local, a remote workspace) carries the
gateway env including the person's own token — it is their token going to
their own machine — and its Claude Code reads `claude-gateway.json`, the
daemon's hooks settings plus `skipWebFetchPreflight: true`
(`apps/cli/src/local/agent-command.ts`). A spawn that picks no gateway
uses the machine's own sign-ins: `OPTIO_MODEL_ACCESS=gateway` governs the
runs Optio starts in pods.
