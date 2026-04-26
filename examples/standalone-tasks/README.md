# Standalone Tasks — examples

Single-shot agents with no repo checkout. They produce logs and side effects:
querying Slack, posting to a database, sending a digest, calling an MCP server.
See [../../docs/tasks.md](../../docs/tasks.md) for the underlying model.

> Examples coming. The shape will be:
>
> ```
> my-example/
> ├── README.md
> ├── workflow.json   # body of POST /api/jobs (Standalone Task definition)
> ├── triggers.json   # optional — schedule / webhook trigger config
> └── setup.sh
> ```
>
> Good candidates to write next:
>
> - **`daily-digest`** — schedule trigger (9am weekdays); summarizes yesterday's
>   merged PRs and open issues across connected repos, posts to Slack.
> - **`cost-watchdog`** — schedule trigger (hourly); checks Anthropic / OpenAI
>   spend via the provider APIs, alerts if today's burn exceeds threshold.
> - **`incident-responder`** — webhook trigger from PagerDuty / Sentry; pulls
>   the relevant traces, queries the codebase via an MCP server, posts a
>   first-pass diagnosis to the incident channel.

Open a PR if you'd like to contribute one.
