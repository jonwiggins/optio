/**
 * A Prometheus endpoint for the deployment's monitoring
 * (docs/observability.md "Prometheus endpoint and dashboard").
 *
 * Upstream ships its metrics over OTLP only (telemetry.ts), and a Rancher
 * cluster runs Prometheus with the operator: nothing could scrape Optio.
 * With `OPTIO_METRICS_PORT` set, the API serves the same metrics — and the
 * fork's own (site-metrics.ts) — as Prometheus text on that port at
 * `/metrics`, on its own listener: the chart gives it its own Service, never
 * the ingress, so only what runs in the cluster reaches it.
 *
 *   OPTIO_OTEL_ENABLED=true  → a second metric reader next to the OTLP one
 *                              (`prometheusReader`, one hook in telemetry.ts)
 *   otherwise                → a meter provider with this reader alone
 *                              (`startPrometheusOnly`): no OTLP collector, no
 *                              traces, no auto-instrumentation
 *
 * Unset (the default), nothing here loads and Optio is upstream's.
 *
 * The OTel packages are imported here only when the endpoint is on, as
 * telemetry.ts does for OTLP.
 */
import { logger } from "../logger.js";

/** The default Prometheus exporter port (the registered 9464). */
export const DEFAULT_METRICS_PORT = 9464;

/**
 * The port `OPTIO_METRICS_PORT` asks for, or null when the endpoint is off
 * (unset, empty, `0`, `off`, `false`) or the value isn't a port (1-65535).
 */
export function metricsPort(
  raw: string | undefined = process.env.OPTIO_METRICS_PORT,
): number | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || v === "0" || v === "off" || v === "false") return null;
  const port = Number(v);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Whether the API serves Prometheus metrics (`OPTIO_METRICS_PORT` set to a port). */
export function prometheusEnabled(): boolean {
  return metricsPort() !== null;
}

/**
 * The Prometheus reader on `OPTIO_METRICS_PORT`, listening as soon as it is
 * made, or null when the endpoint is off. Series carry no `otel_scope_*`
 * labels (one scope, `optio-api`, would be on every one); `target_info`
 * keeps the service name and version. A value that isn't a port is logged
 * and leaves the endpoint off: monitoring never stops the API from starting.
 */
export async function prometheusReader(): Promise<
  import("@opentelemetry/exporter-prometheus").PrometheusExporter | null
> {
  const port = metricsPort();
  if (port === null) {
    const raw = (process.env.OPTIO_METRICS_PORT ?? "").trim();
    if (raw && !["0", "off", "false"].includes(raw.toLowerCase())) {
      logger.error(
        { value: raw },
        "OPTIO_METRICS_PORT is not a port number (1-65535); the metrics endpoint is off",
      );
    }
    return null;
  }
  const { PrometheusExporter } = await import("@opentelemetry/exporter-prometheus");
  return new PrometheusExporter({ port, endpoint: "/metrics", withoutScopeInfo: true }, (err) => {
    if (err) {
      logger.error(
        { err, port },
        "The metrics endpoint could not listen; Prometheus can't scrape this API",
      );
    } else {
      logger.info({ port }, `Prometheus metrics on :${port}/metrics`);
    }
  });
}

/**
 * The endpoint with no OTLP: a meter provider whose only reader is the
 * Prometheus one, made the global provider so every `metrics.getMeter` —
 * upstream's metrics.ts, site-metrics.ts — records into it. No
 * auto-instrumentation loads here, so there are no HTTP server metrics:
 * those come only with OTLP on (telemetry.ts's NodeSDK), on both readers.
 * Returns its shutdown (stops the listener), or null when the endpoint is off.
 */
export async function startPrometheusOnly(): Promise<(() => Promise<void>) | null> {
  const reader = await prometheusReader();
  if (!reader) return null;
  const { MeterProvider } = await import("@opentelemetry/sdk-metrics");
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } =
    await import("@opentelemetry/semantic-conventions");
  const { metrics } = await import("@opentelemetry/api");
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "optio-api",
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.1.0",
      "service.namespace": "optio",
    }),
    readers: [reader],
  });
  metrics.setGlobalMeterProvider(provider);

  const { enableMetrics, initMetrics } = await import("./metrics.js");
  enableMetrics();
  initMetrics();

  return async () => {
    try {
      await provider.shutdown();
    } catch {
      // Best-effort, like the OTLP SDK's shutdown.
    }
  };
}
