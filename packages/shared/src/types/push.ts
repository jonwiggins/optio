// Native push to the Optio apps: APNs for iOS (docs/ios-push.md) and Firebase
// Cloud Messaging for Android (docs/android-push.md). Devices register at
// `/api/notifications/devices`; the Android data-message shapes below are the
// wire contract between the API (apps/api/src/services/fcm-payloads.ts) and
// the app's FirebaseMessagingService.

/** Which push service a device registered with. */
export type PushPlatform = "ios" | "android";

/**
 * One registered device in `GET /api/notifications/devices`. The token is
 * masked (`abcdef…wxyz`), so delete a listed device by its `id`, or your own
 * by the raw token you hold. iOS rows carry `environment` + `bundleId`,
 * Android rows `appId` (+ `serverId` when the app sent one).
 */
export interface PushDevice {
  id: string;
  /** Masked token. */
  token: string;
  platform: PushPlatform;
  /** iOS only: the APNs host the token belongs to. */
  environment?: "sandbox" | "production" | null;
  /** iOS only. */
  bundleId?: string | null;
  /** Android only: the application id, e.g. `dev.optio.android`. */
  appId?: string | null;
  /** Android only: the app's own id for this server, as sent at registration. */
  serverId?: string | null;
  appVersion: string | null;
  deviceName: string | null;
  /** Consecutive failed sends; the row is dropped at 5. */
  failureCount: number;
  lastSeenAt: string;
  createdAt: string;
}

/** Which native push providers this server holds credentials for. */
export interface PushProviderStatus {
  /** iOS (APNs key configured). */
  apns: boolean;
  /** Android (FCM service account configured). */
  fcm: boolean;
}

/** `GET /api/notifications/devices`: both platforms, plus what the server can send. */
export interface PushDevicesResponse {
  devices: PushDevice[];
  push: PushProviderStatus;
}

/** `POST /api/notifications/devices` body for an Android device (upsert by token). */
export interface RegisterAndroidDeviceRequest {
  platform: "android";
  /** FCM registration token (opaque, case-sensitive). */
  token: string;
  /** Application id, e.g. `dev.optio.android`. */
  appId: string;
  appVersion?: string;
  deviceName?: string;
  /** The app's own id for this server; echoed as `serverId` in every message. */
  serverId?: string;
}

/** Alert categories (iOS `aps.category`, Android `data.category`); the apps attach actions per category. */
export type PushAlertCategory =
  | "LOCAL_NEEDS_YOU"
  | "LOCAL_EXIT"
  | "HOST_OFFLINE"
  | "TASK_ATTENTION"
  | "TASK_PR_OPENED"
  | "AGENT_REPLY"
  | "AGENT_FAILED"
  | "TEST";

/** What an alert is about (`kind` in both payloads). */
export type PushSubjectKind = "local" | "host" | "task" | "agent" | "test";

/**
 * FCM data message `type: "alert"`: a notification the app posts itself.
 * Data-only (no `notification` block), so it reaches the app's
 * FirebaseMessagingService in the background too. Every value is a string.
 */
export interface AndroidPushAlert {
  type: "alert";
  category: PushAlertCategory;
  title: string;
  subtitle?: string;
  body: string;
  /** Deep link, e.g. `optio://local/<id>?compose=1`. */
  url: string;
  kind: PushSubjectKind;
  /** Subject id (terminal / host / task / agent). */
  id: string;
  /** Group key (APNs `thread-id`), e.g. the terminal id or `task-<id>`. */
  threadId: string;
  /** `default` plays the channel's sound; `none` posts silently. */
  sound: "default" | "none";
  /** `"1"` when the alert should break through (iOS `time-sensitive`). */
  timeSensitive?: string;
  /** Pull request URL (`TASK_PR_OPENED`). */
  prUrl?: string;
  /** Replace key (APNs `apns-collapse-id`, e.g. `task-<id>`): use it as the notification tag. */
  collapseId?: string;
  /** The app's id for this server, when it sent one at registration. */
  serverId?: string;
}

/** Lifecycle of the Watch as the server sees it. */
export type AndroidPushWatchEvent = "start" | "update" | "end";

/**
 * FCM data message `type: "watch"`: one frame of the ongoing Watch
 * notification (the iOS Live Activity). `start` and `update` carry the same
 * full state; `end` carries the final `done` frame.
 */
export interface AndroidPushWatch {
  type: "watch";
  event: AndroidPushWatchEvent;
  /** JSON-encoded `WatchState` (glance.ts); dates are Apple reference-date seconds. */
  state: string;
  /** The app's id for this server, when it sent one at registration. */
  serverId?: string;
}

/** Every FCM data message the API sends, discriminated by `type`. */
export type AndroidPushMessage = AndroidPushAlert | AndroidPushWatch;
