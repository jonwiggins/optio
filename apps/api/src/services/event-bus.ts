import { Redis } from "ioredis";
import type { WsEvent } from "@optio/shared";
import { redisConnectionUrl, redisTlsOptions } from "./redis-config.js";
import { getCurrentTraceId } from "../telemetry/spans.js";

let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(redisConnectionUrl, { tls: redisTlsOptions });
  }
  return publisher;
}

export async function publishEvent(event: WsEvent): Promise<void> {
  const redis = getPublisher();
  const channel = `optio:events`;

  // Attach current trace ID for correlation in observability backends
  const traceId = getCurrentTraceId();
  const enrichedEvent = traceId ? { ...event, traceId } : event;

  await redis.publish(channel, JSON.stringify(enrichedEvent));

  // Also publish to entity-specific channels for targeted subscriptions
  if ("taskId" in event) {
    await redis.publish(`optio:task:${event.taskId}`, JSON.stringify(enrichedEvent));
  }
  if ("prReviewId" in event && event.prReviewId) {
    await redis.publish(`optio:pr-review:${event.prReviewId}`, JSON.stringify(enrichedEvent));
  }
}

export async function publishSessionEvent(sessionId: string, event: WsEvent): Promise<void> {
  const redis = getPublisher();
  await redis.publish(`optio:session:${sessionId}`, JSON.stringify(event));
}

export async function publishWorkflowRunEvent(event: WsEvent): Promise<void> {
  const redis = getPublisher();
  const channel = `optio:events`;

  const traceId = getCurrentTraceId();
  const enrichedEvent = traceId ? { ...event, traceId } : event;

  await redis.publish(channel, JSON.stringify(enrichedEvent));

  // Also publish to workflow-run-specific channel for targeted subscriptions
  if ("workflowRunId" in event) {
    await redis.publish(`optio:workflow-run:${event.workflowRunId}`, JSON.stringify(enrichedEvent));
  }
}

export async function publishPersistentAgentEvent(event: WsEvent): Promise<void> {
  const redis = getPublisher();
  const channel = `optio:events`;
  const traceId = getCurrentTraceId();
  const enrichedEvent = traceId ? { ...event, traceId } : event;

  await redis.publish(channel, JSON.stringify(enrichedEvent));

  if ("agentId" in event && event.agentId) {
    await redis.publish(`optio:persistent-agent:${event.agentId}`, JSON.stringify(enrichedEvent));
  }
}

/** Return the shared Redis client (usable for pub/sub publishing and general commands). */
export function getRedisClient(): Redis {
  return getPublisher();
}

export function createSubscriber(): Redis {
  return new Redis(redisConnectionUrl, { tls: redisTlsOptions });
}
