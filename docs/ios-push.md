# iOS push (APNs)

The iOS app's glanceable surfaces — the "Watch" Live Activity in the Dynamic
Island, the needs-you notifications, and the widgets they refresh — are fed by
the API over APNs. This page covers setup, the wire contract, and how to test
without a device. Design background: `docs/design/ios-glanceable-surfaces.md`
(product) and `docs/design/ios-glanceable-architecture.md` (architecture).

Web push (VAPID) is unaffected; both providers share the per-user preference
map at `GET/PUT /api/notifications/preferences`.

## Setup

APNs uses **token-based auth** (a `.p8` signing key — no yearly certificate
rotation). One key serves every app under the team and both APNs hosts.

1. In the [Apple Developer portal](https://developer.apple.com/account/resources/authkeys/list),
   **Certificates, Identifiers & Profiles → Keys → +**, enable
   **Apple Push Notifications service (APNs)**, register, and download
   `AuthKey_<KEY_ID>.p8`. It downloads once — keep it somewhere safe.
   Note the **Key ID** (10 chars) and your **Team ID** (Membership page).
2. Make sure the app id (`dev.optio.ios` by default) has the **Push
   Notifications** capability, and the Xcode target has the `aps-environment`
   entitlement (Xcode adds it when you toggle the capability).
3. Paste into Helm values (or `--set-file notifications.apns.key=AuthKey.p8`):

   ```yaml
   notifications:
     apns:
       keyId: "ABC123DEFG"
       teamId: "TEAM123456"
       key: |
         -----BEGIN PRIVATE KEY-----
         ...
         -----END PRIVATE KEY-----
       bundleId: "dev.optio.ios"
       environment: "sandbox" # or "production"
   ```

   Or keep the key out of values with a pre-created Secret and
   `notifications.apns.existingSecret: my-apns-secret` (keys:
   `OPTIO_APNS_KEY_ID`, `OPTIO_APNS_TEAM_ID`, `OPTIO_APNS_KEY`, optional
   `OPTIO_APNS_BUNDLE_ID`, `OPTIO_APNS_ENVIRONMENT`).

4. `helm upgrade optio helm/optio -n optio --reuse-values -f values.yaml`.
   The API logs `APNs configured` at boot; without a key it logs
   `APNs key not set — iOS push notifications disabled` once and every hook is
   a no-op.

Environment variables (outside Helm): `OPTIO_APNS_KEY_ID`, `OPTIO_APNS_TEAM_ID`,
`OPTIO_APNS_KEY` (PEM; `\n` escapes are accepted) or `OPTIO_APNS_KEY_FILE`,
`OPTIO_APNS_BUNDLE_ID` (default `dev.optio.ios`), `OPTIO_APNS_ENVIRONMENT`
(default `sandbox`), `OPTIO_APNS_TRANSPORT=fake` (record instead of send —
pipeline e2e).

### Sandbox vs production

Apple runs two hosts and a token only works on one:

| Build                           | Token environment | Host                         |
| ------------------------------- | ----------------- | ---------------------------- |
| Xcode run / Debug on device     | `sandbox`         | `api.sandbox.push.apple.com` |
| TestFlight / App Store / Ad Hoc | `production`      | `api.push.apple.com`         |

The **app** tells the server which one each token belongs to when it registers
(`environment` in the request body); `OPTIO_APNS_ENVIRONMENT` is only the
default when the app omits it. A token sent to the wrong host comes back as
`400 BadDeviceToken` and is dropped, so a mismatch shows up as devices
vanishing from `GET /api/notifications/devices`.

The simulator never receives real pushes; see "Testing" below.

## Routes

All routes require an authenticated user and (for writes) the **member** role.
Rows are always scoped to the caller. Tokens are hex (32–512 chars); the server
lower-cases them.

| Method   | Path                                                     | Body                                                                            | Response                        |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| `POST`   | `/api/notifications/devices`                             | `{ token, platform?: "ios", environment?, bundleId, appVersion?, deviceName? }` | `201 { device }` (token masked) |
| `GET`    | `/api/notifications/devices`                             | —                                                                               | `200 { devices: [...] }`        |
| `DELETE` | `/api/notifications/devices/:token`                      | —                                                                               | `204`                           |
| `POST`   | `/api/notifications/devices/test`                        | —                                                                               | `200 { sent }` / `503`          |
| `POST`   | `/api/notifications/live-activities/:kind/token`         | `{ token, environment?, subjectId? }`                                           | `201 { ok: true }`              |
| `DELETE` | `/api/notifications/live-activities/:kind/token`         | `{ token }`                                                                     | `204`                           |
| `POST`   | `/api/notifications/live-activities/:kind/push-to-start` | `{ token, environment? }`                                                       | `201 { ok: true }`              |
| `POST`   | `/api/local/terminals/:id/snooze`                        | `{ minutes?: 1–1440 }` (default 15)                                             | `200 { terminal }`              |
| `DELETE` | `/api/local/terminals/:id/snooze`                        | —                                                                               | `200 { terminal }`              |

`:kind` is `watch` — the one aggregate Live Activity per user. Registration is
an upsert by token (re-registering resets the failure counter; a token that
re-registers under another user moves to them). The app should re-register the
device token on every launch, the update token whenever ActivityKit rotates it,
and the push-to-start token from `Activity.pushToStartTokenUpdates`.

Snooze ("Later") is server-side so the Watch, widgets and web agree: while
`snoozedUntil` is in the future the terminal is not in the needs-you queue.
Attention state is untouched (the daemon owns it), so the item resurfaces when
the window closes. `LocalTerminal.snoozedUntil` is in the shared types.

## Events → pushes

Alerts go through the same per-user preference checks as web push
(`notification_preferences`), keyed by the event type in the second column.
New event types: `local.needs_you`, `local.host_offline`,
`agent.turn_completed`, `agent.failed` (all default on).

| Event                                                          | Preference key                         | Alert category               | Sound                       | Thread / deep link                             | Watch                                     |
| -------------------------------------------------------------- | -------------------------------------- | ---------------------------- | --------------------------- | ---------------------------------------------- | ----------------------------------------- |
| Running agent terminal → `needs_you` (stop/notification/quiet) | `local.needs_you`                      | `LOCAL_NEEDS_YOU`            | only if the queue was empty | terminal id · `optio://local/<id>?compose=1`   | update (alerting when queue was empty)    |
| Automated terminal (`spawnedBy != manual`) exits               | `local.needs_you`                      | `LOCAL_EXIT`                 | none                        | terminal id · `optio://local/<id>`             | update                                    |
| Host goes offline with agents running                          | `local.host_offline`                   | `HOST_OFFLINE`               | default (once per outage)   | `host-<id>` · `optio://local`                  | update (`phase: offline`)                 |
| Task → `needs_attention` / `failed`                            | `task.needs_attention` / `task.failed` | `TASK_ATTENTION`             | default                     | `task-<id>` · `optio://tasks/<id>`             | refresh                                   |
| Task → `pr_opened`                                             | `task.pr_opened`                       | `TASK_PR_OPENED` (+ `prUrl`) | default                     | `task-<id>` · `optio://tasks/<id>`             | refresh                                   |
| Agent turn halts after draining a user's message               | `agent.turn_completed`                 | `AGENT_REPLY`                | default                     | `agent-<id>` · `optio://agents/<id>?compose=1` | —                                         |
| Agent → `failed` (consecutive-failure limit)                   | `agent.failed`                         | `AGENT_FAILED`               | default                     | `agent-<id>` · `optio://agents/<id>`           | —                                         |
| Snooze / unsnooze / snooze expiry                              | —                                      | —                            | —                           | —                                              | update                                    |
| First running agent terminal, no live Watch                    | —                                      | —                            | —                           | —                                              | **push-to-start**                         |
| Nothing running or waiting for 2 min                           | —                                      | —                            | —                           | —                                              | **end** (`phase: done`, 15 min dismissal) |

Alert payload:

```json
{
  "aps": {
    "alert": {
      "title": "Needs you · web",
      "subtitle": "claude-code",
      "body": "Waiting on a permission · Allow Bash(rm -rf)?"
    },
    "sound": "default",
    "thread-id": "<terminal id>",
    "category": "LOCAL_NEEDS_YOU",
    "interruption-level": "time-sensitive"
  },
  "url": "optio://local/<terminal id>?compose=1",
  "kind": "local",
  "id": "<terminal id>"
}
```

Live Activity payload (`apns-push-type: liveactivity`, topic
`<bundle>.push-type.liveactivity`, priority 10 when `alert` is present else 5):

```json
{
  "aps": {
    "timestamp": 1789646400,
    "event": "update",
    "content-state": {
      "phase": "waiting",
      "head": {
        "kind": "local",
        "id": "…",
        "title": "claude-code",
        "mono": "web",
        "reason": "Waiting on a permission",
        "preview": "Allow Bash(rm -rf)?",
        "since": 811339200,
        "state": "needs_you",
        "link": "optio://local/…?compose=1",
        "source": "local-terminal",
        "when": "now",
        "where": { "target": "machine", "detail": "mbp · ~/repos/optio/apps/web" },
        "who": "claude-code",
        "then": "waits-for-me",
        "statusLabel": "needs you"
      },
      "others": [],
      "needsYouCount": 1,
      "runningCount": 2,
      "waitingCount": 1,
      "recurringCount": 4,
      "agentCount": 2,
      "asOf": 811339200
    },
    "stale-date": 1789646520,
    "relevance-score": 100,
    "alert": { "title": "Needs you · web", "body": "Waiting on a permission", "sound": "default" }
  }
}
```

`content-state` is the Swift `WatchState` (`apps/ios/Shared/WatchActivity.swift`,
mirrored in `packages/shared/src/types/glance.ts`). **Dates are seconds since
2001-01-01 UTC** (Foundation's reference date) because ActivityKit decodes the
state with a default `JSONDecoder`. `end` frames add `dismissal-date`; `start`
frames (push-to-start) add `"attributes-type": "WatchAttributes"` and
`attributes: { userId, startedAt }`.

Since v0.5 ("one noun: Sessions") every item also carries the four session
chips the app shows — `source`, `when`, `where { target, detail }`, `who`,
`then`, `statusLabel` — and the frame carries the board tiles the Watch cannot
derive from its own items: `waitingCount` (the user's tasks at an open PR plus
idle agent terminals), `recurringCount` (enabled blueprints / Jobs in the user's
workspaces plus their enabled Local automations) and `agentCount` (persistent
agents not archived). All of it is optional and additive: older apps ignore the
keys, and the app's `WatchItem` derives every chip from `kind` / `title` / `mono`
when a frame predates them. `where.detail` is clamped to 60 chars (head-first,
the leaf survives) and `preview` to 120 so a full frame stays well under 4 KB.
`GET /api/glance/watch` returns the caller's current frame — the widgets read it
for the tiles so they render without the app running.

Delivery rules: ≤1 Live Activity push per token per second (trailing edge, the
latest frame wins, an alerting frame is never downgraded by a later silent one),
identical frames are deduped, alerts carry `apns-collapse-id` (`local-<id>`,
`task-<id>`, `agent-<id>-<turn>`), `410`/`Unregistered`/`BadDeviceToken` delete
the row immediately, 5 consecutive failures delete it, success resets the
counter. Everything is fire-and-forget from the producing service
(`local-terminal-service.notifyChanged`, `local-host-service`,
`taskService.transitionTask`, `persistent-agent-service`) via
`apps/api/src/services/glance-service.ts`.

## Testing

**Without an Apple account** (unit / integration / e2e — what CI runs):

- `pnpm turbo test` — payload builders (`apns-payloads.test.ts`, incl. the 4 KB
  cap), the service with a fake transport (`apns-service.test.ts`: fan-out,
  dedupe, coalescing, 410 and 5-failure drops, unconfigured no-op), the event
  hooks (`glance-service.test.ts`) and the routes (`notifications-apns.test.ts`).
- `pnpm --filter @optio/api test:integration` — `apns.int.test.ts` runs the
  token routes' store, cascades, the drizzle failure counter and the snooze →
  Watch computation against real Postgres.
- `OPTIO_APNS_TRANSPORT=fake` makes the running API record sends in memory
  instead of talking to Apple.

**Simulator** (no account needed for alerts; Live Activities need Xcode 16+):

```bash
# Alert notification
cat > needs-you.apns <<'EOF'
{
  "Simulator Target Bundle": "dev.optio.ios",
  "aps": { "alert": { "title": "Needs you · web", "body": "Waiting on a permission" },
           "sound": "default", "thread-id": "t1", "category": "LOCAL_NEEDS_YOU" },
  "url": "optio://local/t1?compose=1", "kind": "local", "id": "t1"
}
EOF
xcrun simctl push booted dev.optio.ios needs-you.apns

# Live Activity update (the activity must already be running in the simulator)
cat > watch.apns <<'EOF'
{
  "Simulator Target Bundle": "dev.optio.ios",
  "aps": { "timestamp": 1789646400, "event": "update", "relevance-score": 100,
           "content-state": { "phase": "waiting", "head": { "kind": "local", "id": "t1", "title": "claude-code", "mono": "web", "reason": "Waiting on a permission", "since": 811339200, "state": "needs_you", "link": "optio://local/t1?compose=1" }, "others": [], "needsYouCount": 1, "runningCount": 0, "asOf": 811339200 } }
}
EOF
xcrun simctl push booted dev.optio.ios watch.apns
```

You can also grab a payload the server actually built: run the API with
`OPTIO_APNS_TRANSPORT=fake` and `LOG_LEVEL=debug`, or copy one out of the unit
tests.

**On a device** (needs the key above and a paid developer account): install a
build, confirm the device appears in `GET /api/notifications/devices`, then
`POST /api/notifications/devices/test`. For the Watch, start an agent terminal
from the Local page; `POST /api/local/terminals/:id/snooze` should drop it from
the island within ~2 s.
