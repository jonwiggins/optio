/**
 * Fastify HTTP metrics plugin.
 *
 * Records standard HTTP request/response metrics using OpenTelemetry:
 * - http_server_request_duration_seconds (histogram)
 * - http_server_requests_total (counter)
 *
 * No-op when OTel metrics are disabled.
 */

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Counter, Histogram } from "@opentelemetry/api";
import { metrics as otelMetrics } from "@opentelemetry/api";
import { isMetricsEnabled } from "../telemetry/metrics.js";

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMERIC_ID_REGEX = /\/(\d+)(\/|$)/g;

export interface HttpMetrics {
  requestCounter: Counter;
  durationHistogram: Histogram;
  recordRequest(
    attrs: { method: string; route: string; status_code: number },
    durationS: number,
  ): void;
  normalizeRoute(url: string): string;
}

/**
 * Create HTTP metric instruments. Exported for testing.
 */
export function createHttpMetrics(): HttpMetrics {
  const meter = otelMetrics.getMeter("optio-api");

  const requestCounter = meter.createCounter("http_server_requests_total", {
    description: "Total number of HTTP requests by method, route, and status code",
  });

  const durationHistogram = meter.createHistogram("http_server_request_duration_seconds", {
    description: "HTTP request duration in seconds",
    unit: "s",
  });

  function normalizeRoute(url: string): string {
    // Strip query string
    const path = url.split("?")[0];
    // Replace UUIDs with :id
    let normalized = path.replace(UUID_REGEX, ":id");
    // Replace numeric path segments with :id
    normalized = normalized.replace(NUMERIC_ID_REGEX, "/:id$2");
    return normalized;
  }

  function recordRequest(
    attrs: { method: string; route: string; status_code: number },
    durationS: number,
  ): void {
    if (!isMetricsEnabled()) return;
    requestCounter.add(1, attrs);
    durationHistogram.record(durationS, attrs);
  }

  return { requestCounter, durationHistogram, recordRequest, normalizeRoute };
}

async function httpMetricsPluginFn(app: FastifyInstance) {
  if (!isMetricsEnabled()) return;

  const httpMetrics = createHttpMetrics();

  app.addHook("onResponse", (req, reply, done) => {
    const durationMs = reply.elapsedTime;
    const durationS = durationMs / 1000;

    const route = httpMetrics.normalizeRoute(req.routeOptions?.url ?? req.url);
    const attrs = {
      method: req.method,
      route,
      status_code: reply.statusCode,
    };

    httpMetrics.recordRequest(attrs, durationS);
    done();
  });
}

export const httpMetricsPlugin = fp(httpMetricsPluginFn, { name: "optio-http-metrics" });
