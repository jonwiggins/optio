# Optio for iOS

Native SwiftUI client for the full Optio experience: overview stats, Tasks, Jobs,
Reviews, Issues, Scheduled, Persistent Agents, Sessions, Optio Local terminals,
Library, Insights, and Admin/Settings. Designed to be used over a Tailscale
network: your phone and the machine (or cluster) running Optio join the same
tailnet, and the app talks to the API at its MagicDNS address.

## Prerequisites

- Xcode 27+ with the Metal toolchain (`xcodebuild -downloadComponent MetalToolchain`)
- `brew install xcodegen` — the `.xcodeproj` is generated from `project.yml` and not committed
- Node toolchain from the monorepo root (`pnpm install`) for type generation

## Workflow

```bash
make generate   # xcodegen → Optio.xcodeproj
make build      # simulator build (default: iPhone 17 Pro; override with SIM="iPhone 17e")
make test       # unit tests
make run        # boot simulator, install, launch
make types      # regenerate Optio/Generated/SharedTypes.swift from packages/shared
```

Open `Optio.xcodeproj` in Xcode for day-to-day work. Re-run `make generate`
after adding or moving source files (XcodeGen globs the `Optio/` tree, so new
files inside existing folders are picked up automatically on regeneration).

## Shared protocol

`Optio/Generated/SharedTypes.swift` is emitted by `packages/shared/scripts/gen-swift.ts`
from the TypeScript types in `packages/shared/src/types/`. Never edit it by hand;
change the TypeScript and run `make types`. String enums gain an `.unknown`
fallback so a server that adds a state never crashes an older app.

Response envelopes that only exist in route handlers (e.g. `{ tasks, total }`)
are declared beside the feature that uses them, as `extension APIClient` methods.

## Signing in

The app authenticates with a Personal Access Token (`optio_pat_*`), sent as a
bearer header on HTTP and in the `Sec-WebSocket-Protocol` slot on WebSockets,
exactly like the CLI. Create one under Settings → API keys in the web UI, or run
`optio login` and copy it from `~/.config/optio/credentials.json`.

Server URL examples:

- Tailscale, API port-forwarded on the laptop: `http://laptop.tailnet.ts.net:30400`
- Tailscale Serve with TLS in front of the API: `https://laptop.tailnet.ts.net`

Plain-HTTP tailnet addresses are allowed by the app's ATS configuration
(`NSAllowsArbitraryLoads` in `project.yml`). Tighten that to an exception domain
once the API is behind TLS.

## Multiple servers

The phone can be paired with several Optio instances at once (two laptops, a
laptop and a cluster, …). Each is a `ServerProfile` (`Shared/ServerRegistry.swift`)
with a name, colour, URL and optional workspace override; profiles live in the App
Group defaults and each token in the shared keychain group under `token.<id>`, so
the widget extension sees the same list.

- **Switching.** Every hub has a server chip in the leading toolbar slot
  (`ServerSwitcherMenu`); the Overview also shows an `ActiveServerCard` and an
  "Other servers" section with live counts fetched straight from each server.
  Switching re-points the one `APIClient`/`EventHub` and bumps
  `SessionStore.generation`, which the tab shell is keyed on, so every screen
  restarts with fresh state for the new instance. `More › Servers` renames,
  recolours, forgets and adds servers; "Sign out" forgets the active one.
- **Widgets.** Needs You and In Flight take a _Server_ option: one server, or (the
  default) all paired servers sectioned by name and colour. Snapshots are cached per
  server, so one laptop being offline only greys out its section. The Run widget's
  targets are namespaced `<serverId>|local:<uuid>` / `<serverId>|job:<uuid>`; legacy
  ids without a prefix fire on the active server.
- **Deep links.** Any `optio://` link may carry `?server=<id>`; `MainTabView`
  switches first, stashes the link in `NotificationHandler`, and the rebuilt shell
  routes it. Widgets and Live Activity buttons always set it. APNs payloads carry no
  server, so `NotificationHandler` probes each paired server for the subject before
  routing a tap or running a banner action.
- **Live Activity.** One Watch merges every server (`NeedsYouSnapshot.loadAll`); items
  carry `serverId`/`serverName` and the island shows a `WatchServerTag` when more
  than one server is paired. Push tokens for the activity register with the active
  server only; the 30 s foreground poll and background refresh cover the others.
- **Push.** The device token registers with every paired server, and a forgotten
  server gets a `DELETE` with the credentials it was registered under.

Pre-multi-server installs are migrated on first launch from the old
`optio.serverURL` + `accessToken` keys into a single profile named after the host.

## Driving the simulator from the CLI (DEBUG builds only)

`make run` installs and launches the app. Debug builds accept environment
variables (forwarded by simctl with the `SIMCTL_CHILD_` prefix) so you can skip
the sign-in form and open a specific section, e.g. for screenshots:

```bash
SIMCTL_CHILD_OPTIO_DEV_SERVER_URL=http://localhost:30400 \
SIMCTL_CHILD_OPTIO_DEV_TOKEN=dev \
SIMCTL_CHILD_OPTIO_DEV_SECTION=local \
  xcrun simctl launch booted dev.optio.ios
xcrun simctl io booted screenshot local.png
```

`OPTIO_DEV_SERVER_URL_2` / `OPTIO_DEV_TOKEN_2` (and `_3`, `_4`) pair additional
servers (ids `dev-server`, `dev-server_2`, …); `OPTIO_DEV_SERVER_NAME[_n]` names
them. Pointing `_2` at `http://127.0.0.1:30400` gives a second profile on the same
local API, enough to exercise the switcher and the sectioned widgets.
`OPTIO_DEV_OPEN_URL=optio://section/tasks?server=dev-server_2` delivers a deep link
two seconds after launch (without the "Open in Optio?" prompt `simctl openurl`
shows), which is how a server switch is driven from the CLI.

Pass the variables with `xcrun simctl launch --terminate-running-process …`: a
separate `simctl terminate` followed by `launch` drops the `SIMCTL_CHILD_`
environment, and the app then silently reuses whatever was paired last time.

Sections: tasks, jobs, reviews, issues, scheduled, agents, sessions, local,
analytics, costs, activity, cluster, more. With `OPTIO_AUTH_DISABLED=true` on
the server any token string works; a few user-scoped routes (workspaces, API
keys, notification preferences) return 401 in that mode because the synthetic
dev user has no session, which is expected.

## Layout

```
Optio/
  App/            entry point, root auth gate, tab shell, theme
  Core/Auth       Keychain + SessionStore (server URL, PAT, current user, workspace)
  Core/Networking APIClient (HTTP) and WebSocketClient (subprotocol auth, reconnect)
  Core/UI         shared components: StatusBadge, StatTile, ChipPicker, Loadable…
  Generated/      SharedTypes.swift (generated) + AnyCodable.swift
  Features/       one folder per screen group, each with its own APIClient extension
OptioTests/       XCTest unit tests
```

## Cross-tab navigation

`AppRouter` (App/AppRouter.swift) lives in the environment. Call
`router.open(.local)` from anywhere to switch tabs; the target hub reads and
clears `pendingSection` to select its sub-section.

## CI

`scripts/check-swift-types.sh` (job "Swift Types In Sync") fails the build when
`SharedTypes.swift` is stale relative to `packages/shared/src/types`. The app
itself is not built in CI yet (needs a macOS runner).

## App icon

`Design/app-icon.svg` is the source (lucide `bot` glyph, ISC licensed, on the
Optio purple). Re-export with Quick Look and flatten (no alpha):

```bash
qlmanage -t -s 1024 -o /tmp/icon Design/app-icon.svg
sips -s format jpeg /tmp/icon/app-icon.svg.png --out /tmp/icon.jpg
sips -s format png /tmp/icon.jpg --out Optio/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png
```

### Dark and tinted appearances (iOS 18+)

`AppIcon.appiconset/Contents.json` also declares a `dark` and a `tinted`
luminosity variant, rendered from `Design/app-icon-dark.svg` and
`Design/app-icon-tinted.svg`. Both are glyph-only on a **transparent**
background (the system supplies the dark backing / the user's tint colour).
Quick Look composites SVGs onto opaque white, so render these two with `sharp`
(librsvg, already in the monorepo's pnpm store), which keeps the alpha channel:

```bash
cd ../..   # repo root
SHARP=$(ls -d node_modules/.pnpm/sharp@*/node_modules/sharp | head -1)
for v in dark tinted; do
  node -e "require('./$SHARP')('apps/ios/Design/app-icon-$v.svg').resize(1024,1024).png()
    .toFile('apps/ios/Optio/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-$v.png')"
done
```

Only the light/default PNG must be opaque. Check the compiled catalog with
`xcrun assetutil --info <Optio.app>/Assets.car | grep -i -B2 -A6 appearance`.

### Alternate icons

`Design/icons/<slug>.svg` are the user-selectable alternates (Settings → App →
App icon), rendered with the same opaque recipe into
`AppIcon-<Slug>.appiconset` (registered via
`ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES` in `project.yml`) plus an
`IconPreview-<Slug>.imageset` copy for the in-app thumbnails.
`Design/icons/contact-sheet.png` shows them all at 120px.
