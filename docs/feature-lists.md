# Deployment feature lists

Optio offers every supported option by default. Administrators can narrow
individual lists without changing sign-in or the other lists. These settings
apply to the API, trigger receivers and web pickers. Signed-in clients can read
the effective configuration at `GET /api/features`.

| Environment variable         | Values                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPTIO_RUNTIMES`             | `claude-code`, `codex`, `copilot`, `cursor`, `gemini`, `openclaw`, `opencode`, `pi`                                                                 |
| `OPTIO_GIT_PLATFORMS`        | `codecommit`, `github`, `gitlab`                                                                                                                    |
| `OPTIO_TRIGGERS`             | `alertmanager`, `datadog`, `github`, `gitlab`, `jira`, `linear`, `manual`, `pagerduty`, `pylon`, `schedule`, `sentry`, `slack`, `ticket`, `webhook` |
| `OPTIO_TICKET_SOURCES`       | `github`, `gitlab`, `jira`, `linear`, `notion`                                                                                                      |
| `OPTIO_CONNECTION_PROVIDERS` | `aws`, `custom-http`, `custom-mcp`, `filesystem`, `github`, `gitlab`, `linear`, `notion`, `pagerduty`, `postgres`, `pylon`, `sentry`, `slack`       |

Use comma-separated values. Whitespace and case are tolerated. An unset or
empty list offers everything. Unknown values are ignored and reported together
in one startup warning; a setting with no recognized values is ignored.
Connections created with workspace-defined providers remain available.

Helm exposes the same settings. Default values render none of the new
environment variables. For example, to offer two runtimes, one git platform,
and selected event sources:

```yaml
features:
  runtimes: [claude-code, opencode]
  gitPlatforms: [gitlab]
  triggers: [gitlab, jira, manual, schedule, ticket, webhook]
  ticketSources: [gitlab, jira]
  connectionProviders: [custom-http, custom-mcp, filesystem, postgres]
```

Every omitted or empty Helm list still offers everything. Set the same
environment variables on separate API and web deployments so the first web
paint agrees with the API. The web confirms the configuration from the API
after sign-in.

## Workspace creation

Anyone signed in may create workspaces by default. Set
OPTIO_WORKSPACE_CREATION=admins to limit creation to deployment administrators.
A deployment administrator can override this in Settings → Access → Workspaces,
or choose “Follow the deployment” to remove the saved override. The server
enforces the policy; hiding the button in the web app is only a convenience.
