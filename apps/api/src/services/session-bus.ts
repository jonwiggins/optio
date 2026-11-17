/**
 * The session bus: how session chat frames and session control reach every
 * API instance (docs/plans/scale-out.md §3).
 *
 * A pod session's chat turn runs on the instance that received the prompt,
 * and its viewers may be connected to any instance. Frames are published on
 * one Redis channel, `optio:session-bus`, that every instance subscribes to
 * once at boot (`startSessionBus`); each instance delivers what arrives to
 * its own sockets. Frames arrive in the order they were published: in
 * cluster mode the channel is sharded pub/sub (`publishOrdered` in
 * redis-config.ts), since a classic PUBLISH can land on any master. Control messages (interrupt a turn, a session ended, a
 * share revoked) ride the same channel, so the instance running the turn or
 * holding the sockets acts wherever it is.
 *
 * The publishing instance acts on its own message **before** publishing
 * (synchronously, as the in-process maps always did), and skips its own
 * messages when they come back — so a local viewer never waits on Redis and
 * nothing is done twice. Redis is the transport, never the record: what
 * must survive a lost message is in Postgres (session-turn-service.ts).
 */
import { INSTANCE_ID } from "./instance.js";
import { createOrderedBusSubscriber, getRedisClient } from "./event-bus.js";
import {
  onOrderedMessage,
  publishOrdered,
  subscribeOrdered,
  unsubscribeOrdered,
  type RedisClient,
} from "./redis-config.js";
import { logger } from "../logger.js";

export const SESSION_BUS_CHANNEL = "optio:session-bus";

type SessionScope = "pod" | "local";
type SessionControlAction = "interrupt" | "end" | "share_revoked";

export type SessionBusMessage =
  | { kind: "chat"; sessionId: string; frame: Record<string, unknown>; origin: string }
  | {
      kind: "control";
      scope: SessionScope;
      sessionId: string;
      action: SessionControlAction;
      /** For `interrupt`: the turn that was flagged; only its runner acts. */
      turnId?: string;
      origin: string;
    };

type Handler<K extends SessionBusMessage["kind"]> = (
  message: Extract<SessionBusMessage, { kind: K }>,
) => void;

const handlers: { [K in SessionBusMessage["kind"]]: Set<Handler<K>> } = {
  chat: new Set(),
  control: new Set(),
};

/**
 * Registers what this instance does with a message from another instance.
 * Services register at import time; the handler never sees this instance's
 * own messages (those were acted on before publishing).
 */
export function onSessionBus<K extends SessionBusMessage["kind"]>(
  kind: K,
  handler: Handler<K>,
): () => void {
  const set = handlers[kind] as Set<Handler<K>>;
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}

/** Delivers a message that arrived from the bus to this instance's handlers. */
export function dispatchSessionBusMessage(message: SessionBusMessage): void {
  if (message.origin === INSTANCE_ID) return;
  if (message.kind === "chat") {
    for (const h of handlers.chat) h(message);
  } else {
    for (const h of handlers.control) h(message);
  }
}

let publishFailures = 0;

/** Publishes to every instance (including this one, which ignores it). */
export async function publishSessionBus(message: SessionBusMessage): Promise<void> {
  try {
    await publishOrdered(getRedisClient(), SESSION_BUS_CHANNEL, JSON.stringify(message));
    publishFailures = 0;
  } catch (err) {
    // The local effect already happened; other instances miss only the live
    // frame (a reconnect replays history) or the control nudge (the durable
    // flag in Postgres is honored on the turn's next poll). Log a burst once.
    if (publishFailures++ === 0) {
      logger.warn({ err, kind: message.kind }, "session bus publish failed");
    }
  }
}

let subscriber: RedisClient | null = null;
let subscribed = false;
let starting: Promise<void> | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let stopped = false;

function onBusMessage(channel: string, raw: string): void {
  if (channel !== SESSION_BUS_CHANNEL) return;
  let message: SessionBusMessage;
  try {
    message = JSON.parse(raw) as SessionBusMessage;
  } catch {
    return;
  }
  if (!message || typeof message !== "object" || typeof message.sessionId !== "string") return;
  try {
    dispatchSessionBusMessage(message);
  } catch (err) {
    logger.warn({ err, kind: message.kind }, "session bus handler failed");
  }
}

/** One attempt: a fresh subscriber, SUBSCRIBE, and only then "started". */
async function subscribeOnce(): Promise<void> {
  const sub = createOrderedBusSubscriber();
  onOrderedMessage(sub, (channel, raw) => onBusMessage(channel, raw.toString("utf-8")));
  try {
    await subscribeOrdered(sub, [SESSION_BUS_CHANNEL]);
  } catch (err) {
    // Nothing half-started is left behind: the client goes, the state resets.
    sub.disconnect();
    throw err;
  }
  if (stopped) {
    sub.disconnect();
    return;
  }
  subscriber = sub;
  subscribed = true;
  logger.info({ channel: SESSION_BUS_CHANNEL }, "Session bus subscribed");
}

/**
 * Subscribes this instance to the bus, once. Resolves once the SUBSCRIBE is
 * confirmed (so nothing published afterwards is missed) or rejects with the
 * error; a failed attempt leaves no client behind. ioredis re-subscribes by
 * itself after a reconnect.
 */
export function startSessionBus(): Promise<void> {
  if (subscribed) return Promise.resolve();
  if (starting) return starting;
  stopped = false;
  starting = subscribeOnce().finally(() => {
    starting = null;
  });
  return starting;
}

/**
 * Boot: subscribes in the background, retrying with backoff (1 s doubling to
 * 30 s) until it works. Never throws: the API serves REST while Redis is
 * down, and until the bus is up, session frames and control simply stay on
 * this instance (the database fallbacks still hold).
 */
export function startSessionBusInBackground(): void {
  stopped = false;
  attemptInBackground(0);
}

function attemptInBackground(attempt: number): void {
  if (subscribed || stopped) return;
  startSessionBus().catch((err) => {
    if (stopped) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
    logger.warn({ err, retryInMs: delayMs }, "session bus subscribe failed; retrying");
    retryTimer = setTimeout(() => attemptInBackground(attempt + 1), delayMs);
    retryTimer.unref?.();
  });
}

/** Stops this instance's subscription (shutdown and tests). */
export async function stopSessionBus(): Promise<void> {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  await starting?.catch(() => {});
  const sub = subscriber;
  subscriber = null;
  subscribed = false;
  if (!sub) return;
  try {
    await unsubscribeOrdered(sub, [SESSION_BUS_CHANNEL]);
  } catch {
    // Already gone.
  }
  sub.disconnect();
}

/** Whether this instance's SUBSCRIBE succeeded and is live (diagnostics and tests). */
export function isSessionBusStarted(): boolean {
  return subscribed;
}
