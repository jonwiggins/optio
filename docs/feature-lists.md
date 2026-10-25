# Deployment feature lists

Optio offers every supported option by default. Administrators can narrow
individual lists without changing sign-in or the other lists. These settings
apply to the API, trigger receivers and web pickers. Signed-in clients can read
the effective configuration at `GET /api/features`.

| Environment variable         | Values                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPTIO_RUNTIMES`             | `claude-code`, `codex`, `copilot`, `cursor`, `gemini`, `openclaw`, `opencode`                                                                       |
| `OPTIO_GIT_PLATFORMS`        | `codecommit`, `github`, `gitlab`                                                                                                                    |
| `OPTIO_TRIGGERS`             | `alertmanager`, `datadog`, `github`, `gitlab`, `jira`, `linear`, `manual`, `pagerduty`, `pylon`, `schedule`, `sentry`, `slack`, `ticket`, `webhook` |
| `OPTIO_TICKET_SOURCES`       | `github`, `gitlab`, `jira`, `linear`, `notion`                                                                                                      |
| `OPTIO_CONNECTION_PROVIDERS` | `aws`, `custom-http`, `custom-mcp`, `filesystem`, `github`, `linear`, `notion`, `pagerduty`, `postgres`, `pylon`, `sentry`, `slack`                 |

Use comma-separated values. Whitespace and case are tolerated. An unset or
empty list offers everything. Unknown values are ignored and reported together
in one startup warning; a setting with no recognized values is ignored.
Connections created with workspace-defined providers remain available.

The switches are independent of the lists:

- `OPTIO_MODEL_ACCESS=any` (default) offers vendor credentials, Bedrock and model
  gateways. `gateway` offers gateways alone. Gateway runs use their catalog's
  prices in either mode.
- `OPTIO_AGENT_POLICY_DEFAULTS=false` (default) adds no built-in deny rules.
  `true` enables them where the workspace has not chosen an explicit policy.
  See [Agent policy](agent-policy.md).

Helm exposes the same settings. Default values render none of the new
environment variables. For example, to offer two runtimes, one git platform,
selected event sources and gateways:

```yaml
features:
  runtimes: [claude-code, opencode]
  gitPlatforms: [gitlab]
  triggers: [gitlab, jira, manual, schedule, ticket, webhook]
  ticketSources: [gitlab, jira]
  connectionProviders: [custom-http, custom-mcp, filesystem, postgres]
modelAccess: gateway
agentPolicy:
  builtInRules: true
```

Every omitted or empty Helm list still offers everything. Set the same
environment variables on separate API and web deployments so the first web
paint agrees with the API. The web confirms the configuration from the API
after sign-in.

For an environment-only convenience, `OPTIO_FEATURE_PRESET=minimal` fills
unspecified lists with Claude Code and OpenCode; GitLab; Alertmanager, GitLab,
Jira, manual, schedule, Sentry, ticket and webhook triggers; GitLab and Jira
tickets; and custom HTTP, custom MCP, Filesystem and PostgreSQL connections.
Explicit nonempty lists override the preset. The preset leaves both switches
at their defaults.

Image composition is separate: `images/base.Dockerfile` installs every agent
CLI by default (`AGENT_CLIS=all`), or only those a comma list names, such as
`AGENT_CLIS=claude-code,opencode`; glab and the GitHub and AWS tools stay.
`PREINSTALL_MCP_SERVERS=1` installs the pinned MCP servers either way
([air-gapped.md](air-gapped.md#image-build-arguments)). Choose feature lists that match
the tools installed in your agent images. `OPTIO_MCP_PREINSTALLED` selects
preinstalled MCP binaries explicitly; unset uses the normal `npx` commands.
