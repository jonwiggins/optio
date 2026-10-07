import type { WsEvent } from "@optio/shared";
import { createRedisClient, type RedisClient } from "./redis-config.js";
import { getCurrentTraceId } from "../telemetry/spans.js";

let publisher: RedisClient | null = null;

function getPublisher(): RedisClient {
  if (!publisher) {
    publisher = createRedisClient({ connectionName: "optio-shared" });
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

/**
 * Content-free nudge for Optio Local terminal changes. Published only on the
 * shared `optio:events` channel — that stream is visible to every
 * authenticated user, so no terminal content (previews, output, dirs) may
 * ever ride on it. Clients refetch over REST on receipt.
 */
export async function publishLocalChanged(event: {
  /** Null for host-level changes (online/offline) with no specific terminal. */
  terminalId: string | null;
  hostId: string;
  userId: string | null;
}): Promise<void> {
  const redis = getPublisher();
  await redis.publish(`optio:events`, JSON.stringify({ type: "local:changed", ...event }));
}

/**
 * The shared Redis client (pub/sub publishing and single-key commands). In
 * cluster mode it is an `ioredis.Cluster`: keep commands single-key, or go
 * through `redisScanKeys` / `redisDeleteKeys` (services/redis-config.ts).
 */
export function getRedisClient(): RedisClient {
  return getPublisher();
}

/**
 * A dedicated connection for SUBSCRIBE (a subscribed connection can't run
 * other commands). Callers disconnect it when done.
 */
export function createSubscriber(): RedisClient {
  return createRedisClient({ connectionName: "optio-subscriber" });
}
