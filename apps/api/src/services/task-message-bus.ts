import { createSubscriber, getRedisClient } from "./event-bus.js";
import type { RedisClient } from "./redis-config.js";

export interface TaskMessagePayload {
  messageId: string;
  content: string;
  mode: "soft" | "interrupt";
  userDisplayName: string | null;
}

const CHANNEL_PREFIX = "optio:task-messages:";

function channelFor(taskId: string): string {
  return `${CHANNEL_PREFIX}${taskId}`;
}

/**
 * Publish a message to the per-task Redis channel.
 * The task worker subscribed to this channel will pick it up and write to execSession.stdin.
 */
export async function publishTaskMessage(
  taskId: string,
  payload: TaskMessagePayload,
): Promise<void> {
  await getRedisClient().publish(channelFor(taskId), JSON.stringify(payload));
}

/**
 * Subscribe to messages for a specific task.
 * Returns the subscriber and a cleanup function.
 */
export function subscribeToTaskMessages(
  taskId: string,
  onMessage: (payload: TaskMessagePayload) => void,
): { subscriber: RedisClient; unsubscribe: () => void } {
  const subscriber = createSubscriber();
  const channel = channelFor(taskId);

  subscriber.subscribe(channel);
  subscriber.on("message", (_ch: string, message: string) => {
    try {
      const payload = JSON.parse(message) as TaskMessagePayload;
      onMessage(payload);
    } catch {
      // ignore parse errors
    }
  });

  return {
    subscriber,
    unsubscribe() {
      subscriber.unsubscribe(channel);
      subscriber.disconnect();
    },
  };
}
