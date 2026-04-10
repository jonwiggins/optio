/**
 * OpenTelemetry SDK initialization for Optio API server.
 *
 * When OPTIO_OTEL_ENABLED is not "true", this module exports a no-op
 * initTelemetry() and no OTel packages are imported (zero runtime cost).
 *
 * When enabled, it dynamically imports the OTel SDK and sets up:
 * - Auto-instrumentation (HTTP/Fastify, undici/fetch, pg, ioredis)
 * - OTLP trace and metric exporters
 * - Optional OTLP log exporter (OPTIO_OTEL_LOGS_ENABLED)
 * - Graceful shutdown on SIGTERM/SIGINT
 *
 * CRITICAL: initTelemetry() must be called BEFORE any other imports in the
 * application entry point. OTel auto-instrumentation patches module prototypes,
 * which only works before the instrumented modules are loaded.
 */

let shutdownFn: (() => Promise<void>) | null = null;

/**
 * Returns true if OTel is enabled via OPTIO_OTEL_ENABLED env var.
 */
export function isOtelEnabled(): boolean {
  return process.env.OPTIO_OTEL_ENABLED === "true";
}

/**
 * Initialize OpenTelemetry SDK. Must be called before any other module imports.
 * No-op when OPTIO_OTEL_ENABLED !== "true".
 */
export async function initTelemetry(): Promise<void> {
  if (!isOtelEnabled()) {
    return;
  }

  // Dynamic imports — OTel packages are only loaded when enabled
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
  const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-proto");
  const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
  const { Resource } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } =
    await import("@opentelemetry/semantic-conventions");
  const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-node");
  const { diag, DiagConsoleLogger, DiagLogLevel } = await import("@opentelemetry/api");
  const { ParentBasedSampler, TraceIdRatioBasedSampler } =
    await import("@opentelemetry/sdk-trace-node");

  // Enable diag logging if requested
  if (process.env.OPTIO_OTEL_DEBUG === "true") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const samplingRatio = parseFloat(process.env.OPTIO_OTEL_SAMPLING_RATIO ?? "1.0");
  const metricsIntervalMs = parseInt(process.env.OPTIO_OTEL_METRICS_INTERVAL_MS ?? "60000", 10);

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "optio-api",
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.1.0",
    "service.namespace": "optio",
    "deployment.environment": process.env.NODE_ENV ?? "development",
  });

  const traceExporter = new OTLPTraceExporter();
  const metricExporter = new OTLPMetricExporter();

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: metricsIntervalMs,
  });

  // Configure log exporter if enabled
  let logRecordProcessor: unknown = undefined;
  if (process.env.OPTIO_OTEL_LOGS_ENABLED === "true") {
    const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-proto");
    const { BatchLogRecordProcessor, LoggerProvider } = await import("@opentelemetry/sdk-logs");
    const { logs } = await import("@opentelemetry/api-logs");

    const logExporter = new OTLPLogExporter();
    const logProvider = new LoggerProvider({ resource });
    logProvider.addLogRecordProcessor(new BatchLogRecordProcessor(logExporter));
    logs.setGlobalLoggerProvider(logProvider);

    // Enable the logs module
    const { enableLogs } = await import("./telemetry/logs.js");
    enableLogs(logs.getLogger("optio-api"));

    logRecordProcessor = new BatchLogRecordProcessor(logExporter);
  }

  const sdk = new NodeSDK({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)] as any,
    metricReader: metricReader as any,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(samplingRatio),
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable noisy/unnecessary instrumentations
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
      }),
    ],
  });

  sdk.start();

  // Enable span and metrics modules
  const { enableSpans } = await import("./telemetry/spans.js");
  const { enableMetrics, initMetrics } = await import("./telemetry/metrics.js");
  enableSpans();
  enableMetrics();
  initMetrics();

  // Set up graceful shutdown
  shutdownFn = async () => {
    try {
      await sdk.shutdown();
    } catch {
      // Best-effort shutdown
    }
  };
}

/**
 * Register observable gauge callbacks that depend on external state (DB).
 * Must be called after database is available.
 */
export async function registerMetricCallbacks(callbacks: {
  queueDepth?: (attrs: Record<string, unknown>) => number;
  activeTasks?: () => number;
  podCount?: (attrs: Record<string, unknown>) => number;
}): Promise<void> {
  if (!isOtelEnabled()) return;
  const { initMetrics } = await import("./telemetry/metrics.js");
  initMetrics(callbacks);
}

/**
 * Gracefully shut down the OTel SDK, flushing any pending spans/metrics.
 * Returns a promise that resolves when shutdown is complete or after 5s timeout.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!shutdownFn) return;

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
  await Promise.race([shutdownFn(), timeout]);
  shutdownFn = null;
}
