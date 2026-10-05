# Connections

A **Connection** is a named account at a service — "Jon's AWS", "Acme Linear", "Support Pylon" — that a piece of work can be connected to. A connection is made of **parts**, and a user picks the logo, not the parts:

| Part            | What the agent gets                                                       | Where it comes from                                                                                        |
| --------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **credentials** | The service's token or keys, encrypted at rest, never returned by the API | The provider's `configSchema` properties with `format: "secret"`                                           |
| **tools**       | An MCP server (`.mcp.json`; `$CODEX_HOME/config.toml` for Codex)          | The provider's `mcpConfig` (`command`, `args`, `envMapping`, templated `env`, optional `enabledBy` switch) |
| **env**         | Vars exported into the agent's own shell, so CLIs and SDKs are signed in  | The provider's `shellEnv` (`{{key}}` templates); a connection can switch it off (`exportShellEnv`)         |
| **note**        | A skill file telling the agent how to use the service                     | The provider's `note` → `.claude/skills/connection-<slug>/SKILL.md`                                        |

Bare **secrets** (rows of `secrets`) and hand-written **MCP servers** (`mcp_servers`) are connections too — "credentials only" and "tools only" — and appear in the same list. Storage stays three tables; the **catalog** (`GET /api/connections/catalog`, and `catalog` in `GET /api/work/environment`) projects them onto one shape, `WorkEnvironmentEntry`, whose `kind` says which setting a toggle changes: `connection` → `settings.connections`, `mcpServer` → `settings.mcpServers`, `secret` → `podSecrets`. Deployment secrets (identity tokens, Optio's own settings, git and cloud sign-in: `isDeploymentSecret` in `secret-service.ts`) are not things work connects to and are left out of the catalog; `GET /api/secrets?deployment=1` lists them for Settings.

## Providers

`BUILT_IN_PROVIDERS` in `services/connection-service.ts` is the catalog (seeded at boot, re-seeded on every start so manifest changes land). Besides the long-standing Notion, GitHub, Slack, Linear, PostgreSQL, Sentry, and Filesystem:

- **AWS** — keys (or none, for the pod's own IAM role) exported as shell env; `AWS_TOOLS` also runs `awslabs.aws-api-mcp-server` through `uvx` (python / full images only); health check = STS `GetCallerIdentity`.
- **Pylon** — a REST API token on the **REST bridge** (below), US or EU host; health check `GET /me`.
- **PagerDuty** — a REST API key on the bridge with PagerDuty's `Accept` header; health check `GET /abilities`.
- **HTTP API** (`custom-http`) — any REST API on the bridge, with bearer / API-key / no auth.
- **Custom MCP Server** (`custom-mcp`) — command, args (one per line), `KEY=VALUE` env lines (`${{NAME}}` refers to a stored secret), install command.

A provider's templates (`mcpConfig.env`, `shellEnv`, `healthCheck`) use `{{key}}` placeholders over the connection's values; `{{name}}` is the connection's name. A var whose template is only placeholders that rendered empty is left out (blank AWS keys → the pod's role). Env names must be valid shell identifiers and never reserved (`OPTIO_*`, `PATH`, `HOME`, `CODEX_HOME`, `LD_*`, the identity tokens: `isReservedPodEnvName` in `utils/pod-env.ts`), checked at provider creation and by a unit test over the built-ins.

## Credentials

Secret fields are split out of the plain `config` jsonb at write time (`splitConfig`) and sealed on the row with AES-256-GCM (`secret_config`, AAD `connection|<id>`), the way model-provider credentials are. The API returns `config` **without** them and names them in `secretFields`; nothing can round-trip a masked sentinel. `PATCH /api/connections/:id` **merges**: a secret field omitted or empty keeps its value, `null` clears it, a `${{NAME}}` reference replaces a stored value with a pointer into `secrets`. Connections created before v2 keep plaintext values in `config` until the boot heal `sealPlaintextConnectionSecrets` moves them (idempotent); the row mapper never returns a plaintext secret field in the meantime.

Resolution order for a template key or `envMapping` entry (`connectionValue` in `agent-environment-service.ts`): the sealed value → a `${{NAME}}` reference resolved through the secret store (repo scope, then global, through the owner / workspace fallback) → the plain config value → the form's default → (for `envMapping` only) a stored secret named like the key. A PR-review pod (`connectionSecrets: false`) resolves nothing secret and gets no shell env.

## What reaches the pod

`buildAgentEnvironment` writes `.mcp.json` (marked sensitive, mode 600, when any entry carries env), the Codex TOML, and the note skill files, and sets the install commands. `connectionShellEnv` is a separate call the workers spread **last** into the pod env, so a connection's `AWS_*` beats the deployment's CodeCommit keys for that work. The exec scripts export every env var as a single-quoted `export` line (`buildEnvExports`).

## The REST bridge

`packages/mcp-bridge` is a small stdio MCP server bundled to one file and baked into the agent images at `/opt/optio/mcp-bridge.js`. It proxies one token-authenticated REST API: tools `describe` and `request { method, path, query?, headers?, body? }`, with the path pinned to the base URL's origin and prefix, bodies ≤ 1 MiB, responses ≤ 2 MiB (truncated flag), a 30 s timeout, no redirects, and the auth header never overridable nor echoed. Env contract: `OPTIO_HTTP_NAME`, `OPTIO_HTTP_DESCRIPTION`, `OPTIO_HTTP_BASE_URL`, `OPTIO_HTTP_AUTH_HEADER` (default `Authorization`), `OPTIO_HTTP_AUTH_VALUE` (the full value) or `OPTIO_HTTP_AUTH_SCHEME` + `OPTIO_HTTP_AUTH_TOKEN` (`bearer` / `api-key` / `none`), `OPTIO_HTTP_EXTRA_HEADERS` (JSON).

## Testing

A connection's health check runs server-side (`POST /api/connections/:id/test`: admins for the organization's, owners for their own) with a 10 s timeout and records `status`, `statusMessage`, `lastCheckedAt`; a provider without one leaves the status `unknown`. Messages never include response bodies or header values.

Tiers: unit (`connection-service.test.ts` manifests, `connection-template.test.ts`, `connection-health.test.ts`, the bridge's own tests), integration (`connection-secrets.int.test.ts`, `connection-catalog.int.test.ts`, `agent-environment-service.int.test.ts`), pipeline e2e (`apps/api/e2e/connections.e2e.test.ts`: the fake runtime's `[[mock:file:PATH]]` and `[[mock:env:NAME]]` directives show what a pod would get).
