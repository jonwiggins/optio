# Android push (FCM)

The Android app's glanceable surfaces are the ongoing "Watch" notification
(the Android counterpart of the iOS Live Activity), needs-you notifications
with actions, and the widgets they refresh. The API can feed them over
**Firebase Cloud Messaging** (FCM HTTP v1). Server push is optional. Without
it, the app uses its on-device baseline: `/ws/events` while it runs, a
15-minute WorkManager poll of `GET /api/glance/watch`, and an opt-in "Keep
watching" foreground service.

This page covers setup, the wire contract, and how to test without a device.
The iOS twin is `docs/ios-push.md`. Both platforms get the same events,
categories, deep links and preference keys from the same fan-out
(`apps/api/src/services/push-fanout.ts`). Web push (VAPID), APNs and FCM share
the per-user preference map at `GET/PUT /api/notifications/preferences`.

## Setup

The server authenticates with a **service-account key** and doesn't need a
Firebase SDK. It signs an RS256 JWT with `node:crypto` and exchanges it at
`https://oauth2.googleapis.com/token` for a one-hour access token (scope
`firebase.messaging`). The token is cached until 5 minutes before it expires,
and a 401 from FCM mints a new one once. Traffic is **outbound** only, to
`oauth2.googleapis.com` and `fcm.googleapis.com` on port 443, so like APNs it
needs no ingress change.

1. Create a Firebase project in the [Firebase console](https://console.firebase.google.com/).
   Analytics is not needed.
2. **Add an Android app** to the project with package name `dev.optio.android`.
   Download `google-services.json` and put it at `apps/android/app/google-services.json`
   before you build the app. The Gradle build applies the google-services plugin
   only when that file exists. Without it, the app's FCM code paths are no-ops.
   The file holds project identifiers, not secrets, but it is specific to one
   project, so keep it out of git.
3. **Create a service-account key for the server.** In the Firebase console,
   open **Project settings → Service accounts** and click **Generate new private
   key**. This downloads a JSON key.

   You can also use Google Cloud IAM. Pick a service account that has the
   role _Firebase Cloud Messaging API Admin_
   (`roles/firebasecloudmessaging.admin`), then choose **Keys → Add key → JSON**.

   The _Firebase Cloud Messaging API (V1)_ must be enabled for the project.
   New Firebase projects have it enabled.

4. Paste the key into the Helm values, or use
   `--set-file notifications.fcm.serviceAccount=optio-fcm.json`:

   ```yaml
   notifications:
     fcm:
       serviceAccount: |
         {
           "type": "service_account",
           "project_id": "my-optio",
           "private_key_id": "…",
           "private_key": "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n",
           "client_email": "firebase-adminsdk-xxxxx@my-optio.iam.gserviceaccount.com",
           …
         }
       projectId: "" # optional; defaults to the key's project_id
   ```

   To keep the key out of values, create a Secret yourself and set
   `notifications.fcm.existingSecret: optio-fcm`. The Secret's keys are
   `OPTIO_FCM_SERVICE_ACCOUNT` and, optionally, `OPTIO_FCM_PROJECT_ID`:

   ```bash
   kubectl -n optio create secret generic optio-fcm \
     --from-file=OPTIO_FCM_SERVICE_ACCOUNT=optio-fcm.json
   ```

5. Run `helm upgrade optio helm/optio -n optio --reuse-values -f values.yaml`.
   At boot the API logs one of these lines:
   - `FCM configured`, with the project id and the service account's email.
   - `FCM not configured — Android push disabled`, logged once when there is
     no key. Every hook is then a no-op.
   - `FCM: invalid service account key`, with a reason (never the key).

Outside Helm, these environment variables apply:

- `OPTIO_FCM_SERVICE_ACCOUNT`: the key JSON, or base64 of it. Literal `\n`
  escapes in `private_key` are accepted.
- `OPTIO_FCM_SERVICE_ACCOUNT_FILE`: a path to the key JSON, used instead of
  the variable above.
- `OPTIO_FCM_PROJECT_ID`: defaults to the key's `project_id`.
- `OPTIO_FCM_TRANSPORT=fake`: record sends instead of sending them.
- `OPTIO_FCM_FAKE_OUTBOX=<file>`: with the fake transport, also append every
  request as one JSON line.

### One Firebase project per app build

An FCM registration token is bound to the Firebase project in the app's
`google-services.json`. Every Optio server that pushes to that build must use a
service-account key from the **same** project. A token from another project
comes back as `SENDER_ID_MISMATCH`, and the server drops the device row. The
symptom is devices disappearing from `GET /api/notifications/devices`, which is
the FCM equivalent of an APNs sandbox/production mismatch.

## Routes

These routes are shared with iOS. They need an authenticated user, and writes
need the **member** role. Rows are always scoped to the caller.

| Method   | Path                              | Body                                                                         | Response                                      |
| -------- | --------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| `POST`   | `/api/notifications/devices`      | `{ platform: "android", token, appId, appVersion?, deviceName?, serverId? }` | `201 { device }` (token masked)               |
| `GET`    | `/api/notifications/devices`      | —                                                                            | `200 { devices: [...], push: { apns, fcm } }` |
| `DELETE` | `/api/notifications/devices/:ref` | —                                                                            | `204` (also when absent)                      |
| `POST`   | `/api/notifications/devices/test` | —                                                                            | `200 { sent }` / `503`                        |
| `GET`    | `/api/glance/watch`               | —                                                                            | `200 WatchState`                              |

- **Register (`POST`).** Upserts by token. Re-registering resets the failure
  counter, and a token that re-registers under another user moves to that user.
  - FCM tokens must match `[A-Za-z0-9_:.-]{32,1024}`. They are case-sensitive
    and stored exactly as sent, unlike APNs hex tokens, which are lower-cased.
  - `serverId` is the app's own id for this server (its paired-server profile).
    The server echoes it as `serverId` in every message, so an app paired with
    several servers can route a push without probing each one.
  - iOS keeps its body: `{ token, platform?: "ios", environment?, bundleId, … }`.
- **List (`GET`).** Returns iOS and Android rows. Every row has a `platform`.
  iOS rows also carry `environment` and `bundleId`; Android rows carry `appId`
  and `serverId`. The `push` object says which providers the server holds
  credentials for.
- **Delete (`DELETE`).** `:ref` is a raw token (APNs hex or FCM) or a row `id`
  from the list. The list masks tokens, so use the row `id` to delete a device
  you don't hold.
- **Test.** Sends one alert to every device, through APNs and FCM. `sent`
  counts accepted sends across both. The route returns 503 only when neither
  provider is configured.

The app should register its token with **every** paired server on each launch
and whenever `FirebaseMessagingService.onNewToken` fires. When the user forgets
a server, the app should `DELETE` the token from that server.

## Events → pushes

Alerts go through the same per-user preference checks as web push and APNs,
keyed by the event type in the second column.

| Event                                                          | Preference key                         | `category`                            | `sound`                                            | `threadId` · `url`                             | Watch (Android)                                |
| -------------------------------------------------------------- | -------------------------------------- | ------------------------------------- | -------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| Running agent terminal → `needs_you` (stop/notification/quiet) | `local.needs_you`                      | `LOCAL_NEEDS_YOU` (+ `timeSensitive`) | `default` only if the queue was empty, else `none` | terminal id · `optio://local/<id>?compose=1`   | `update` (HIGH when the queue was empty)       |
| Automated terminal (`spawnedBy != manual`) exits               | `local.needs_you`                      | `LOCAL_EXIT`                          | `none`                                             | terminal id · `optio://local/<id>`             | `update`                                       |
| Host goes offline with agents running                          | `local.host_offline`                   | `HOST_OFFLINE`                        | `default` (once per outage)                        | `host-<id>` · `optio://local`                  | `update` (`phase: offline`)                    |
| Task → `needs_attention` / `failed`                            | `task.needs_attention` / `task.failed` | `TASK_ATTENTION` (+ `timeSensitive`)  | `default`                                          | `task-<id>` · `optio://tasks/<id>`             | refresh (only while a Watch is showing)        |
| Task → `pr_opened`                                             | `task.pr_opened`                       | `TASK_PR_OPENED` (+ `prUrl`)          | `default`                                          | `task-<id>` · `optio://tasks/<id>`             | refresh (only while a Watch is showing)        |
| Agent turn halts after draining a user's message               | `agent.turn_completed`                 | `AGENT_REPLY`                         | `default`                                          | `agent-<id>` · `optio://agents/<id>?compose=1` | —                                              |
| Agent → `failed` (consecutive-failure limit)                   | `agent.failed`                         | `AGENT_FAILED` (+ `timeSensitive`)    | `default`                                          | `agent-<id>` · `optio://agents/<id>`           | —                                              |
| Snooze / unsnooze / snooze expiry                              | —                                      | —                                     | —                                                  | —                                              | `update`                                       |
| First active frame (a running agent, or one needing you)       | —                                      | —                                     | —                                                  | —                                              | **`start`**                                    |
| Nothing running or waiting for 2 min                           | —                                      | —                                     | —                                                  | —                                              | **`end`** (`phase: done`, `summary: "Quiet."`) |

The `category` values are the iOS ones, so the Android app should create
notification channels and actions per category, mirroring
`apps/ios/Optio/Core/Notifications/NotificationCategories.swift`:

- `LOCAL_NEEDS_YOU`: Reply, Later
- `LOCAL_EXIT`: Open
- `TASK_ATTENTION`: Resume, Retry, Open
- `TASK_PR_OPENED`: Open PR
- `AGENT_REPLY`: Reply
- `AGENT_FAILED`: Resume

`TEST` is used only by the test route.

## Payloads

Every message is **data-only**, with no `notification` block. That means
`onMessageReceived` runs in the background too, and the app renders every
notification itself. All `data` values are strings.

### Alert

The request body the server POSTs to
`https://fcm.googleapis.com/v1/projects/<project>/messages:send`:

```json
{
  "message": {
    "token": "<FCM registration token>",
    "data": {
      "type": "alert",
      "category": "LOCAL_NEEDS_YOU",
      "title": "Needs you · web",
      "subtitle": "claude-code · mbp",
      "body": "Waiting on a permission · Allow Bash(rm -rf)?",
      "url": "optio://local/<terminal id>?compose=1",
      "kind": "local",
      "id": "<terminal id>",
      "threadId": "<terminal id>",
      "sound": "default",
      "timeSensitive": "1",
      "collapseId": "local-<terminal id>",
      "serverId": "<the app's id for this server>"
    },
    "android": { "priority": "HIGH", "ttl": "86400s" }
  }
}
```

| Key             | Always | Meaning                                                                                                                                                               |
| --------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`          | yes    | `alert`                                                                                                                                                               |
| `category`      | yes    | see the table above; drives the channel and actions                                                                                                                   |
| `title`         | yes    | ≤ 200 chars                                                                                                                                                           |
| `subtitle`      | no     | ≤ 200 chars (the terminal title for Local alerts)                                                                                                                     |
| `body`          | yes    | ≤ 500 chars                                                                                                                                                           |
| `url`           | yes    | deep link to open on tap                                                                                                                                              |
| `kind`          | yes    | `local` · `host` · `task` · `agent` · `test`                                                                                                                          |
| `id`            | yes    | subject id; the target of actions (reply, snooze, resume, …)                                                                                                          |
| `threadId`      | yes    | group key (the APNs `thread-id`)                                                                                                                                      |
| `sound`         | yes    | `default` or `none`                                                                                                                                                   |
| `timeSensitive` | no     | `"1"` when iOS would mark the alert time-sensitive                                                                                                                    |
| `prUrl`         | no     | `TASK_PR_OPENED` when the task has a PR                                                                                                                               |
| `collapseId`    | yes    | the APNs `apns-collapse-id` (`local-<id>`, `task-<id>`, `agent-<id>-<turn>`); use it as the notification tag so a newer alert replaces an older one exactly as on iOS |
| `serverId`      | no     | the `serverId` the app registered with                                                                                                                                |

Alerts carry no `collapse_key`. FCM collapsible messages are throttled and only
four collapse keys are kept per device, so alerts must never replace each other
inside FCM. The app does the replacing, with `collapseId` as the notification
tag.

### Watch

```json
{
  "message": {
    "token": "<FCM registration token>",
    "data": {
      "type": "watch",
      "event": "update",
      "state": "{\"phase\":\"waiting\",\"head\":{\"kind\":\"local\",\"id\":\"…\",\"title\":\"claude-code\",\"mono\":\"web\",\"reason\":\"Waiting on a permission\",\"preview\":\"Allow Bash(rm -rf)?\",\"since\":811339200,\"state\":\"needs_you\",\"link\":\"optio://local/…?compose=1\",\"source\":\"local-terminal\",\"when\":\"now\",\"where\":{\"target\":\"machine\",\"detail\":\"mbp · ~/repos/optio/apps/web\"},\"who\":\"claude-code\",\"then\":\"waits-for-me\",\"statusLabel\":\"needs you\"},\"others\":[],\"needsYouCount\":1,\"runningCount\":2,\"waitingCount\":1,\"recurringCount\":4,\"agentCount\":2,\"offlineSince\":null,\"summary\":null,\"asOf\":811339200}",
      "serverId": "<the app's id for this server>"
    },
    "android": { "priority": "HIGH", "ttl": "3600s", "collapse_key": "watch" }
  }
}
```

- **`state`** is the JSON-encoded `WatchState` from
  `packages/shared/src/types/glance.ts`. It is the same frame as the iOS Live
  Activity's `content-state` and `GET /api/glance/watch`. **Dates are Apple
  reference-date seconds**; add `978307200` to get unix seconds.
- **`event`** follows the Watch lifecycle as the server sees it:
  - `start`: the first active frame since the last `end`, or since the API
    process started.
  - `update`: every frame after that.
  - `end`: the final `done` frame, sent after 2 minutes with nothing running or
    waiting.

  Every event carries the full frame, and the app decides what to show:
  - Treat an `update` for a Watch you aren't showing like a `start`.
  - Treat an `end` for a Watch you aren't showing as a no-op.

- **Priority** is `NORMAL`, or `HIGH` when the frame alerts. A frame alerts when
  something newly needs you and the queue was empty. A separate
  `LOCAL_NEEDS_YOU` alert carries the sound, so the Watch update itself can be
  silent.
- **Ordering.** FCM doesn't guarantee order across priorities. Drop a frame
  whose `state.asOf` is older than the one you are showing.
- **Collapsing.** All frames share `collapse_key: "watch"`, so a device coming
  back online gets only the newest one. FCM also throttles collapsible messages
  per device: a burst of 20, then about one every 3 minutes. Treat the Watch as
  eventually consistent, and refresh from `GET /api/glance/watch` or
  `/ws/events` while the app is open.
- **Recipients.** Android has no per-activity push tokens, so every Watch frame
  goes to **all** of the user's Android devices.

The generated Kotlin models (`pnpm gen:kotlin`, package `dev.optio.core.model`)
cover both message types, with a sealed `AndroidPushMessage` (`AndroidPushAlert`,
`AndroidPushWatch`, or `Unknown`) plus `WatchState`, `PushDevice`, and
`PushDevicesResponse`:

```kotlin
val message = OptioJson.decodeFromJsonElement(
    AndroidPushMessage.serializer(),
    JsonObject(remoteMessage.data.mapValues { JsonPrimitive(it.value) }),
)
when (message) {
    is AndroidPushAlert -> postAlert(message)
    is AndroidPushWatch -> updateWatch(message.event, OptioJson.decodeFromString<WatchState>(message.state))
    is AndroidPushMessage.Unknown -> Unit
}
```

Android may lower the priority of an app whose HIGH-priority messages don't
show anything to the user. Every HIGH message, whether an alert or an alerting
Watch frame, should post or update a visible notification.

## Delivery rules

- **Size.** FCM caps the payload at 4 KB, measured here on the JSON-encoded
  `data` (escapes included). Alert fields are clipped as on iOS. A Watch frame
  over the cap sheds detail in this order until it fits:
  1. previews of the other rows
  2. the head row's preview
  3. the other rows
  4. the head row's long fields

  The counts always survive.

- **Watch rate.** Each device gets at most one Watch message per second. This
  is the Live Activity coalescer (`watch-coalescer.ts`, shared with APNs): the
  trailing edge sends, the latest frame wins, and an alerting frame is never
  downgraded by a later silent one. `start` and `end` are never downgraded to
  `update`. An `update` identical to the last frame sent is dropped (`asOf` is
  ignored in the comparison).
- **Bad tokens.** The server deletes the row at once on any of these:
  - `UNREGISTERED`, or HTTP 404
  - `SENDER_ID_MISMATCH`
  - `INVALID_ARGUMENT` that names `message.token`

  Five consecutive failures of any other kind also delete the row, and a
  success resets the counter.

- **Server-side failures don't count against devices.** If the token exchange
  fails, or FCM answers 401 or 403 `PERMISSION_DENIED` (the server's own
  credentials), the device's failure counter is left alone. The error is logged
  at most once a minute.
- **Fire and forget.** Everything is fire-and-forget from the producing
  service, through `apps/api/src/services/glance-service.ts` and the provider
  fan-out in `push-fanout.ts`. A provider that fails never blocks the other.

## Testing

**Without Firebase or a device** (what CI runs):

- `pnpm turbo test` runs these unit tests:
  - `fcm-payloads.test.ts`: payloads, parity with APNs, size cap and shedding
  - `fcm-auth.test.ts`: key parsing, JWT signature, token cache and backoff
  - `fcm-transport.test.ts`: HTTP v1 requests, the 401 retry, error → drop
    decisions
  - `fcm-service.test.ts`: fan-out, drops, the Watch lifecycle, coalescing
  - `watch-coalescer.test.ts`
  - `glance-service.test.ts`: one fan-out over APNs and FCM
  - `notifications-apns.test.ts`: the device routes for both platforms
- `pnpm --filter @optio/api test:integration` runs `fcm.int.test.ts` against
  real Postgres. It covers the `fcm_devices` store, the preference gate shared
  by both providers, and both providers driven by real terminal events.
- `pnpm --filter @optio/api test:e2e` runs `android-push.e2e.test.ts`. It boots
  the real server with auth enabled and `OPTIO_FCM_TRANSPORT=fake`, registers a
  device, drives a Local agent terminal and repo tasks, and reads the requests
  the server would have sent from `OPTIO_FCM_FAKE_OUTBOX`.

**Grabbing real payloads.** Run any API (for example the Android private test
API) with `OPTIO_FCM_TRANSPORT=fake OPTIO_FCM_FAKE_OUTBOX=/tmp/fcm.jsonl`. Each
line in that file is one HTTP v1 request body. `LOG_LEVEL=debug` also logs each
send as `FCM (fake): recorded send`.

To exercise the app's handler without Firebase, feed a line's `data` to a
Robolectric test with `RemoteMessage.Builder("x").setData(data).build()`.

**On a device** (needs the key above and a build with `google-services.json`):

1. Install the build and allow notifications.
2. Check that the device appears in `GET /api/notifications/devices` with
   `platform: "android"` and `push.fcm: true`.
3. Send `POST /api/notifications/devices/test`.
4. For the Watch, start an agent terminal from the Local page. The ongoing
   notification should appear within a couple of seconds.

To isolate a token problem, send to the token directly with the key:

```bash
gcloud auth activate-service-account --key-file=optio-fcm.json
curl -sS -X POST "https://fcm.googleapis.com/v1/projects/<project>/messages:send" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"message":{"token":"<token>","data":{"type":"alert","category":"TEST","title":"Optio test","body":"Hello","url":"optio://settings","kind":"test","id":"test","threadId":"test","sound":"default","collapseId":"test-test"},"android":{"priority":"HIGH"}}}'
```
