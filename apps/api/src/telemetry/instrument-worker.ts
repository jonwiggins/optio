/**
 * BullMQ worker instrumentation wrapper.
 *
 * Wraps a worker's processor function to:
 * 1. Extract trace context from job.data (injected at enqueue time)
 * 2. Open a span for the full processor lifetime
 * 3. Record worker-specific attributes (job ID, name, attempts)
 * 4. Record exceptions and set span status on failure
 * 5. Emit optio_worker_job_duration_seconds histogram
 * 6. Record the credentials a run is given, for a job that names its run
 *    (services/run-credentials.ts `attributeRunCredentials`)
 */

import { type Span, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { contextFromJobData, isSpansEnabled } from "./spans.js";
import { recordWorkerJobDuration } from "./metrics.js";
import { WORKER_NAME, WORKER_JOB_ID, WORKER_JOB_NAME, WORKER_ATTEMPTS } from "./attributes.js";
import { recordingRunCredentials } from "../services/run-credentials.js";

interface JobLike {
  id?: string;
  name: string;
  data: Record<string, unknown>;
  attemptsMade: number;
}

/**
 * Wrap a BullMQ processor function with OpenTelemetry instrumentation.
 *
 * @param workerName - Name of the worker (e.g., "task-worker", "pr-watcher")
 * @param processor - The original processor function
 * @returns Wrapped processor function with tracing
 */
export function instrumentWorkerProcessor<T extends JobLike>(
  workerName: string,
  processor: (job: T) => Promise<void>,
): (job: T) => Promise<void> {
  const recorded = recordingRunCredentials(processor);
  return async (job: T): Promise<void> => {
    if (!isSpansEnabled()) {
      return recorded(job);
    }

    const parentContext = contextFromJobData(job.data);
    const tracer = trace.getTracer("optio-api");
    const startTime = Date.now();

    const span = tracer.startSpan(
      `${workerName}.process`,
      {
        attributes: {
          [WORKER_NAME]: workerName,
          [WORKER_JOB_ID]: job.id ?? "unknown",
          [WORKER_JOB_NAME]: job.name,
          [WORKER_ATTEMPTS]: job.attemptsMade,
        },
      },
      parentContext,
    );

    return context.with(trace.setSpan(parentContext, span), async () => {
      try {
        await recorded(job);
        span.setStatus({ code: SpanStatusCode.OK });
        recordWorkerJobDuration((Date.now() - startTime) / 1000, workerName, true);
      } catch (err) {
        if (err instanceof Error) {
          span.recordException({ name: err.name, message: err.message });
        }
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : "Unknown error",
        });
        recordWorkerJobDuration((Date.now() - startTime) / 1000, workerName, false);
        throw err;
      } finally {
        span.end();
      }
    });
  };
}
