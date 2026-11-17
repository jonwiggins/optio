/**
 * Span wrappers, context propagation, and URL sanitization for OpenTelemetry.
 *
 * All span creation goes through these helpers to enforce attribute whitelists
 * and prevent sensitive data leakage.
 */

import {
  type Span,
  type Attributes,
  SpanStatusCode,
  trace,
  context,
  propagation,
  ROOT_CONTEXT,
} from "@opentelemetry/api";
import { classifyError } from "@optio/shared";

let enabled = false;

const TRACER_NAME = "optio-api";

function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/** Enable span creation. Called once by initTelemetry(). */
export function enableSpans(): void {
  enabled = true;
}

/** Check if telemetry spans are enabled. */
export function isSpansEnabled(): boolean {
  return enabled;
}

/**
 * Execute a function within a new span. When OTel is disabled, the function
 * runs directly with no overhead.
 *
 * @param name - Span name (e.g., "task.lifecycle", "k8s.pod.create")
 * @param attributes - Whitelisted attributes to set on the span
 * @param fn - Async function receiving the span (for adding events/attributes later)
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  if (!enabled) {
    // No-op span that satisfies the interface but does nothing
    return fn(trace.getTracer(TRACER_NAME).startSpan("noop"));
  }

  const tracer = getTracer();
  const span = tracer.startSpan(name, { attributes });

  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      recordSafeException(span, err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? safeErrorMessage(err) : "Unknown error",
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Inject W3C trace context into a BullMQ job's data object so the worker
 * can re-create the parent context.
 */
export function injectTraceContextIntoJob<T extends Record<string, unknown>>(jobData: T): T {
  if (!enabled) return jobData;

  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  if (carrier.traceparent) {
    return {
      ...jobData,
      _traceparent: carrier.traceparent,
      _tracestate: carrier.tracestate ?? "",
    };
  }
  return jobData;
}

/**
 * Extract trace context from a BullMQ job's data and return a Context
 * that can be used to create child spans.
 */
export function contextFromJobData(
  jobData: Record<string, unknown>,
): ReturnType<typeof context.active> {
  if (!enabled) return context.active();

  const traceparent = jobData._traceparent;
  const tracestate = jobData._tracestate;

  if (typeof traceparent !== "string") return context.active();

  const carrier: Record<string, string> = { traceparent };
  if (typeof tracestate === "string") {
    carrier.tracestate = tracestate;
  }

  return propagation.extract(ROOT_CONTEXT, carrier);
}

/**
 * Get the current trace ID from the active span, or undefined if none.
 */
export function getCurrentTraceId(): string | undefined {
  if (!enabled) return undefined;
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  // A valid trace ID is 32 hex chars, not all zeros
  if (ctx.traceId && ctx.traceId !== "00000000000000000000000000000000") {
    return ctx.traceId;
  }
  return undefined;
}

/**
 * Strip query string and fragment from a URL to prevent token leakage.
 * Returns the URL with path only.
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // If it's not a valid URL, strip anything after ? or #
    return url.split("?")[0].split("#")[0];
  }
}

/**
 * Record an exception on a span using only the classified error title and
 * category, never the raw error message (which may contain prompts or secrets).
 */
function recordSafeException(span: Span, err: unknown): void {
  if (!(err instanceof Error)) {
    span.recordException({ name: "Error", message: "Unknown error" });
    return;
  }
  const msg = safeErrorMessage(err);
  span.recordException({ name: err.name || "Error", message: msg });
}

/**
 * Get a safe error message using the error classifier.
 * Falls back to the error name if classification returns unknown.
 */
function safeErrorMessage(err: Error): string {
  const classified = classifyError(err.message);
  if (classified.category !== "unknown") {
    return `[${classified.category}] ${classified.title}`;
  }
  // For unclassified errors, return only the error name, not the full message
  return err.name || "Error";
}
