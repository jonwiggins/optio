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
