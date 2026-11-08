/**
 * High-signal OTel log emitter. Only emits logs when OPTIO_OTEL_LOGS_ENABLED=true.
 *
 * These OTel logs complement (not replace) pino stdout logging and carry
 * trace context automatically for correlation in backends.
 *
 * Emitted events:
 * - task.state_transition
 * - task.cost_report
 * - pod.health_event
 * - auth.failure
 * - webhook.delivery_failure
 */

import type { Logger as OtelLogger } from "@opentelemetry/api-logs";

let logger: OtelLogger | null = null;
let enabled = false;

/** Enable OTel log emission. Called by initTelemetry() when OPTIO_OTEL_LOGS_ENABLED=true. */
export function enableLogs(otelLogger: OtelLogger): void {
  logger = otelLogger;
  enabled = true;
}

/** Check if OTel logs are enabled. */
export function isLogsEnabled(): boolean {
  return enabled;
}

export function emitStateTransitionLog(
  taskId: string,
  fromState: string,
  toState: string,
  trigger: string,
): void {
  if (!enabled || !logger) return;
  logger.emit({
    body: `Task ${taskId} transitioned ${fromState} → ${toState}`,
    attributes: {
      "event.name": "task.state_transition",
      "task.id": taskId,
      "transition.from": fromState,
      "transition.to": toState,
      "transition.trigger": trigger,
    },
  });
}

export function emitCostReportLog(
  taskId: string,
  costUsd: number,
  inputTokens: number,
  outputTokens: number,
  model: string,
): void {
  if (!enabled || !logger) return;
  logger.emit({
    body: `Task ${taskId} cost: $${costUsd.toFixed(4)} (${inputTokens}/${outputTokens} tokens, ${model})`,
    attributes: {
      "event.name": "task.cost_report",
      "task.id": taskId,
      "task.cost_usd": costUsd,
      "task.input_tokens": inputTokens,
      "task.output_tokens": outputTokens,
      "task.model": model,
    },
  });
}

export function emitPodHealthEventLog(eventType: string, podName: string, repoUrl: string): void {
  if (!enabled || !logger) return;
  logger.emit({
    body: `Pod health event: ${eventType} on ${podName}`,
    attributes: {
      "event.name": "pod.health_event",
      "health.event_type": eventType,
      "k8s.pod.name": podName,
      "k8s.repo_url": repoUrl,
      "health.message": eventType,
    },
  });
}

export function emitAuthFailureLog(reason: string): void {
  if (!enabled || !logger) return;
  logger.emit({
    body: `Auth failure: ${reason}`,
    attributes: {
      "event.name": "auth.failure",
      // Only emit classified reason, not raw error
      "auth.failure_reason": reason,
    },
  });
}

export function emitWebhookDeliveryFailureLog(
  webhookId: string,
  event: string,
  statusCode: number,
): void {
  if (!enabled || !logger) return;
  logger.emit({
    body: `Webhook delivery failed: ${event} to ${webhookId} (status ${statusCode})`,
    attributes: {
      "event.name": "webhook.delivery_failure",
      "webhook.id": webhookId,
      "webhook.event": event,
      "webhook.status_code": statusCode,
    },
  });
}
