/**
 * Pure FCM HTTP v1 message builders for the Android app. No I/O — the service
 * (fcm-service.ts) picks recipients and the transport (fcm-transport.ts)
 * ships them.
 *
 * Every message is data-only (no `notification` block) so the app's
 * FirebaseMessagingService runs in the background too and renders the
 * notification itself, with per-category channels and actions. Two kinds,
 * discriminated by `data.type` (packages/shared/src/types/push.ts):
 *
 *   - `alert` — the APNs alert (apns-payloads.ts `buildAlertMessage`) as flat
 *     strings: same categories, deep links, thread ids and collapse ids;
 *     `android.priority = HIGH`, 24 h TTL like the APNs alert.
 *   - `watch` — one frame of the ongoing Watch notification (the iOS Live
 *     Activity): `{ event, state: JSON(WatchState) }`, `collapse_key = watch`,
 *     NORMAL priority unless the frame alerts, 1 h TTL.
 *
 * FCM data values must be strings and the payload is capped at 4 KB. Sizes
 * are measured on the JSON-encoded `data` object (escapes included), which is
 * never less than what FCM counts. A Watch frame over the cap sheds detail
 * (previews, then the extra rows) instead of failing.
 */
import type {
  AndroidPushAlert,
  AndroidPushWatch,
  AndroidPushWatchEvent,
  WatchState,
} from "@optio/shared";
import type { AlertInput } from "./apns-payloads.js";

export const FCM_MAX_DATA_BYTES = 4096;

export type FcmAndroidPriority = "HIGH" | "NORMAL";

/** Everything the service needs to know about one push — the HTTP v1 `message` minus `token`. */
export interface FcmMessage {
  data: Record<string, string>;
  android: {
    priority: FcmAndroidPriority;
    /** protobuf Duration string, e.g. `"86400s"`. */
    ttl: string;
    collapse_key?: string;
  };
}

/** Same lifetime as the APNs alert (`apns-expiration` = now + 24 h). */
export const FCM_ALERT_TTL_SEC = 24 * 60 * 60;
/** Same lifetime as a Live Activity frame; a staler Watch is worthless. */
export const FCM_WATCH_TTL_SEC = 60 * 60;
/** Every Watch frame shares one collapse key: an offline device gets only the newest. */
export const FCM_WATCH_COLLAPSE_KEY = "watch";

/** Keys FCM reserves in `data` (HTTP v1 reference). */
function isReservedDataKey(key: string): boolean {
  return (
    key === "from" ||
    key === "message_type" ||
    key === "notification" ||
    key.startsWith("google") ||
    key.startsWith("gcm")
  );
}

export function fcmDataBytes(data: Record<string, string>): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

export class FcmPayloadTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`FCM data payload is ${bytes} bytes; limit is ${FCM_MAX_DATA_BYTES}`);
    this.name = "FcmPayloadTooLargeError";
  }
}

function assertDataSize(data: Record<string, string>): void {
  const bytes = fcmDataBytes(data);
  if (bytes > FCM_MAX_DATA_BYTES) throw new FcmPayloadTooLargeError(bytes);
}

/** Drop undefined / null values; FCM data is a flat string map. */
function toData(obj: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}

export interface FcmTargetOptions {
  /** The app's id for this server (`fcm_devices.client_server_id`), echoed as `serverId`. */
  serverId?: string | null;
}

/**
 * `type: "alert"` from the same `AlertInput` the APNs alert is built from.
 * `sound: null` (silent on iOS) becomes `sound: "none"`; `time-sensitive`
 * becomes `timeSensitive: "1"`; `extra` keys (e.g. `prUrl`) ride along as
 * strings unless they collide with a core key.
 */
export function buildFcmAlertMessage(input: AlertInput, opts: FcmTargetOptions = {}): FcmMessage {
  const alert: AndroidPushAlert = {
    type: "alert",
    category: input.category,
    title: input.title.slice(0, 200),
    subtitle: input.subtitle ? input.subtitle.slice(0, 200) : undefined,
    body: input.body.slice(0, 500),
    url: input.url,
    kind: input.kind,
    id: input.id,
    threadId: input.threadId,
    sound: input.sound === null ? "none" : "default",
    timeSensitive: input.interruptionLevel === "time-sensitive" ? "1" : undefined,
    collapseId: input.collapseId ?? `${input.kind}-${input.id}`,
    serverId: opts.serverId ?? undefined,
  };
  const data = toData(alert);
  for (const [k, v] of Object.entries(input.extra ?? {})) {
    if (v === undefined || v === null || k in data || isReservedDataKey(k)) continue;
    data[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  assertDataSize(data);
  return { data, android: { priority: "HIGH", ttl: `${FCM_ALERT_TTL_SEC}s` } };
}

export interface FcmWatchInput extends FcmTargetOptions {
  event: AndroidPushWatchEvent;
  state: WatchState;
  /** The frame alerts (the iOS Live Activity would ring) → HIGH priority. */
  alert?: boolean;
}

/**
 * Ways to shrink an oversized Watch frame, least valuable detail first. The
 * counts (`needsYouCount`, tiles) always survive, so the app can still say
 * "3 need you" when the rows themselves had to go.
 */
const WATCH_SHRINK_STEPS: Array<(s: WatchState) => WatchState> = [
  (s) => ({ ...s, others: s.others.map((o) => ({ ...o, preview: null })) }),
  (s) => ({ ...s, head: s.head ? { ...s.head, preview: null } : s.head }),
  (s) => ({ ...s, others: [] }),
  (s) => ({
    ...s,
    head: s.head
      ? {
          ...s.head,
          title: s.head.title.slice(0, 80),
          mono: s.head.mono.slice(0, 40),
          reason: s.head.reason ? s.head.reason.slice(0, 80) : s.head.reason,
          prUrl: null,
          where: null,
        }
      : s.head,
  }),
];

function watchData(input: FcmWatchInput, state: WatchState): Record<string, string> {
  const watch: AndroidPushWatch = {
    type: "watch",
    event: input.event,
    state: JSON.stringify(state),
    serverId: input.serverId ?? undefined,
  };
  return toData(watch);
}

/** `type: "watch"`: one Watch frame for every Android device of the user. */
export function buildFcmWatchMessage(input: FcmWatchInput): FcmMessage {
  let state = input.state;
  let data = watchData(input, state);
  for (const shrink of WATCH_SHRINK_STEPS) {
    if (fcmDataBytes(data) <= FCM_MAX_DATA_BYTES) break;
    state = shrink(state);
    data = watchData(input, state);
  }
  assertDataSize(data);
  return {
    data,
    android: {
      priority: input.alert ? "HIGH" : "NORMAL",
      ttl: `${FCM_WATCH_TTL_SEC}s`,
      collapse_key: FCM_WATCH_COLLAPSE_KEY,
    },
  };
}
