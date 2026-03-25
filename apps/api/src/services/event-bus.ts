import { Redis } from "ioredis";
import type { WsEvent } from "@optio/shared";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(redisUrl);
  }
  return publisher;
}

export async function publishEvent(event: WsEvent): Promise<void> {
  const redis = getPublisher();
  const channel = `optio:events`;
  await redis.publish(channel, JSON.stringify(event));

  // Also publish to task-specific channel for targeted subscriptions
  if ("taskId" in event) {
    await redis.publish(`optio:task:${event.taskId}`, JSON.stringify(event));
  }
}

export async function publishSessionEvent(sessionId: string, event: WsEvent): Promise<void> {
  const redis = getPublisher();
  await redis.publish(`optio:session:${sessionId}`, JSON.stringify(event));
}

export function createSubscriber(): Redis {
  return new Redis(redisUrl);
}
