/**
 * Pure APNs payload builders for the iOS glanceable surfaces. No I/O — the
 * service (apns-service.ts) picks recipients and the transport ships bytes.
 *
 * Two push types:
 *   - `alert`        — user-visible notification (docs/design/ios-glanceable-
 *                      surfaces.md §2i). Actions are attached client-side via
 *                      `category`; `thread-id` groups a chatty subject.
 *   - `liveactivity` — ActivityKit start / update / end for the "Watch"
 *                      activity (§2a). `content-state` must decode as the Swift
 *                      `WatchState`; dates are Apple reference-date seconds
 *                      (see packages/shared/src/types/glance.ts).
 *
 * APNs rejects anything over 4 KB, so every builder asserts the size.
 */
import { appleSeconds, type WatchAttributes, type WatchState } from "@optio/shared";

export const APNS_MAX_PAYLOAD_BYTES = 4096;

export type ApnsPushType = "alert" | "liveactivity";
export type ApnsPriority = 5 | 10;

/** Notification categories the iOS app registers actions for. */
export type ApnsAlertCategory =
  | "LOCAL_NEEDS_YOU"
  | "LOCAL_EXIT"
  | "HOST_OFFLINE"
  | "TASK_ATTENTION"
  | "TASK_PR_OPENED"
  | "AGENT_REPLY"
  | "AGENT_FAILED"
  | "TEST";

export type ApnsSubjectKind = "local" | "host" | "task" | "agent" | "test";

/** Everything the service needs to know about one push, transport-agnostic. */
export interface ApnsMessage {
  pushType: ApnsPushType;
  /** `apns-topic`: the bundle id, or `<bundle>.push-type.liveactivity`. */
  topic: string;
  priority: ApnsPriority;
  /** `apns-expiration`, unix seconds. */
  expiration: number;
  /** `apns-collapse-id`; alerts only. */
  collapseId?: string;
  payload: Record<string, unknown>;
}

export interface AlertInput {
  title: string;
  body: string;
  subtitle?: string | null;
  category: ApnsAlertCategory;
  /** `thread-id`: the subject id, so a chatty terminal collapses into one stack. */
  threadId: string;
  /** Deep link the app opens, e.g. `optio://local/<id>?compose=1`. */
  url: string;
  kind: ApnsSubjectKind;
  /** Subject id (terminal / task / agent / host). */
  id: string;
  /** `"default"` (the default) plays a sound; `null` delivers silently. */
  sound?: string | null;
  collapseId?: string;
  /** Lets a Notification Service Extension rewrite the content (e.g. fetch a preview). */
  mutableContent?: boolean;
  /** `time-sensitive` breaks through Focus when the app has the entitlement. */
  interruptionLevel?: "passive" | "active" | "time-sensitive";
  /** Extra top-level keys (e.g. `prUrl`). Must be JSON-serialisable. */
  extra?: Record<string, unknown>;
}

const ALERT_TTL_SEC = 24 * 60 * 60;
const LIVE_ACTIVITY_TTL_SEC = 60 * 60;
/** How long an island frame stays "fresh" before iOS renders it as stale. */
const LIVE_ACTIVITY_STALE_AFTER_SEC = 120;
/** How long the final frame lingers on the lock screen after `end`. */
const LIVE_ACTIVITY_DISMISS_AFTER_SEC = 15 * 60;

export function payloadBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

export class ApnsPayloadTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`APNs payload is ${bytes} bytes; limit is ${APNS_MAX_PAYLOAD_BYTES}`);
    this.name = "ApnsPayloadTooLargeError";
  }
}

export function assertPayloadSize(payload: Record<string, unknown>): void {
  const bytes = payloadBytes(payload);
  if (bytes > APNS_MAX_PAYLOAD_BYTES) throw new ApnsPayloadTooLargeError(bytes);
}

export function liveActivityTopic(bundleId: string): string {
  return `${bundleId}.push-type.liveactivity`;
}

function unixSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

/** Strip null/undefined so the wire payload stays compact. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
  return out as T;
}

/**
 * `apns-push-type: alert`. `body` is clipped to 500 chars — anything longer
 * is a log tail and belongs behind the deep link.
 */
export function buildAlertMessage(
  input: AlertInput,
  opts: { bundleId: string; now?: Date },
): ApnsMessage {
  const now = opts.now ?? new Date();
  const sound = input.sound === undefined ? "default" : input.sound;
  const aps = compact({
    alert: compact({
      title: input.title.slice(0, 200),
      subtitle: input.subtitle ? input.subtitle.slice(0, 200) : undefined,
      body: input.body.slice(0, 500),
    }),
    sound: sound ?? undefined,
    "thread-id": input.threadId,
    category: input.category,
    "mutable-content": input.mutableContent ? 1 : undefined,
    "interruption-level": input.interruptionLevel,
  });
  const payload: Record<string, unknown> = {
    ...(input.extra ?? {}),
    aps,
    url: input.url,
    kind: input.kind,
    id: input.id,
  };
  assertPayloadSize(payload);
  return {
    pushType: "alert",
    topic: opts.bundleId,
    priority: 10,
    expiration: unixSeconds(now) + ALERT_TTL_SEC,
    collapseId: input.collapseId ?? `${input.kind}-${input.id}`,
    payload,
  };
}

export interface LiveActivityAlert {
  title: string;
  body: string;
  /** Defaults to `"default"`; `null` for an alerting update without sound. */
  sound?: string | null;
}

export interface LiveActivityUpdateInput {
  event: "update" | "end";
  state: WatchState;
  /** Present → the update alerts (priority 10); absent → silent (priority 5). */
  alert?: LiveActivityAlert | null;
  now?: Date;
}

/** `relevance-score` orders multiple activities on the lock screen: waiting outranks working. */
function relevanceScore(state: WatchState): number {
  switch (state.phase) {
    case "waiting":
      return 100;
    case "offline":
      return 75;
    case "working":
      return 50;
    case "done":
      return 10;
  }
}

/** `apns-push-type: liveactivity`, event `update` or `end`. */
export function buildLiveActivityMessage(
  input: LiveActivityUpdateInput,
  opts: { bundleId: string },
): ApnsMessage {
  const now = input.now ?? new Date();
  const ts = unixSeconds(now);
  const aps = compact({
    timestamp: ts,
    event: input.event,
    "content-state": input.state,
    "stale-date": input.event === "end" ? undefined : ts + LIVE_ACTIVITY_STALE_AFTER_SEC,
    "dismissal-date": input.event === "end" ? ts + LIVE_ACTIVITY_DISMISS_AFTER_SEC : undefined,
    "relevance-score": relevanceScore(input.state),
    alert: input.alert
      ? compact({
          title: input.alert.title.slice(0, 200),
          body: input.alert.body.slice(0, 500),
          sound: input.alert.sound === undefined ? "default" : (input.alert.sound ?? undefined),
        })
      : undefined,
  });
  const payload = { aps };
  assertPayloadSize(payload);
  return {
    pushType: "liveactivity",
    topic: liveActivityTopic(opts.bundleId),
    priority: input.alert ? 10 : 5,
    expiration: ts + LIVE_ACTIVITY_TTL_SEC,
    payload,
  };
}

export interface LiveActivityStartInput {
  attributes: WatchAttributes;
  state: WatchState;
  alert?: LiveActivityAlert | null;
  now?: Date;
}

/** Swift `ActivityAttributes` type name the start payload targets. */
export const WATCH_ATTRIBUTES_TYPE = "WatchAttributes";

/** `apns-push-type: liveactivity`, event `start` (push-to-start token). */
export function buildLiveActivityStartMessage(
  input: LiveActivityStartInput,
  opts: { bundleId: string },
): ApnsMessage {
  const now = input.now ?? new Date();
  const ts = unixSeconds(now);
  const aps = compact({
    timestamp: ts,
    event: "start",
    "attributes-type": WATCH_ATTRIBUTES_TYPE,
    attributes: input.attributes,
    "content-state": input.state,
    "stale-date": ts + LIVE_ACTIVITY_STALE_AFTER_SEC,
    "relevance-score": relevanceScore(input.state),
    alert: input.alert
      ? compact({
          title: input.alert.title.slice(0, 200),
          body: input.alert.body.slice(0, 500),
          sound: input.alert.sound === undefined ? "default" : (input.alert.sound ?? undefined),
        })
      : undefined,
  });
  const payload = { aps };
  assertPayloadSize(payload);
  return {
    pushType: "liveactivity",
    topic: liveActivityTopic(opts.bundleId),
    priority: 10,
    expiration: ts + LIVE_ACTIVITY_TTL_SEC,
    payload,
  };
}

/** Attributes for a Watch started by the server (push-to-start). */
export function buildWatchAttributes(userId: string, now = new Date()): WatchAttributes {
  return { userId, startedAt: appleSeconds(now) };
}

/**
 * Stable hash of a Watch frame for dedupe. `asOf` is excluded — it changes on
 * every compute and would defeat the point.
 */
export function watchStateHash(state: WatchState): string {
  const { asOf: _asOf, ...rest } = state;
  return JSON.stringify(rest);
}
