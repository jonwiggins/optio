# Observability Guide

Optio ships with first-class OpenTelemetry (OTel) support for exporting **traces**, **metrics**, and **high-signal logs** to any OTLP-compatible backend.

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

| Span name                | Description                                                   |
| ------------------------ | ------------------------------------------------------------- |
| `<worker>.process`       | One job of a BullMQ worker (`telemetry/instrument-worker.ts`) |
| `k8s.pod.get_or_create`  | Pod scheduling and provisioning                               |
| `k8s.pod.startRun`       | Starting an agent run in a pod                                |
| `reconcile.decision`     | One reconciler pass over a run                                |
| `reconcile.resync.sweep` | The reconciler's periodic resync sweep                        |

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
