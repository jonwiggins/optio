# Observability Guide

Optio ships with first-class OpenTelemetry (OTel) support for exporting **traces**, **metrics**, and **high-signal logs** to any OTLP-compatible backend.

Optio can also serve its metrics as a Prometheus endpoint on its own port (`OPTIO_METRICS_PORT`, chart `metrics.*`, off by default), with more series of its own, a ServiceMonitor, alert rules and a Grafana dashboard: [Prometheus endpoint and dashboard](#prometheus-endpoint-and-dashboard).

## Quick Start

Set `OPTIO_OTEL_ENABLED=true` and point the OTLP exporter at your backend:

```bash
# Helm values
helm upgrade optio helm/optio -n optio --reuse-values \
  --set observability.otel.enabled=true \
  --set observability.otel.endpoint="https://your-backend:4318"
```

Or via environment variables directly:

```bash
OPTIO_OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-backend:4318
```

## Configuration Reference

| Env var                          | Helm value                              | Default                 | Description                                             |
| -------------------------------- | --------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `OPTIO_OTEL_ENABLED`             | `observability.otel.enabled`            | `false`                 | Master switch. When false, no OTel packages are loaded. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`    | `observability.otel.endpoint`           | `http://localhost:4318` | OTLP receiver endpoint                                  |
| `OTEL_EXPORTER_OTLP_PROTOCOL`    | `observability.otel.protocol`           | `http/protobuf`         | Protocol: `http/protobuf`, `http/json`, or `grpc`       |
| `OTEL_EXPORTER_OTLP_HEADERS`     | `observability.otel.headers`            | _(empty)_               | Auth headers as `key=value,key=value`                   |
| `OTEL_SERVICE_NAME`              | `observability.otel.serviceName`        | `optio-api`             | Service name in traces                                  |
| `OTEL_RESOURCE_ATTRIBUTES`       | `observability.otel.resourceAttributes` | _(empty)_               | Extra resource attributes                               |
| `OPTIO_OTEL_SAMPLING_RATIO`      | `observability.otel.samplingRatio`      | `1.0`                   | Head-based sampling ratio (0.0-1.0)                     |
| `OPTIO_OTEL_METRICS_INTERVAL_MS` | `observability.otel.metricsIntervalMs`  | `60000`                 | Metric export interval in milliseconds                  |
| `OPTIO_OTEL_LOGS_ENABLED`        | `observability.otel.logsEnabled`        | `false`                 | Enable OTel log export for high-signal events           |
| `OPTIO_OTEL_DEBUG`               | `observability.otel.debug`              | `false`                 | Enable OTel diagnostic logging                          |

## What Gets Instrumented

### Auto-instrumentation (zero code changes)

- **Inbound HTTP** (Fastify): every API request becomes a root span with route, status, duration
- **Outbound HTTP** (undici/fetch): GitHub API, Linear, Jira, Slack, webhook calls
- **PostgreSQL**: all database queries (via `pg` instrumentation)
- **Redis/ioredis**: BullMQ job operations, pub/sub, caching

### Custom Spans

| Span name                          | Description                                                 |
| ---------------------------------- | ----------------------------------------------------------- |
| `task.lifecycle`                   | Root span for a task execution attempt (queued to terminal) |
| `task.dependency_check`            | Dependency resolution before task start                     |
| `task.provision.pod_get_or_create` | Pod scheduling and provisioning                             |
| `task.provision.pod_wait_ready`    | Waiting for pod to become ready                             |
| `task.exec.start`                  | Agent process startup                                       |
| `task.exec.stream`                 | Agent output streaming                                      |
| `task.parse_result`                | Result parsing and cost extraction                          |
| `task.cleanup`                     | Worktree cleanup                                            |
| `pr_watch.cycle`                   | One complete PR watcher polling cycle                       |
| `pr_watch.task`                    | Per-task PR status check                                    |
| `k8s.pod.create`                   | Kubernetes pod creation                                     |
| `k8s.pod.exec`                     | Command execution in pod                                    |
| `k8s.pod.delete`                   | Pod deletion                                                |
| `repo_cleanup.cycle`               | Repo cleanup worker cycle                                   |
| `webhook.deliver`                  | Webhook delivery attempt                                    |
| `schedule.check_cycle`             | Schedule worker check cycle                                 |
| `ticket_sync.cycle`                | Ticket sync worker cycle                                    |

### Custom Metrics

| Metric                                  | Type      | Labels                                             |
| --------------------------------------- | --------- | -------------------------------------------------- |
| `optio_tasks_total`                     | Counter   | `state`, `agent_type`, `repo`, `workspace_id`      |
| `optio_task_duration_seconds`           | Histogram | `terminal_state`, `agent_type`, `task_type`        |
| `optio_task_cost_usd`                   | Histogram | `agent_type`, `model`, `task_type`, `workspace_id` |
| `optio_task_tokens`                     | Histogram | `agent_type`, `direction`                          |
| `optio_queue_depth`                     | Gauge     | `state`                                            |
| `optio_active_tasks`                    | Gauge     | _(none)_                                           |
| `optio_pod_count`                       | Gauge     | `repo`, `state`                                    |
| `optio_pr_watch_cycle_duration_seconds` | Histogram | _(none)_                                           |
| `optio_state_transitions_total`         | Counter   | `from`, `to`, `trigger`                            |
| `optio_worker_job_duration_seconds`     | Histogram | `worker`, `success`                                |
| `optio_pod_health_events_total`         | Counter   | `event_type`, `repo`                               |
| `optio_webhook_deliveries_total`        | Counter   | `event`, `success`                                 |

### High-Signal OTel Logs

When `OPTIO_OTEL_LOGS_ENABLED=true`, these events are emitted as OTel log records (with trace context for correlation):

- `task.state_transition` - task state changes
- `task.cost_report` - cost and token usage on task completion
- `pod.health_event` - pod crashes, OOM kills, restarts
- `auth.failure` - authentication failures
- `webhook.delivery_failure` - failed webhook deliveries

## Trace Context Propagation

- **HTTP**: W3C Trace Context (`traceparent` header) propagated automatically
- **BullMQ jobs**: Trace context injected into job data at enqueue time and extracted in workers
- **WebSocket events**: `traceId` field attached to published events for frontend correlation

## Sensitive Data Protection

Optio enforces a strict whitelist on span attributes. The following **never** appear in telemetry:

- Task prompts, descriptions, or agent output
- Secret values (API keys, OAuth tokens)
- Repository contents or file paths
- User PII (email, display name) - only `user.id` is used
- GitHub tokens or URLs with embedded credentials

Error messages are run through the error classifier before recording, exposing only the category and title (never raw messages).

## Backend-Specific Setup

### Datadog

```yaml
# Helm values
observability:
  otel:
    enabled: true
    endpoint: "https://http-intake.logs.datadoghq.com:443"
    protocol: "http/protobuf"
    headers: "DD-API-KEY=your-api-key"
    resourceAttributes: "deployment.environment=production"
```

Alternatively, deploy the [Datadog Agent with OTLP ingestion](https://docs.datadoghq.com/opentelemetry/otlp_ingest_in_the_agent/) as a DaemonSet and point to it:

```yaml
observability:
  otel:
    enabled: true
    endpoint: "http://datadog-agent:4318"
```

### Honeycomb

```yaml
observability:
  otel:
    enabled: true
    endpoint: "https://api.honeycomb.io:443"
    headers: "x-honeycomb-team=your-api-key"
```

### Grafana Cloud (Tempo + Mimir + Loki)

```yaml
observability:
  otel:
    enabled: true
    endpoint: "https://otlp-gateway-prod-us-central-0.grafana.net/otlp"
    headers: "Authorization=Basic base64(instanceId:apiKey)"
    logsEnabled: true # Ships high-signal logs to Loki
```

### Local OTel Collector

For development or multi-backend routing, run an [OTel Collector](https://opentelemetry.io/docs/collector/):

```yaml
# docker-compose.yaml or K8s deployment
otel-collector:
  image: otel/opentelemetry-collector-contrib:0.96.0
  ports:
    - "4317:4317" # gRPC
    - "4318:4318" # HTTP
```

```yaml
# Helm values
observability:
  otel:
    enabled: true
    endpoint: "http://otel-collector:4318"
```

## Resource Impact

When OTel is enabled, expect approximately:

- **Memory**: +20-40 MB RSS for the SDK, exporters, and batch processors
- **CPU**: Negligible under normal load; batch processors amortize export cost
- **Network**: Depends on trace volume. At default sampling (1.0) with 5 concurrent tasks, expect ~1-5 MB/min of OTLP data

When disabled (`OPTIO_OTEL_ENABLED=false`), there is **zero runtime cost** - no OTel packages are loaded, and all metric/span calls are no-ops.

## Recommended Setup

For most production deployments:

1. **Traces + metrics**: via OTLP export to your preferred backend
2. **Application logs**: via stdout + Fluent Bit / Vector (already works with standard K8s log collection)
3. **High-signal OTel logs**: optionally enable for state transitions, cost reports, and health events

This avoids duplicating all pino output through OTel while still getting trace-correlated logs for the most important events.

## Verifying the Setup

1. Check the health endpoint:

   ```bash
   curl http://localhost:4000/api/health | jq .otelEnabled
   # Should return: true
   ```

2. Create a task and look for traces in your backend with service name `optio-api`

3. Check for the `task.lifecycle` root span which covers the full task execution

4. Verify metrics by searching for `optio_tasks_total` or `optio_task_duration_seconds`

## Troubleshooting

- **No traces appearing**: Check `OTEL_EXPORTER_OTLP_ENDPOINT` is reachable from the API pod. Enable `OPTIO_OTEL_DEBUG=true` for diagnostic output.
- **Missing auth headers**: Ensure `OTEL_EXPORTER_OTLP_HEADERS` is formatted as `key=value,key=value` (no spaces around `=`).
- **High memory usage**: Reduce `OPTIO_OTEL_SAMPLING_RATIO` to `0.1` for high-volume deployments.
- **Spans not correlating**: Verify trace context propagation by checking for `traceparent` headers in outbound requests.

## Prometheus endpoint and dashboard

The Prometheus endpoint is optional (`metrics.enabled=false`). It runs on its
own ClusterIP service, never the public ingress. Choose the namespace of the
Prometheus instance that may read it; no monitoring vendor is assumed:

```yaml
networkPolicy:
  enabled: true
metrics:
  enabled: true
  networkPolicy:
    namespaces: [monitoring]
  serviceMonitor:
    enabled: true
  prometheusRule:
    enabled: true
  grafanaDashboard:
    enabled: true
    namespace: monitoring
```

Install Prometheus Operator CRDs before enabling ServiceMonitor or
PrometheusRule. For a manually configured scrape, leave ServiceMonitor off
and set `metrics.prometheusRule.job` to its job label. Choose the namespace
watched by your Grafana dashboard sidecar. Both namespace settings are empty
by default; enabling monitoring without an explicit audience or enabling the
dashboard without a namespace fails rendering with a configuration message.
Rancher Monitoring can use `cattle-monitoring-system` and `cattle-dashboards`
respectively, according to its installation configuration.

The endpoint covers all workspaces, including team names, spend and repository
URLs, and has no sign-in. Enable NetworkPolicy or restrict its audience with
your cluster policies. `metrics.networkPolicy.from` accepts explicit peers;
setting `metrics.networkPolicy.enabled=false` delegates this to your policies.
Use `kubectl port-forward svc/optio-api-metrics 9464:9464` and request
`http://localhost:9464/metrics` to check it.

### What it measures

The database gauges are read every 30 s by every API replica (the spend
every 5 minutes), so each replica reports the same values: take `max` over
them. The counters and the histogram are each replica's own: `sum` them.
Upstream's metrics (`optio_queue_depth`, `optio_state_transitions_total`,
`optio_webhook_deliveries_total`, the task and worker histograms, …) are on
the same endpoint; [Custom Metrics](#custom-metrics) lists them.
Its task series and pod health events carry the repository URL (`repo_url`,
`repo`). HTTP server metrics come from OpenTelemetry's auto-instrumentation,
which runs only with `observability.otel` on: without it the endpoint has none.

| Series                                        | Type      | Labels                                                                          | What                                                                                                                                         |
| --------------------------------------------- | --------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `optio_runs`                                  | gauge     | `kind` (`repo`: Tasks, `standalone`: Job runs), `state`                         | Runs in each state a run is still in: pending, waiting on dependencies, queued, provisioning, running, needs attention, MR open              |
| `optio_run_oldest_seconds`                    | gauge     | `kind`, `state` (`queued`, `provisioning`)                                      | How long the oldest run has been in that state (off-peak holds aside, below)                                                                 |
| `optio_runs_finished_total`                   | counter   | `kind`, `state` (`completed`, `failed`, `cancelled`)                            | Runs that ended                                                                                                                              |
| `optio_agent_pods`                            | gauge     | `pool` (`repo`, `standalone`, `persistent-agent`), `state`                      | Agent pods by state                                                                                                                          |
| `optio_agent_pod_oldest_provisioning_seconds` | gauge     | `pool`                                                                          | How long the oldest pod still provisioning has been at it                                                                                    |
| `optio_credentials`                           | gauge     | `kind` (`gitlab`, `gateway`, `jira`, `remote_workspace`), `scope`, `status`     | Settings → System health's rows: `ok`, `warning`, `error` (refused), `unknown`                                                               |
| `optio_credentials_expiring`                  | gauge     | `kind`, `scope`                                                                 | Credentials that expire within 7 days and haven't yet                                                                                        |
| `optio_gateway_errors_total`                  | counter   | `status`, `model`, `owner` (`organization`, `team`, `person`), `team`, `source` | The gateway refusing a run's token: the pre-flight before its pod (`preflight`), or a run that failed on it (`run`, from `API Error: 429 …`) |
| `optio_gateway_spend_usd`                     | gauge     | `workspace`, `owner`, `team`, `model`                                           | This calendar month's (UTC) spend, priced from the gateway's catalog (the usage ledger)                                                      |
| `optio_gitlab_api_errors_total`               | counter   | `host`, `status`                                                                | GitLab answers other than 2xx to Optio's merge-request, pipeline and repository reads and writes                                             |
| `optio_ticket_provider_consecutive_failures`  | gauge     | `provider_id`, `source`, `host`, `enabled`                                      | Each ticket provider's failed syncs in a row (Optio turns it off at 5)                                                                       |
| `optio_ticket_sync_failures_total`            | counter   | `source`                                                                        | Failed ticket syncs                                                                                                                          |
| `optio_ticket_writebacks_open`                | gauge     | `source`, `status` (`pending`, `failed`)                                        | The ticket round trip's comments, links and statuses not yet sent ([ticket-round-trip.md](ticket-round-trip.md))                             |
| `optio_sign_in_failures_total`                | counter   | `provider` (`oidc`, `ldap`), `reason`                                           | Refused sign-ins, as the Audit page records them (never the name tried)                                                                      |
| `optio_remote_workspaces_starting`            | gauge     | `provider`                                                                      | Remote workspaces Optio started that aren't online yet                                                                                       |
| `optio_remote_workspace_start_wait_seconds`   | gauge     | `provider`                                                                      | How long the longest of them has been coming up                                                                                              |
| `optio_remote_workspace_start_failures_total` | counter   | `provider`                                                                      | Remote workspace starts that failed or didn't come online in time                                                                            |
| `optio_remote_workspace_start_seconds`        | histogram | `provider`                                                                      | How long each remote workspace Optio started took to come online (its daemon's first hello); buckets from 15 s to 30 min                     |
| `optio_metrics_refreshed_timestamp_seconds`   | gauge     |                                                                                 | When the API last read the gauges from its database                                                                                          |

A team is shown by its name; Optio's own series never name a person
(`owner="person"`). Upstream's repository URLs can (above).

- A queued run whose repo has **Off-peak only** waits on purpose through
  peak hours: `optio_run_oldest_seconds{state="queued"}` leaves it out
  then, and counts it from the off-peak window's opening once that has come
  (the worker stamped it when it held it, hours before).
- The pre-flight counts what a refusal means, as `OptioGatewayRefusing`
  reads it: a spent budget as `429`, a wrong, blocked or expired token as
  the gateway's `401` / `403`, or `401` when `/key/info` said so with a
  `200` or LiteLLM's `400 expired_key`.

### The alerts

`metrics.prometheusRule.enabled` installs these, each on the release's
namespace and labelled `namespace="<it>"` and `severity`, plus
`metrics.prometheusRule.alertLabels`. `metrics.prometheusRule.thresholds`
sets the numbers, `disabled` leaves alerts out, `additionalRules` adds yours.
They need the ServiceMonitor (`metrics.serviceMonitor.enabled`) or, with
your own scrape, `metrics.prometheusRule.job`.

| Alert                           | Fires when (default)                                                                    | Look at                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `OptioDown` (critical)          | Prometheus scraped no API pod (`up` of the job) for 5 min                               | `kubectl -n optio get pods -l app=optio-api`, the api container's log                           |
| `OptioMetricsStale`             | The API hasn't read its database for 5 min                                              | PostgreSQL; the API log's `site metrics` lines                                                  |
| `OptioQueueStuck`               | The oldest queued run waited 30 min (`queueStuckMinutes`; off-peak holds aside)         | Concurrency limits, a budget that pauses new work (Usage), pod capacity                         |
| `OptioRunsStuckProvisioning`    | A run waited 15 min for its pod (`provisioningStuckMinutes`)                            | Pending or `ImagePullBackOff` pods, the registry, node capacity                                 |
| `OptioPodsStuckProvisioning`    | An agent pod provisioning for 15 min                                                    | `kubectl -n optio get pods -l optio.type` and their events                                      |
| `OptioRunFailureRate`           | Over half (`failureRatio`) of at least 5 (`failureMinRuns`) runs ended in 30 min failed | The failures' titles on `/work?view=history`                                                    |
| `OptioWebhookDeliveriesFailing` | More than 5 outbound webhook deliveries failed in 15 min (`webhookFailures`)            | Settings → Webhooks → the hook's deliveries                                                     |
| `OptioGatewayRefusing`          | More than 5 gateway 401 / 403 / 429 in 15 min (`gatewayErrors`)                         | 401 / 403: Settings → System health names the token; 429: LiteLLM's rate limit or budget        |
| `OptioGitLabErrors`             | More than 10 GitLab 401 / 403 / 5xx in 15 min (`gitlabErrors`)                          | The GitLab token's expiry and role (System health); GitLab itself                               |
| `OptioTicketProviderFailing`    | A ticket provider failed 3 syncs in a row (`ticketProviderFailures`)                    | Settings → Tickets: its error and **Test**                                                      |
| `OptioCredentialsExpiring`      | A credential expires within 7 days                                                      | Settings → System health (its owner was emailed)                                                |
| `OptioCredentialsFailing`       | A credential is refused for 15 min                                                      | Settings → System health                                                                        |
| `OptioSignInFailures`           | More than 20 refused sign-ins in 15 min, per provider and reason (`signInFailures`)     | `provider_error`: the IdP or directory; `invalid_credentials`: someone guessing. The Audit page |
| `OptioRemoteWorkspaceStartSlow` | A remote workspace isn't online after 15 min (`remoteWorkspaceStartMinutes`)            | The workspace at its provider (its build, its start script's `/tmp/optio-local.log`)            |

Rancher's Alertmanager routes them like its other alerts. A route to the
platform team's mail, matched on the namespace:

```yaml
route:
  routes:
    - matchers: ['namespace="optio"', 'alertname=~"Optio.*"']
      receiver: platform-mail
```

### The dashboard

**Monitoring → Grafana → Dashboards → Optio · optio** (named after its
namespace; `uid` `optio-<namespace>`): runs by state and the longest
waits, runs ending per hour, agent pods, gateway refusals, GitLab errors,
webhook deliveries, ticket syncs, refused sign-ins, credentials by status,
this month's spend by team and model, remote workspace starts and how long they take.
It opens on its own namespace; **Namespace** switches to another
environment. Each release that turns it on gets its own (its ConfigMap
`optio-dashboard-<namespace>`, file, `uid` and title), so test and staging
on one cluster don't overwrite each other's, and uninstalling one leaves
the other's. It is the chart's
`dashboards/optio.json`; a copy you edit in Grafana is yours (save it under
another name: the ConfigMap's copy is put back on every upgrade).

### Alerts that start work: Alertmanager, Grafana Alerting, Sentry

The `alertmanager` and `sentry` triggers are offered by default, and the
`minimal` feature preset keeps them (`packages/shared/src/config/features.ts`,
[feature-lists.md](feature-lists.md)): both can run inside a closed network
and their receivers only accept deliveries. A firing alert can start a Job,
a scheduled Task, a persistent agent's turn or an automation on a machine.

1. **In Optio**: New work → **When: Alertmanager**, with the filters you
   want (firing / resolved, alert names, severities, receivers). Create it,
   then copy its URL, `https://optio.example.com/api/hooks/alertmanager/<trigger id>`,
   and its secret: it is shown this once. The prompt takes the alert as
   `{{alertnames}}`, `{{status}}`, `{{severities}}`, `{{labels}}`,
   `{{annotations}}`, `{{message}}`, `{{externalUrl}}`, `{{alerts}}`.
2. **In Alertmanager** (the `alertmanager.yaml` Rancher Monitoring keeps in
   its Secret, or Monitoring → Alerting → Routes and Receivers):

   ```yaml
   receivers:
     - name: optio-fix-it
       webhook_configs:
         - url: https://optio.example.com/api/hooks/alertmanager/<trigger id>
           send_resolved: false
           http_config:
             authorization: { type: Bearer, credentials: <the trigger's secret> }
             tls_config: { ca_file: /etc/alertmanager/secrets/private-ca/ca.crt }
   route:
     routes:
       - matchers: ['alertname="CheckoutErrorRate"']
         receiver: optio-fix-it
         continue: true # its other receivers still get it
   ```

   The CA file is the deployment's CA from a Secret (here `private-ca`) that
   Rancher Monitoring mounts into Alertmanager: list it under the
   rancher-monitoring chart's `alertmanager.alertmanagerSpec.secrets`
   (mounted at `/etc/alertmanager/secrets/<name>/`).
   With an `AlertmanagerConfig` (monitoring.coreos.com/v1alpha1) the secret
   and CA come from Secrets in its namespace (`httpConfig.authorization.credentials`,
   `httpConfig.tlsConfig.ca`), and the operator matches only alerts whose
   `namespace` label is that namespace. Alertmanager in the same cluster can
   call the API's Service instead of the ingress:
   `http://optio-api.optio.svc:4000/api/hooks/alertmanager/<trigger id>`
   (no TLS, so no CA).

3. **In Grafana Alerting**: Contact points → New → **Webhook**, URL as
   above, HTTP method POST, and under Optional settings the authorization
   header (scheme `Bearer`, credentials the secret) or basic auth with any
   user name and the secret as the password. Grafana must trust the deployment's
   CA for the ingress URL. Point a notification policy at it. **Test** sends
   an alert named `TestAlert`: give the trigger no alert-name filter while
   you try it.

A delivery without the secret gets 401; one the filters don't match gets
202 with `matched: false` and starts nothing.

**Self-hosted Sentry**: an internal integration (Settings → Developer
Settings) with its webhook URL `https://optio.example.com/api/webhooks/sentry`
and the issue / alert resources; its Client Secret goes into the chart's
`webhook.sentrySecret` (`SENTRY_WEBHOOK_SECRET`). Then **When: Sentry** on
any work. Sentry as a _connection_ (its MCP server, for agents to read
issues) is not in the `minimal` preset: the built-in one starts with
`npx -y @sentry/mcp-server` (a download on every run) and has no field for
your Sentry's address. Agents can still read a self-hosted Sentry through a
Custom MCP connection installed from your mirror
([air-gapped.md](air-gapped.md#image-build-arguments)).

## Common failures

| What people see                                                                                               | Cause                                                                                                                                                          | Fix                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Add your gateway token under Settings → My tokens`                                                           | Personal work, and the owner has no gateway token                                                                                                              | The owner adds one (`PUT /api/gateway/me/token` stores and tries it)                                           |
| `This team has no gateway token yet — a team admin adds one under Teams → <team> → Tokens`                    | Team work, no team token                                                                                                                                       | A team admin adds it                                                                                           |
| `The organization has no gateway token — an admin adds one under Settings → Model gateway`                    | Organization work (or a catalog sync) with no organization token                                                                                               | An admin adds it                                                                                               |
| `<gateway> takes only keys Optio makes: press "Get my token" under Settings → My tokens`                      | Someone pasted a token where the gateway allows only keys Optio makes                                                                                          | Press **Get my token** (a team admin: **Create team key**), or an admin allows pasting                         |
| `The gateway refused the admin key for /key/generate (401): …`                                                | The LiteLLM admin key isn't a proxy admin's, or it was changed in LiteLLM                                                                                      | Paste the current master key under **How people get tokens**; **Save** tries it                                |
| A run fails with LiteLLM's `Budget has been exceeded`                                                         | A person's key, or the team's LiteLLM team, spent its budget (Optio emailed at 100%)                                                                           | Wait for the reset, or raise it: a team's with **Set budget**, a person's default by an admin                  |
| Deleting a gateway: `Optio couldn't delete the N keys it made on <gateway> in LiteLLM (…)`                    | LiteLLM is unreachable, refuses the admin key, or no admin key is stored                                                                                       | Fix that and delete again; or answer **yes** to delete anyway and delete the keys in LiteLLM by hand           |
| `Image preset "dind" is not available in this deployment (available: …)`                                      | The repo picks a preset `agent.presets` doesn't list                                                                                                           | Pick an available preset, or mirror its image and add it to `agent.presets`                                    |
| `<value> isn't available in this deployment`                                                                  | A request named a runtime, platform, trigger or source the feature lists leave out                                                                             | Use what the lists offer ([feature-lists.md](feature-lists.md))                                                |
| GitLab deliveries fail with 401 `Invalid X-Gitlab-Token`                                                      | The hook's token differs from the receiver's: `GITLAB_WEBHOOK_SECRET` was set or changed after Optio created hooks with its generated one, or a hand-made hook | **Repair webhook** on each repo page (writes the current token)                                                |
| 401 `GitLab webhook secret not configured`                                                                    | No `GITLAB_WEBHOOK_SECRET` and Optio hasn't generated one yet (no GitLab repo added)                                                                           | Add the repo through Optio, or press **Repair webhook**                                                        |
| Repo page: `PUBLIC_API_URL (or PUBLIC_URL) is not set, so GitLab has no address to deliver to`                | The deployment has no public address                                                                                                                           | Set `PUBLIC_URL`, redeploy, **Repair webhook**                                                                 |
| Repo page: a GitLab API error (403/404) under **GitLab webhook**                                              | The token lacks Maintainer on the project                                                                                                                      | Give it Maintainer (or a token that has it), **Repair webhook**                                                |
| Auto-merge waits; then `GitLab still won't merge MR !<n> (<status>) — merge it by hand or fix what blocks it` | GitLab answers 405/406 right after a push while it checks the MR. Optio retries every 15 s for about 5 minutes, then hands the task to a person                | Usually nothing. On the message: conflicts, a blocking approval rule or pipeline. Fix it, or merge by hand     |
| `Automatic merging needs the checkbox and the confirmation`                                                   | A write turned auto-merge on without the dialog's confirmation                                                                                                 | Tick the checkbox and accept the dialog. Rows from before the guard stay off until someone confirms again      |
| A run failed with `invalid byte sequence for encoding UTF8: 0x00` (older builds)                              | A NUL byte in agent output reached Postgres                                                                                                                    | Fixed: agent output passes through `stripNul` (NUL → U+FFFD). If it comes back, a new sink skips it: report it |
| `Jira webhook secret not configured`                                                                          | A Jira webhook delivery without `JIRA_WEBHOOK_SECRET`                                                                                                          | Set `webhook.jiraSecret`, redeploy, and give Jira the same secret                                              |
| Settings → Notifications → Email: "Not sent to …: <the relay's reason>"                                       | The relay refused (wrong port or encryption, account, sender) or can't be reached, or its certificate isn't trusted                                            | The reason names it; [When email doesn't arrive](notifications.md#when-email-doesnt-arrive)                    |
| A Mattermost / Teams channel shows raw JSON                                                                   | The webhook has no body format, so only `hooks.slack.com` URLs get a chat message                                                                              | Open the webhook and pick its **Body format**                                                                  |
| Sign-in or the API answers 429 for many people at once                                                        | The API counts everyone as one address: a proxy in front of the ingress that `OPTIO_TRUST_PROXY` doesn't count                                                 | Set `rateLimit.trustProxy` to the number of proxies (or their addresses) and redeploy                          |
| `Only a deployment admin changes organization-wide secrets`                                                   | A workspace admin who isn't a deployment admin wrote or deleted a global secret (the organization's `GITLAB_TOKEN`, an organization agent credential)          | A deployment admin does it; a team or a person sets their own token instead                                    |
| `Only a deployment admin creates workspaces here …`                                                           | `workspaces.creation` is `admins`                                                                                                                              | A deployment admin creates it, or lets everyone under Settings → Access → Workspaces                           |
| `Only a deployment admin opens a workspace to directory groups`                                               | A workspace admin named or changed the groups that open a workspace                                                                                            | A deployment admin sets them                                                                                   |
| An outbound webhook gets fewer events than before the upgrade                                                 | A hook now receives only its own workspace's work that its creator may see; a hook with no workspace only while its creator is a deployment admin              | Recreate it as someone who sees that work (a workspace admin sees all of the workspace's)                      |
| `Your gateway token is over budget until <reset> (… USD spent) — Settings → My tokens`                        | The gateway pre-flight: the run's token (yours, the team's or the organization's) spent its LiteLLM `max_budget`                                               | Wait for the reset, raise the key's budget in LiteLLM, or store another token where the message says           |
| `… gateway token was rejected by the gateway (401 …)` or `… expired on <time> and is rejected …`              | The pre-flight: LiteLLM refuses the key (wrong, blocked or deleted: a 401; expired: a 400 `expired_key`)                                                       | Store a key LiteLLM accepts where the message says; **Check now** under Settings → System health               |
| A run's error shows **Private CA not trusted**                                                                | An agent pod or the API met a certificate signed by a CA it doesn't trust                                                                                      | Put the deployment's root CA in the chart's `caBundle` and upgrade (or the connection's own CA field)          |
| A run's error shows **Registry CA not trusted by the nodes**                                                  | The nodes' container runtime couldn't pull the agent image: the registry's CA isn't trusted there                                                              | Trust the CA on each node (RKE2 / K3s `registries.yaml`, containerd `certs.d`); `caBundle` can't               |
| System health: a GitLab token is **Unknown**, `No GitLab host to check it against`                            | Its owner's repos are on a GitLab not named in `gitlab.hosts` or by the setup wizard                                                                           | Add that host to `gitlab.hosts` and upgrade; Optio sends tokens only to named hosts                            |
| System health: `Not Maintainer on <project>: Optio can't keep the webhook there`                              | The organization's GitLab token's user is below Maintainer on a project with an Optio webhook                                                                  | Give that user Maintainer (or use a token that has it), then **Repair webhook** on the repo page               |

## Logs to look at

```bash
kubectl logs -n optio deploy/optio-api -c api --since=1h        # the API: sign-in, webhooks, gateway, reconciler
kubectl logs -n optio deploy/optio-api -c web --since=1h        # the Next.js server
kubectl get pods -n optio -l optio.type=repo-pod                 # agent pods for repo work
kubectl get pods -n optio -l optio.type=workflow-pod             # Job pods
kubectl get events -n optio --sort-by=.lastTimestamp | tail -30  # image pulls, scheduling
```

API log lines worth grepping for: `setup token`, `Created the GitLab webhook`,
`Updated the GitLab webhook`, `GitLab webhook could not be set up`,
`Generated the GitLab webhook secret`, `GITLAB_WEBHOOK_SECRET is not set`,
`JIRA_WEBHOOK_SECRET is not set`. Secrets are never logged; a token in a log
line is a bug.
