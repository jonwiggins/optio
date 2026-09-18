# iOS glanceable surfaces: Live Activities, widgets, Controls, App Intents, APNs

Feasibility and architecture brief for `apps/ios` (branch `feat/ios-app`). Status: proposal, no code yet.

## Constraints this design respects

- The phone reaches the API only over Tailscale (`http://host.tailnet.ts.net:30400`, no public ingress). APNs is **outbound** from the API pod to Apple (`api.push.apple.com:443`), so push works without any ingress change.
- The app authenticates with a PAT (`Authorization: Bearer optio_pat_*`; `optio-auth-<token>` in the WS subprotocol slot). Extensions must reuse that PAT.
- Notifications today are Web Push only (`notification-service.ts`, VAPID env → `push_subscriptions`, 5-failure drop, 404/410 delete). No APNs code exists.
- This Mac has **no Apple Developer Program membership, no signing identity, no Apple ID in Xcode** (`DEVELOPMENT_TEAM: ""` in `project.yml`). Everything below is split into what a free personal team can do and what is gated on the paid program.

## 1. Capability matrix

"Free" = free personal team (Apple ID added to Xcode, 7-day provisioning, device-only). "Paid" = Apple Developer Program. FG/BG/Killed = app foregrounded / suspended in background / not running.

| Feature                                                        | Free team                                                               | Paid team       | FG  | BG                                                         | Killed                         | Entitlements / Info.plist                                                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------- | --- | ---------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WidgetKit home/lock-screen widgets (timeline polling with PAT) | Yes                                                                     | Yes             | Yes | Yes (WidgetKit budget)                                     | Yes                            | Widget extension target; `NSExtensionPointIdentifier=com.apple.widgetkit-extension`; App Group + keychain group recommended (see below)                  |
| Control Center / Lock Screen Controls (iOS 18)                 | Yes                                                                     | Yes             | Yes | Yes                                                        | Yes (intent runs in extension) | Same extension; `ControlWidget` + App Intent in extension                                                                                                |
| App Intents / Shortcuts / Siri                                 | Yes                                                                     | Yes             | Yes | Yes (in-process intents can launch app)                    | Yes                            | None; `AppIntent` types in app target (and extension for Controls)                                                                                       |
| Live Activity, app-driven start/update/end                     | Yes                                                                     | Yes             | Yes | Only during BGAppRefresh windows (≈15 min+, discretionary) | No                             | `NSSupportsLiveActivities=YES`; optional `NSSupportsLiveActivitiesFrequentUpdates`; `UIBackgroundModes: [fetch]` + `BGTaskSchedulerPermittedIdentifiers` |
| Live Activity updates via APNs (`liveactivity` push type)      | **No**                                                                  | Yes             | Yes | Yes                                                        | Yes (activity keeps updating)  | `aps-environment` entitlement (Push Notifications capability) — paid only                                                                                |
| Live Activity push-to-start (iOS 17.2+)                        | **No**                                                                  | Yes             | n/a | Yes                                                        | Yes                            | `aps-environment`; `Activity<A>.pushToStartTokenUpdates`                                                                                                 |
| Remote alert notifications (APNs `alert`)                      | **No**                                                                  | Yes             | Yes | Yes                                                        | Yes                            | `aps-environment`; `UIBackgroundModes: [remote-notification]` for silent pushes                                                                          |
| Local notifications (scheduled by the app)                     | Yes                                                                     | Yes             | Yes | Only if pre-scheduled                                      | Only if pre-scheduled          | `UNUserNotificationCenter` auth prompt only                                                                                                              |
| App Groups (`group.dev.optio.ios`)                             | Yes (Xcode 15+ provisions it for personal teams; verify at first build) | Yes             | —   | —                                                          | —                              | `com.apple.security.application-groups`                                                                                                                  |
| Keychain Sharing (access group)                                | Yes                                                                     | Yes             | —   | —                                                          | —                              | `keychain-access-groups`                                                                                                                                 |
| TestFlight / App Store distribution                            | **No**                                                                  | Yes             | —   | —                                                          | —                              | —                                                                                                                                                        |
| Run on a physical phone                                        | 7-day certs, max 3 devices, rebuild weekly                              | 1-year profiles | —   | —                                                          | —                              | —                                                                                                                                                        |

Graceful degradation without the paid account: widgets poll over the tailnet on the WidgetKit timeline budget; Live Activities start from the app and stay accurate only while the app is foregrounded or briefly during background refresh, going grey past `staleDate`; "needs you" alerts arrive only as in-app state (no banner). With the paid account the same code paths gain push updates, push-to-start and banners; nothing in the app-driven layer is thrown away.

## 2. iOS architecture

### Targets

- `Optio` (existing app target). Gains `LiveActivityManager`, `EventHub`, App Intents (`OpenTaskIntent`, `OpenLocalTerminalIntent`, `OpenAgentIntent`, `KillLocalTerminalIntent`, `SendAgentMessageIntent`), deep-link handling, `BGAppRefreshTask` registration, and APNs device-token registration that is only _called_ when `aps-environment` is present in the embedded provisioning profile, so a free-team build never requests a token it cannot get.
- `OptioWidgets` (new `app-extension` target, XcodeGen `type: app-extension`, `NSExtensionPointIdentifier=com.apple.widgetkit-extension`). One `WidgetBundle` with: `NeedsYouWidget` (Local attention queue), `RunningTasksWidget`, `AgentStatusWidget`, the `ActivityConfiguration`s for the three Live Activity kinds, and the `ControlWidget`s (Kill terminal, Open needs-you, Pause/resume agent). Controls **must** define their `AppIntent` conformers in this target; intents that need the UI use `openAppWhenRun = true` and the same `optio://` URL.
- `Shared/` source folder (`apps/ios/Shared/`, globbed into both targets in `project.yml`): `ActivityAttributes` types (`TaskActivityAttributes`, `LocalTerminalActivityAttributes`, `AgentActivityAttributes`, each with a small `Codable` `ContentState`), `GlanceModels` (the ≤10 fields each surface needs), `GlanceFetchClient` (a 60-line `URLSession` client: base URL + PAT + `x-workspace-id`, GET only, 8 s timeout, no Observation), `DeepLink` (parse/build `optio://…`), `SharedCredentials` (App Group defaults + keychain group).
- `SharedTypes.swift` stays app-only; the extension uses the hand-written mini models (memory ceiling).

### Credentials in the extension

`SessionStore` writes the server URL to `UserDefaults.standard` and the PAT to `Keychain` (service `dev.optio.ios`, no access group). Additionally write `serverURL` / `workspaceId` to `UserDefaults(suiteName: "group.dev.optio.ios")` and the PAT to a keychain item with `kSecAttrAccessGroup = "<TEAMID>.dev.optio.shared"` (keep `AfterFirstUnlockThisDeviceOnly`; the extension may run before unlock). If the entitlements carry no App Group (a build that could not get it), `SharedCredentials` is a no-op and widgets render "Open Optio to connect". The extension only reads; sign-out clears every copy.

### LiveActivityManager (app target)

One `@MainActor` singleton owned by `OptioApp`, keyed `[ActivityKey: Activity<…>]` where `ActivityKey = (kind, subjectId)`.

- **Sources.** Per-screen streams die with the screen, so introduce `EventHub`: one `/ws/events` connection kept while the app is active (promote the stream `LocalHubModel` already opens to app scope and have `LocalHubModel` subscribe to it). It yields `task:state_changed`, `task:stalled`/`recovered`, `persistent_agent:turn_started|halted|state_changed` and content-free `local:changed` (manager refetches `GET /api/local/terminals/:id`). `TaskLogStream` and `AgentDetailModel` additionally feed a throttled last log line (≤1 / 3 s) while their screen is open.
- **Start rules.** Task: "Follow" in `TaskDetailView`, or automatically when a task created from the phone enters `running`. Local: automatically for the user's `kind=agent` terminals entering `running`, or "Pin" on a row. Agent: on `turn_started` for starred agents (preference in App Group defaults).
- **Update** = `activity.update(ActivityContent(state:, staleDate: now+90 s, relevanceScore:))`, with `relevanceScore` 100 for `needs_you`/`needs_attention`, 50 running, 10 idle. `alertConfiguration` on transitions to `needs_you`, `needs_attention`, `failed`, `pr_opened`.
- **Dedupe.** Keep `lastState[key]`; skip identical `ContentState`; coalesce bursts with a 500 ms debounce per key (same as the web's `local:changed` debounce).
- **End.** `end(_, dismissalPolicy: .after(now+15 min))` on `completed`/`failed`/`cancelled`/terminal exit/agent `idle` for >10 min; `.immediate` on sign-out.
- **Foreground/background.** On `.active`: reconnect `EventHub` and reconcile `Activity<…>.activities` against the list endpoints (activities outlive the process). On `.background`: schedule `BGAppRefreshTask("dev.optio.glance.refresh")`, whose handler runs the same reconcile within 20 s and calls `WidgetCenter.shared.reloadAllTimelines()`.
- **Stale.** `staleDate` 90 s after the last app-driven update so a suspended app's activity greys out honestly; with push updates the server sets `stale-date` = now+120 s and refreshes at least every 60 s while the subject is active.
- **8 h cap.** Track `startedAt`; at 7 h 45 m, if the subject is still live and the app is foregrounded (or on the next BGAppRefresh), end and restart the activity (new push token → re-POST). With push-to-start the server can do this itself: on 410 or at `startedAt+7h45m` it sends a `start` push for the same subject.
- **Push tokens (paid).** `for await token in activity.pushTokenUpdates` → `POST /api/notifications/live-activities/:kind/:subjectId/token`. `for await t in Activity<A>.pushToStartTokenUpdates` per kind → `POST …/push-to-start`. Both are idempotent upserts.

### Widget timeline strategy

- Entries: `GlanceSnapshot` (needs-you count + 3 rows, running tasks count + 3 rows, starred agent states, `fetchedAt`, `error`). One `TimelineProvider` shared by all widgets; one parallel fetch of `/api/local/terminals`, `/api/tasks?state=running,needs_attention`, `/api/persistent-agents` per reload, 8 s timeout, `waitsForConnectivity=false`.
- Cadence: `.after(now + 15 min)` normally; `+5 min` when any `needs_you`/running exists; `+60 min` when idle. This stays within WidgetKit's ~40–70 reloads/day budget.
- App-triggered reloads: `EventHub` calls `WidgetCenter.shared.reloadTimelines(ofKind:)` on relevant events, coalesced to ≤1 per 10 s (foreground app reloads are not charged the same way, but the system still throttles).
- Offline / tailnet down: keep the last entry with a "as of HH:mm · unreachable" footer (persist the last snapshot in App Group defaults). Unauthenticated (no shared PAT): a single placeholder entry "Open Optio to connect" with `widgetURL(optio://signin)`.

### Deep links

Scheme `optio` is already registered. Add `optio://task/<id>`, `optio://local/<id>`, `optio://agent/<id>`, `optio://needs-you`. `OptioApp` handles `.onOpenURL` → `AppRouter.open(_ link: DeepLink)`; `AppRouter` gains `pendingDetail: DeepLink?` beside `pendingSection`. Each hub owns a `NavigationPath` and appends the id it understands (`AgentDetailModel(agentId:)` already exists; `TaskDetailView` and `LocalTerminalScreen` must accept a bare id and fetch their own subject, since the list may not contain the row yet). Widgets use `widgetURL`/`Link`, Live Activity regions use `widgetURL`, intents use `openAppWhenRun`.

## 3. Backend architecture for APNs

### Configuration

Token-based auth (no certificates to rotate yearly): `OPTIO_APNS_KEY_ID`, `OPTIO_APNS_TEAM_ID`, `OPTIO_APNS_KEY` (PEM contents of the `.p8`), `OPTIO_APNS_BUNDLE_ID` (default `dev.optio.ios`), `OPTIO_APNS_ENV` default (`production`; devices override per registration). Helm: `notifications.apns.{keyId,teamId,key,bundleId}` rendered into the same `optio-secrets` block as VAPID in `helm/optio/templates/secrets.yaml` behind `{{- if .Values.notifications.apns.keyId }}`, plus `notifications.apns.existingSecret` for clusters that keep the key out of values. When unset, `isApnsConfigured()` is false and every hook is a no-op, exactly like `vapidConfigured`.

### `apns-service.ts` and the HTTP/2 client

Options: `@parse/node-apn` (mature but heavy, callback-era API, intermittent maintenance), `apns2` (small, ESM, token auth, typed, supports the `liveactivity` push type), raw `node:http2` (zero deps; the ES256 JWT is ~15 lines of `node:crypto`). Recommendation: **`apns2`** behind a thin `apns-service.ts` facade that owns payload building, header selection and error mapping, with the transport abstracted to a 3-method interface so tests inject a fake. Rationale: it is ESM-native and runs unchanged under `tsx` on Node 22, and already handles JWT rotation, both APNs hosts, connection reuse and `apns-*` headers; raw `http2` would add ~250 lines of pooling/ping/GOAWAY handling the repo would then own. Per-send headers: `apns-topic` = bundle id (alerts) or `<bundle>.push-type.liveactivity`; `apns-push-type` = `alert` | `liveactivity` | `background`; `apns-priority` 10 for `needs_you`/`needs_attention`/`failed`/`pr_opened`, 5 for progress; `apns-expiration` = now+1 h for progress, 24 h for alerts; `apns-collapse-id` = `task-<id>` / `local-<id>` / `agent-<id>`.

### Schema (new migration, unix-timestamp prefix)

- `apns_devices`: `id`, `user_id` (FK users, cascade), `device_token` (hex, unique with `bundle_env`), `bundle_env` (`sandbox`|`production`), `platform` (`ios`), `app_version`, `device_name`, `created_at`, `last_seen_at`, `last_error_at`, `failure_count` (mirrors `push_subscriptions`).
- `live_activity_tokens`: `id`, `user_id`, `device_id` (FK apns_devices, cascade), `kind` (`task`|`local`|`agent`), `subject_id`, `push_token` (hex), `bundle_env`, `started_at`, `last_pushed_at`, `failure_count`; unique `(device_id, kind, subject_id)`; index `(kind, subject_id)` for fan-out lookups.
- `live_activity_start_tokens`: `device_id`, `kind`, `push_token`, `updated_at`; unique `(device_id, kind)`.

### Routes (`routes/notifications.ts`, member role)

- `POST /api/notifications/devices` `{ deviceToken, bundleEnv, platform, appVersion, deviceName }` → upsert, resets `failure_count`; `DELETE /api/notifications/devices/:deviceToken`; `GET /api/notifications/devices` (for the Settings screen).
- `POST /api/notifications/live-activities/:kind/:subjectId/token` `{ deviceToken, pushToken, bundleEnv }` → upsert; the server verifies the caller may read the subject (task `createdBy`/workspace, terminal `userId`, agent workspace) before storing. `DELETE` on the same path when the app observes `.ended`/`.dismissed`.
- `POST /api/notifications/live-activities/push-to-start` `{ deviceToken, kind, pushToken }`.
- `POST /api/notifications/test` extended to also send an APNs alert to the caller's devices.

### Event hooks (target: LA update within ~2 s)

All hooks are fire-and-forget dynamic imports behind `isApnsConfigured()`, the pattern `task-service.ts` already uses at line ~355.

- **Task transitions**: `taskService.transitionTask` → `apnsService.onTaskTransition(updated, toState)`: alert fan-out (reuse `STATE_TO_EVENT` + `shouldNotify`) **and** LA update/end for every `live_activity_tokens` row with `kind='task'`. `task:stalled`/`recovered` (published from the reconciler executor) update the activity's `phase` field without an alert unless `task.stalled` is enabled in preferences.
- **Local attention**: `local-terminal-service.transitionTerminal` already funnels every state/attention change into `notifyChanged(row)`; add `apnsService.onLocalTerminalChanged(row)` there. It sends an LA update for `kind='local'`, plus an alert (`local.needs_you`, new preference key, default on) when `attentionState` becomes `needs_you`, to the terminal's `userId` only.
- **Persistent agents**: `startPersistentAgentTurn` (turn_started) and `haltPersistentAgentTurn` (turn_halted) in `persistent-agent-service.ts`, and the `state_changed` publish site: LA update for `kind='agent'`, alert on `failed` and on halt with `haltReason` needing a human; recipient = `persistent_agents.created_by` (workspace-wide fan-out is a follow-up).
- **Reconciler**: no direct hook — every decision it applies lands in `transitionTask`/`transitionRun`/PA service, so the hooks above cover it. Resync (5 min) doubles as the safety net: `onTaskTransition` is cheap to call on "no change".

### Payloads

Alert (`apns-push-type: alert`):

```
{ "aps": { "alert": { "title": "Needs you", "subtitle": "claude-code · api", "body": "Stop hook fired" },
           "sound": "default", "thread-id": "local", "category": "OPTIO_LOCAL", "interruption-level": "time-sensitive" },
  "optio": { "url": "optio://local/<id>", "eventType": "local.needs_you", "kind": "local", "subjectId": "<id>" } }
```

Live Activity update (`apns-push-type: liveactivity`, priority 10 when `alert` present else 5):

```
{ "aps": { "timestamp": 1758100000, "event": "update", "stale-date": 1758100120, "relevance-score": 100,
           "content-state": { "phase": "needs_you", "reason": "stop", "lastLine": "…", "updatedAt": 1758100000 },
           "alert": { "title": "Needs you", "body": "api › claude-code stopped" } } }
```

`end` adds `"dismissal-date"`; `start` (push-to-start) adds `"attributes-type": "LocalTerminalActivityAttributes"` and `"attributes": {…}` and targets the start token. `content-state` keys must match the Swift `ContentState` exactly (`Codable` with snake-free camelCase). `lastLine` is truncated to 140 bytes to stay far below 4 KB.

### Delivery discipline

- Per-user fan-out: one send per `apns_devices` row for alerts; per `live_activity_tokens` row for LA. `Promise.allSettled`, individually caught, like `sendPushToUser`.
- Dedupe/rate: in-memory `Map<tokenId, {hash, at}>`; skip if the `content-state` hash is unchanged; coalesce to ≤1 LA push per token per second (trailing-edge timer) and ≤1 per 15 s for pure `lastLine` progress unless `NSSupportsLiveActivitiesFrequentUpdates` is set; alerts use `apns-collapse-id` so a burst collapses on the device.
- Errors: 410 `Unregistered` → delete the device (and its LA tokens) or the LA token; 400 `BadDeviceToken`/`DeviceTokenNotForTopic` → delete; 403 `InvalidProviderToken`/`ExpiredProviderToken` → refresh JWT, retry once; 429/5xx → `failure_count++`, drop at 5 (mirrors `MAX_FAILURE_COUNT`); success resets to 0 and bumps `last_seen_at`/`last_pushed_at`. LA rows are also swept when the subject is terminal for >12 h.

## 4. Test strategy

- **Unit (Vitest)**: `apns-payload.test.ts` for every builder (size < 4096 asserted, key shapes, priority/topic, collapse ids); `apns-service.test.ts` with a fake transport (fan-out counts, dedupe, 410 deletion, 5-failure drop, no-op when unconfigured); `apns-transport.test.ts` against a local `http2.createSecureServer` with a self-signed cert asserting headers, JWT `kid`/`iss` and status mapping.
- **Integration (`*.int.test.ts`, real Postgres)**: token routes upsert/idempotency, ownership checks on `:kind/:subjectId`, cascade on user/device delete, migration builds the three tables.
- **Pipeline e2e**: extend `standalone-job`/repo-task specs to assert the fake transport recorded an LA update after `[[mock:pr]]`; the API server gets `OPTIO_APNS_TRANSPORT=fake`.
- **Simulator**: Live Activities run in the simulator, so app-driven start/update/end needs no account. Alerts: `xcrun simctl push booted dev.optio.ios needs-you.apns` (payload includes `"Simulator Target Bundle"`). Xcode 16+ simulators issue ActivityKit push tokens and accept `simctl push` with a `liveactivity` payload; keep a DEBUG-only `OPTIO_DEV_LA_STATE=<json>` env hook (existing `SIMCTL_CHILD_` pattern) as the fallback for driving content state and screenshotting the Dynamic Island.
- **Widgets**: `#Preview(as: .systemSmall)` with fixture snapshots per state (needs-you, idle, offline, unauthenticated, tinted); an XCTest that runs the `TimelineProvider` against a stubbed `GlanceFetchClient` and asserts entry dates/cadence.

## 5. Risks and gotchas

- **4 KB payload cap** (alert and liveactivity). Never inline log tails; ship a truncated `lastLine` and let the app fetch on open.
- **8 h activity cap / 12 h lock-screen lingering.** Long-running agents and always-on Persistent Agents exceed it; use the restart strategy above and show a "resumed" affordance; prefer widgets for the always-on view.
- **`NSSupportsLiveActivitiesFrequentUpdates`** is user-toggleable in Settings; check `ActivityAuthorizationInfo().frequentPushesEnabled` and drop to the 15 s cadence when off. Users can also disable Live Activities per app — check `areActivitiesEnabled` before `request`, and surface it in Settings.
- **ATS in the extension.** The widget bundle has its own Info.plist; copy `NSAllowsArbitraryLoads`/`NSAllowsLocalNetworking` (or the eventual `NSExceptionDomains` for `*.ts.net`) or every extension fetch fails silently.
- **Extension memory (~30 MB)** and no `Observation`/`SharedTypes.swift` in it; decode narrow models, never keep log arrays.
- **Timeline budget**: per-widget ~40–70 reloads/day; keep the shared provider and the 10 s coalescer.
- **iOS 18 tinted/accented rendering**: colour-coded status dots become monochrome; add `widgetAccentable` hierarchy and SF Symbols per state so `needs_you` is distinguishable by shape.
- **Controls need App Intents inside the extension** and run without the app; a "Kill terminal" control must call the API from the extension with the shared PAT and handle a 30 s wall clock.
- **Background reality without paid**: `BGAppRefreshTask` is discretionary (often hours apart); communicate stale state honestly via `staleDate` rather than lying with a green dot.
- **Sandbox vs production**: Xcode-installed builds get sandbox tokens, TestFlight production; a token sent to the wrong host returns 400 `BadDeviceToken` — store `bundle_env` per row.
- **PAT in a keychain access group** widens the blast radius to the extension only; PAT expiry (`api_keys.expires_at`) will 401 the widget — render "Sign in again", never retry-loop.
- **Single-user recipient rules** (`createdBy`, terminal `userId`) mean teammates get nothing; workspace-level fan-out needs a preference model first.

## 6. Phased plan

| Phase | Scope                                                                                                                                                                     | Effort | Paid account?                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| 0     | `Shared/` folder, App Group + keychain group plumbing with fallbacks, `EventHub`, deep links through `AppRouter`, `BGAppRefreshTask`                                      | 2 days | No                                                                       |
| 1     | `OptioWidgets` target: three widgets, shared timeline provider, previews, iOS 18 Controls + their App Intents, app-side App Intents/Shortcuts                             | 3 days | No                                                                       |
| 2     | App-driven Live Activities (task / local / agent), `LiveActivityManager`, 8 h restart, simulator scripts                                                                  | 3 days | No                                                                       |
| 3     | Backend: `apns-service.ts` + `apns2` transport, migration, device/LA token routes, alert fan-out from task/local/agent hooks, unit + integration + e2e tests, Helm values | 4 days | No to build and test with fakes; **yes** to receive anything on a device |
| 4     | LA push updates + push-to-start, token registration in the app, dedupe/rate control, 410 sweeps, Settings UI for devices                                                  | 3 days | **Yes**                                                                  |
| 5     | TestFlight distribution, production APNs env, `NSExceptionDomains` tightening, workspace-level recipients                                                                 | 2 days | **Yes**                                                                  |

Total ≈ 17 engineer-days; phases 0–3 (12 days) are fully deliverable and testable today; phases 4–5 are blocked on enrolling in the Apple Developer Program and adding the team id to `project.yml`.
