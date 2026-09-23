# Optio for Android

Native Android client for Optio (Kotlin, Jetpack Compose, Material 3), at parity with the iOS app in
`apps/ios/`. The iOS source is the spec; this app ports its behaviour, data flow and copy, and
adapts the presentation to Material 3. One Activity, five tabs (Overview · Work · Library ·
Insights · More), one Navigation 3 back stack per tab, manual DI, OkHttp + kotlinx.serialization.
It runs on Android 10 (API 29) and newer and targets Android 17 (API 37).

- **Using the app:** [What's in it](#whats-in-the-app) ·
  [Tailscale and plain HTTP](#tailscale-and-plain-http) · [Signing in](#signing-in) ·
  [Multiple servers](#multiple-servers) · [Deep links](#deep-links) ·
  [Local sessions](#local-sessions-on-the-phone) · [Notifications and push](#notifications-and-push) ·
  [Widgets, tiles, shortcuts and icons](#widgets-quick-settings-tiles-app-shortcuts-and-app-icons)
- **Developing:** [Prerequisites](#prerequisites) · [Environment](#environment) ·
  [Commands](#commands) · [Dev lab](#dev-lab) · [Debug dev extras](#debug-dev-extras) ·
  [Testing](#testing) · [Shared types](#shared-types) · [CI](#ci) ·
  [Troubleshooting](#troubleshooting)
- **Architecture:** [Toolchain](#toolchain) · [Modules](#modules) ·
  [Convention plugins](#convention-plugins-build-logic) · [Conventions](#conventions) ·
  [Gotchas](#gotchas) · [App icon](#app-icon)

## What's in the app

The tabs mirror the web sidebar. Phones get a bottom bar, wide screens a navigation rail.

| Tab          | What it holds                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| **Overview** | What needs you, usage limits, the Work board, the cluster, recent tasks, and the other paired servers' counts |
| **Work**     | **All** (the Work feed) · **Reviews** · **Inbox**                                                             |
| **Library**  | Prompts · Repos · Machines (paired machines and the Local automations that fire on them) · Connections        |
| **Insights** | Analytics · Costs · Activity · Cluster                                                                        |
| **More**     | Admin (Secrets, Webhooks, Workspace, Settings) and Account (Servers, workspace, Sign out)                     |

- **One Work feed.** Work › All merges every kind of work (PR tasks, jobs, scheduled blueprints,
  Local automations and terminals, pod sessions, persistent agents) into one list with **Active**,
  **Recurring**, **Agents**, **History** and **All** views (`:core:workfeed`, a port of the web's
  `lib/work-feed.ts`). It polls while on screen, refreshes on `/ws/events`, and pulls to refresh.
  Rows open the per-kind detail screens: a task's logs, activity, subtasks and dependencies; a
  job's runs; a Local terminal ([below](#local-sessions-on-the-phone)); a pod session's Chat ·
  Terminal · PRs; a persistent agent's Chat · Turns · Triggers · Config.
- **The New work form.** **New work** (the Work list's button, the Overview's top bar, the New
  work tile and shortcut, `optio://work/new`) opens the native five-attribute form
  (`:feature:workform`, a port of the web's `components/work-form/`): example presets up top (Open
  a PR, Interactive chat, Terminal, Scheduled run, Persistent agent), then When · Where · Who ·
  What · Then · Name, and a bar pinned at the bottom that says in a sentence what the answers make
  and holds the one button that makes it. There is no type to pick: the kind is derived from the
  answers. Saved recurring work reopens in the same form, with its kind locked.
- **Roles.** Actions follow your workspace role: viewers are read-only, and admin-only screens say
  so instead of failing.
- **Glanceable surfaces.** An ongoing Watch notification, alerts with actions, home-screen widgets,
  Quick Settings tiles, launcher shortcuts and eight app icons (see
  [Notifications and push](#notifications-and-push) and
  [Widgets](#widgets-quick-settings-tiles-app-shortcuts-and-app-icons)).

## Tailscale and plain HTTP

The app is designed to be used over a Tailscale network: your phone and the machine (or cluster)
running Optio join the same tailnet, and the app talks to the API at its MagicDNS address. Server
addresses look like this:

- Tailscale, API port-forwarded on the laptop: `http://laptop.tailnet.ts.net:30400`
- Tailscale Serve with TLS in front of the API: `https://laptop.tailnet.ts.net`
- The Android emulator, with the API on the host machine: `http://10.0.2.2:<port>`

Type the scheme: an address without one gets `https://`. Plain-HTTP addresses are allowed by the
app's network security config (`app/src/main/res/xml/network_security_config.xml` permits
cleartext in its base config, the counterpart of iOS `NSAllowsArbitraryLoads`). Tighten it once
your servers are behind TLS.

## Signing in

The app authenticates with a personal access token (`optio_pat_…`), exactly like the CLI and the
iOS app: `Authorization: Bearer <token>` on HTTP, and on WebSockets the `Sec-WebSocket-Protocol`
values `optio-ws-v1, optio-auth-<token>` (a single-use token from `GET /api/auth/ws-token` when the
server mints one, else the PAT), so a token never appears in a URL.

- Create a token in the web UI under **Settings → API keys**, or run `optio login` and copy it from
  `~/.config/optio/credentials.json`. Once you are signed in, **More › Settings › Personal access
  tokens** creates more.
- The first screen asks for the server address and the token (**Where do I get these?** repeats
  the above). Pairing checks the token against `GET /api/auth/me` before anything is stored.
- Tokens are encrypted with a non-exportable Android Keystore key (AES-256-GCM). Backup and device
  transfer are off (`allowBackup="false"` plus data-extraction rules that exclude everything), so a
  new phone has to be paired again.
- With `OPTIO_AUTH_DISABLED=true` on the server any token works. A few user-scoped routes
  (workspaces, API keys, notification preferences and devices, `GET /api/glance/watch`) answer 401
  in that mode, which is expected: there is no real user.

### Android 17 local network permission

Android 17 (API 37) blocks connections to devices on the local network (a laptop at
`192.168.1.20:30400`, a `.local` name, the emulator host `10.0.2.2`) unless the app holds the
runtime permission `ACCESS_LOCAL_NETWORK`, shown as **Nearby devices**. Without it requests don't
fail, they hang until they time out. The app asks only when it matters:

- at sign-in, before connecting to a local address (Tailscale's `100.64.0.0/10` addresses count, to
  be safe);
- at most once per launch when the active server is local and the permission is missing (after a
  restore, a server switch or a revoked permission).

Public servers never prompt, and older Android versions have no such permission. If you deny it,
sign-in says why it can't reach the server and offers the app's system settings
(`LocalNetworkAccess` in `:core:data`).

## Multiple servers

The phone can be paired with several Optio instances at once (two laptops, a laptop and a cluster,
…). Each is a server profile with a name, a colour (slate, blue, teal, green, amber, rose or
indigo), a URL and an optional workspace. Profiles live in DataStore and each token is stored under
`token.<id>`. Widgets, tiles, workers and notification actions run in the app's process and read
the same registry (iOS needs an App Group for this).

- **Switching.** The server chip in the top bar (always on Overview, and on every hub once two
  servers are paired) lists the servers plus **Add server…** and **Manage servers…**. Switching
  re-points the one API client and event socket and rebuilds every screen with fresh state for the
  new server. The Overview also shows the active server's card and **Other servers**, with live
  counts fetched straight from each server; tap one to switch to it.
- **Servers** (More › Account › Servers, or **Manage servers…**): tap a server to switch, **Edit**
  changes its name, colour and address, **Forget** removes its token from this phone (nothing
  changes on the server), and **Add server** pairs another. **Sign out** forgets the active server
  and switches to your next one.
- **Deep links.** Any `optio://` link may carry `?server=<id>`: the app switches to that server
  first, then routes the link. Widget rows, notifications and the Watch add it when an item belongs
  to a particular server; a link naming a server this phone doesn't know opens on the active one.
- **Widgets and the Watch.** The Work widget takes a Server option: one server, or all of them (the
  default) with a coloured dot on each row. Snapshots are cached per server, so an unreachable
  laptop only flags its own rows. The Watch notification and the needs-you alerts cover every
  paired server; with several paired, the Watch names the server of the item it shows.
- **Push.** The FCM token registers with every paired server, and a forgotten server gets a
  `DELETE` for it.

## Deep links

`optio://` links come from widgets, tiles, notifications, shortcuts and other apps (`DeepLink` in
`:core:data`, a port of iOS `Shared/DeepLink.swift`). Detail links open on the Work tab, and any
link may add `?server=<id>` (see [Multiple servers](#multiple-servers)).

| Link                               | Opens                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `optio://tasks/<id>`               | A task                                                                                                                                          |
| `optio://local/<id>`               | A Local terminal; `?compose=1` lands with the composer focused                                                                                  |
| `optio://agents/<id>`              | A persistent agent (chat first); `?compose=1` focuses the composer                                                                              |
| `optio://sessions/<id>`            | A pod session                                                                                                                                   |
| `optio://work/new`                 | The New work form (legacy `optio://sessions/new`)                                                                                               |
| `optio://needs-you`                | Work › All in the Active view, where needs-you rows rank first                                                                                  |
| `optio://section/work?view=<view>` | Work › All in a view: `active`, `recurring`, `agents`, `history` or `all`                                                                       |
| `optio://section/<name>`           | A hub section: `work`, `reviews`, `inbox`, `prompts`, `repos`, `machines`, `connections`, `analytics`, `costs`, `activity`, `cluster` or `more` |
| `optio://settings`                 | More › Settings (the server's test push links here)                                                                                             |

Legacy section names still work: `sessions` (Work), `tasks` (the All view), `jobs` and
`scheduled` (Recurring), `agents` (Agents), `local` (Active), `issues` (Inbox), `templates`
(Prompts) and `hosts` (Machines); `?view=` overrides the view. To try a link from a shell:

```bash
adb shell am start -a android.intent.action.VIEW -d 'optio://section/work?view=recurring'
```

## Local sessions on the phone

A Local (on-your-machine) terminal opens on its **Transcript** whenever one exists, live or
finished: the agent's conversation, distilled by the daemon and reflowed for the phone, with a
composer that writes your message plus Enter to the PTY. A plain shell, or an agent that hasn't
said anything yet, opens on the **Screen**, the live terminal. The toggle in the header switches
between them (`LocalSessionView` in `:feature:local`).

**One PTY, one grid.** Attaching from the phone never resizes the session. The Screen face renders
the grid the daemon announces, shrunk to fit (**Sized for another device**), and only an explicit
interaction claims the grid for the phone: a tap on the terminal, a key from the key bar, or **Use
this screen**. The PTY is then resized to the phone. TUI screens use absolute cursor moves and
can't reflow, so each connection's replay is held until the daemon's `size` frame lands
(`LocalTerminalStream`, plus `TerminalSizing` and `StreamPolicy` in `:core:terminal`, ports of the
web's `sizing.ts` and `stream-policy.ts`). A finished terminal shows its **Recorded screen**. Pod
sessions work the other way round: the phone owns their grid, and the PTY follows its size.

**Touch.** A tap focuses the terminal and raises the keyboard; it never sends a mouse click. A drag
scrolls: mouse-wheel reports when the program tracks the mouse, the scrollback otherwise, and arrow
keys in a full-screen program that doesn't track the mouse.

**The key bar** sits above the keyboard with what a phone keyboard lacks: esc, tab, ^C, ^D, `|`,
`~`, `-`, `/`, arrow keys that follow the program's cursor-key mode, sticky **ctrl** and **alt**
(tap: the next key, from the bar or the keyboard, gets the modifier; long-press ctrl for a Ctrl+…
menu), and a keyboard toggle. It scrolls sideways when the keys don't fit.

**Input modes** (`TerminalInputMode`). Agent terminals take **Prose** input: autocorrect,
suggestions and glide typing, with the word being composed sent as you type and corrected with
backspaces, so Claude Code's `/` and `@` menus still pop up. Shells and pod sessions take **Text**
input: suggestions off and each key committed as typed, which works best with Gboard for a shell
or TUI. `:core:terminal` also has **Raw** (`TYPE_NULL`, key events like a hardware keyboard), which
no screen uses.

## Notifications and push

The app works with no setup and gets faster with server push. Everything is under **More ›
Settings › Notifications on this phone**: the permission, push status, your registered devices and
**Send test notification**, plus **What to notify me about** (per-event toggles, shared with your
browser subscriptions) and **Watch and background checks**.

### On-device baseline

- While the app is open, the `/ws/events` socket and a 30-second poll keep the Watch, the alerts
  and the widgets current.
- **Background check:** a WorkManager job every 15 minutes (when there is a network) checks every
  paired server. It caches each server's snapshot for the widgets, posts needs-you alerts for items
  not seen before, and updates or ends the Watch. **Check now** runs one at once.
- **Keep watching in the background** (opt-in): a foreground service holds the `/ws/events`
  connection while Optio is closed, so the Watch and alerts update the moment something needs you,
  for a little more battery. It comes back after a reboot or an app update and stops when you sign
  out of every server. You don't need it when your servers push.

### Alerts

Optio only alerts when something needs you; working and idle stay silent. Each kind has its own
notification channel, so you can silence one in the system settings without the others, and its
own actions. Reply, Later, Resume and Retry call the API without opening the app.

| Channel              | When                                                              | Actions                        |
| -------------------- | ----------------------------------------------------------------- | ------------------------------ |
| Needs you            | A terminal on your machine is waiting for a reply or a permission | Reply (inline), Later (snooze) |
| Task needs attention | A task stalled, hit a merge conflict, or failed                   | Resume, Retry, Open            |
| PR opened            | A task opened its pull request                                    | Open PR                        |
| Agent replies        | A persistent agent answered a message you sent                    | Reply                          |
| Agent failed         | A persistent agent stopped after repeated failed turns            | Resume                         |
| Machine offline      | A machine running your agents stopped responding                  | —                              |
| Automation finished  | An automation's terminal exited (delivered quietly)               | Open                           |
| Watch                | The ongoing Watch notification (silent)                           | see below                      |
| Other                | Test notifications                                                | —                              |

On Android 13 and newer, the notification permission is asked the first time something needs you
while the app is open (never at first launch), or from the settings above.

### The Watch notification

One ongoing notification per phone, the counterpart of the iOS Live Activity: the session waiting
on you (or the newest running one) with its status and reason, how many more are running or
waiting, a timer, and the head's actions (Reply or Message, Later, Open; Resume and Retry for a
task needing attention; Open PR). It is yellow while something needs you, purple while sessions
work, and grey when offline or ended. It starts when something needs you or runs, turns offline
after 90 seconds of every server failing, and ends two minutes after everything goes quiet, with a
summary that stays for 15 minutes. The lock-screen version leaves out the terminal's last prompt.

- **Live Updates.** On Android 16 (API 36) and newer the Watch asks to be promoted to a Live Update
  (a status-bar chip, and on the lock screen). The **Live Update** row in Watch settings shows
  whether the system allows it and opens the setting. A Live Update can't answer inline, so its
  Reply opens the composer instead.
- **What it follows.** Local terminals that need you or run, on every paired server; tasks you
  follow (**Follow in Watch notification** on a task's detail, dropped automatically when the task
  finishes); and persistent agents you messaged from this phone in the last hour.

### Server push (optional FCM)

With Firebase Cloud Messaging, each paired server that holds FCM credentials pushes alerts and
Watch updates even while the app is closed. It is optional at build time:

1. Create a Firebase project, add an Android app with the package name `dev.optio.android`, and
   save its `google-services.json` as `apps/android/app/google-services.json` (git-ignored; it
   identifies your Firebase project). The Gradle build applies the google-services plugin only when
   that file exists. Without it every FCM path is a no-op and Settings shows Firebase as **Not in
   this build**.
2. Give each server a service-account key from the **same** Firebase project (Helm
   `notifications.fcm.*` or `OPTIO_FCM_SERVICE_ACCOUNT`).
   [docs/android-push.md](../../docs/android-push.md) covers the server setup, the routes, the
   payloads and testing.
3. Install the build, allow notifications, and open **More › Settings › Notifications on this
   phone**: it shows Firebase, this device's token and its registration with each server, and
   **Send test notification**.

The app registers its token with every paired server on each launch, when Firebase rotates it, and
when notifications are allowed (`platform: "android"`, `appId: "dev.optio.android"`, and the
server's profile id as `serverId`, which every push echoes so a tap routes without probing
servers). Messages are data-only: the app renders every notification itself, with the channels and
actions above.

## Widgets, Quick Settings tiles, app shortcuts and app icons

Widgets, tiles and shortcuts live in `:feature:widgets` (widgets are Jetpack Glance). They run in
the app's process and reach the app through `optio://` links.

**Home-screen widgets**

- **Work** (2×2, 4×2 or 4×4; the layout follows the size): what needs you, what's running, and the
  rest of the board. Tap a row to jump in. Its Server option (set when you place it, changed with
  the launcher's Reconfigure) shows one paired server or all of them (the default).
- **Run** (2×2): fires one recurring item, a Local automation or a Job, on any paired server with
  one tap. Setup picks the target, **Ask before running**, and can add a home-screen shortcut for
  it. It shows the target's name, and **Started** for a minute after firing.

Widgets render each server's cached snapshot and never wait on the network. The background check,
the app's event socket and your actions refresh them.

**Quick Settings tiles** (add them by editing the Quick Settings panel)

- **Needs you:** counts what waits on you across every paired server, names the oldest, and opens
  Work › Active.
- **New work:** opens the New work form.
- **Run:** fires one Local automation or Job in the background, without confirmation, and shows a
  checkmark for a few seconds. Long-press it (or tap it before it has a target) to pick the target.

**App shortcuts** (long-press the launcher icon)

- **New work** and **Needs you**, always;
- the run targets you fired most recently from a widget, tile or shortcut;
- run targets pinned to the home screen from the Run widget's setup.

A run shortcut asks before it fires, then runs in the background.

**App icons.** More › Settings › App icon offers eight icons: Optio (the default), Midnight,
Terminal, Blueprint, Sticker, Retro, Sunrise and Chip. Android has no alternate-icon API, so each is
an `<activity-alias>` of `MainActivity` in `app/src/main/AndroidManifest.xml` (`.LauncherDefault`,
`.LauncherMidnight`, …) with the launcher intent filter, and exactly one is enabled at a time. What
that means on a launcher (seen with Pixel Launcher on API 37):

- If Optio was opened from the launcher, switching the icon **closes the app**: Android finishes a
  task that was started from the alias being disabled. The picker asks first. Opened from a
  notification, a widget or a link, the app stays open.
- The app drawer shows the new icon within a second or two. Some launchers drop the old icon from
  the home screen; add Optio again from the drawer.
- Static shortcuts are declared on every alias (launchers read them from the enabled launcher
  component). Themed (monochrome) icons use the default bot glyph for every alternate.
- `adb shell am start -n dev.optio.android/dev.optio.app.MainActivity` keeps working: the activity
  itself stays exported.

## Prerequisites

- Android Studio. Its bundled JetBrains Runtime (JBR 25) runs Gradle; any JDK 17–25 works.
- Android SDK with platform `android-37.2`, build-tools 36.0.0 and platform-tools. AGP downloads
  missing SDK packages itself once the licences are accepted.
- Network access to Google Maven, Maven Central, JitPack (Termux libraries only) and
  services.gradle.org.

## Environment

Every shell that runs Gradle or adb needs:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"   # JBR 25
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
cd apps/android
```

## Commands

```bash
./gradlew assembleDebug                         # debug APK: app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest :core:model:test :core:network:test   # every unit test
./gradlew :feature:tasks:testDebugUnitTest      # one module's tests
./gradlew :feature:tasks:recordRoborazziDebug   # its tests + screenshots in feature/tasks/build/outputs/roborazzi/
./gradlew installDebug                          # install on the running emulator or device
adb install -r -g app/build/outputs/apk/debug/app-debug.apk   # reinstall, granting runtime permissions
adb shell am start -n dev.optio.android/dev.optio.app.MainActivity
```

`:core:model` and `:core:network` are plain Kotlin/JVM modules, so their tests run with `test`.
Every other module is an Android module and uses `testDebugUnitTest`.

`installDebug` grants no runtime permissions, so the app asks for local network access and
notifications itself. For scripted runs, install with `adb install -r -g`, which pre-grants them
(see [Android 17 local network permission](#android-17-local-network-permission)).

On a shared machine, build only the modules you are working on until you need the app, and never
run `./gradlew --stop`: it stops every Gradle 9.7.1 daemon on the machine, including other people's
builds. `gradle.properties` caps each daemon at a 3 GB heap and 4 workers.

## Dev lab

`apps/android/scripts/` runs the app against a real, isolated Optio without touching yours (the
cluster on `localhost:30400`, your `optio local up` daemon, `~/.config/optio`):

| Script           | What it gives you                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `test-api.sh`    | A private API: the real server with the fake agent runtime, seeded data, auth off (or `--auth`), hermetic |
| `emu.sh`         | Headless, read-only instances of the shared `optio` AVD (several at once)                                 |
| `test-daemon.sh` | An isolated Optio Local daemon attached to a test API, for live terminals and transcripts                 |

[e2e/README.md](e2e/README.md) is the full guide: ports, the AVDs, what is seeded, `seed.json`,
auth-enabled mode, the test daemon and timings. Quick start, from the repo root with the
[environment](#environment) above:

```bash
apps/android/scripts/test-api.sh start                  # shared test API on :4961 (idempotent), ~25 s
SERIAL=$(apps/android/scripts/emu.sh start --port 5562) # prints emulator-5562, ~23 s
adb -s "$SERIAL" install -r -g apps/android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$SERIAL" shell am start -n dev.optio.android/dev.optio.app.MainActivity \
  --es OPTIO_DEV_SERVER_URL http://10.0.2.2:4961 --es OPTIO_DEV_TOKEN dev
adb -s "$SERIAL" exec-out screencap -p > shot.png
apps/android/scripts/emu.sh stop "$SERIAL"              # always stop what you started
```

- It needs Docker running (the test Postgres and Redis), `pnpm install` run in the checkout (the
  test API runs its `apps/api`), and an AVD named `optio` (`--avd` or `OPTIO_EMU_AVD` picks
  another; e2e/README.md describes its image and hardware).
- Ports: the shared test API is 4961 and the shared auth-enabled one 4980 (`test-api.sh start
--auth`: real users and PATs, needed for widgets, the Watch, notifications, workspaces and API
  keys); private instances use 4962–4979. Emulator console ports are even numbers from 5554 to 5680. The scripts refuse 30400 and 30310 (your real Optio) and 4931 and 3131 (the web e2e stack).
- `emu.sh start` exits **75** while `OPTIO_EMU_MAX` emulators (default 3, each about 7 GB of RAM)
  already run on the machine. Stop only what you started.
- The emulator reaches the host's loopback at `10.0.2.2`. `adb reverse tcp:4961 tcp:4961` plus
  `http://127.0.0.1:4961` works too and needs no local network permission.

## Debug dev extras

Debug builds read `OPTIO_DEV_*` string extras from the launch intent (the counterpart of the iOS
`SIMCTL_CHILD_OPTIO_DEV_*` variables), so a script can skip the sign-in form and open a screen.
Release builds ignore them.

| Extra                                                      | Effect                                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `OPTIO_DEV_SERVER_URL` + `OPTIO_DEV_TOKEN`                 | Pairs a server (id `dev-server`) and makes it active, replacing the paired servers                                    |
| `OPTIO_DEV_SERVER_URL_<n>` + `OPTIO_DEV_TOKEN_<n>` (n 2–9) | Pairs more servers (ids `dev-server_2`, …)                                                                            |
| `OPTIO_DEV_SERVER_NAME[_<n>]`                              | Names a server (default: the host's first label)                                                                      |
| `OPTIO_DEV_SECTION`                                        | Opens a section by its deep-link name (`work`, `machines`, `costs`, …)                                                |
| `OPTIO_DEV_OPEN_URL`                                       | Delivers an `optio://` link about 2 s after launch, e.g. `optio://section/work?server=dev-server_2` to switch servers |
| `OPTIO_DEV_TOAST`                                          | Shows a toast (checks the toast host)                                                                                 |
| `OPTIO_DEV_NEW_WORK` + `OPTIO_DEV_NEW_WORK_TWEAKS`         | Fills the New work form (open it with `OPTIO_DEV_OPEN_URL optio://work/new`) from a preset and tweaks, see below      |
| `OPTIO_DEV_NO_PUSH_PROMPT`                                 | Never shows the notification permission prompt                                                                        |

Two servers, opening Library › Machines:

```bash
adb shell am start -S -n dev.optio.android/dev.optio.app.MainActivity \
  --es OPTIO_DEV_SERVER_URL http://10.0.2.2:4961 --es OPTIO_DEV_TOKEN dev \
  --es OPTIO_DEV_SERVER_URL_2 http://10.0.2.2:4962 --es OPTIO_DEV_TOKEN_2 dev \
  --es OPTIO_DEV_SERVER_NAME_2 Staging \
  --es OPTIO_DEV_SECTION machines
```

- `-S` force-stops the app first, so the extras apply to a fresh start (a running app also takes
  new server extras).
- `adb shell` splits arguments on spaces, so quote values that contain them twice:
  `--es OPTIO_DEV_TOAST "'Hello there'"`.
- Against an auth-enabled test API, pass a PAT from its `seed.json` as the token (the member or
  viewer token to check role gating); see e2e/README.md.
- Work form presets are `pr`, `chat`, `terminal`, `schedule` and `agent`; tweaks are
  comma-separated `key=value` pairs such as `when=github,where=local,scroll=who`, and `submit=1`
  presses the button once the lists have loaded (`applyDevScript` in `:feature:workform` has the
  keys).

Other debug-only entry points:

```bash
# The terminal playground: canned screens, a local echo, a live Optio Local stream
adb shell am start -n dev.optio.android/dev.optio.core.terminal.playground.TerminalPlaygroundActivity
# Pin a widget (the launcher's dialog still needs its Add tap)
adb shell am start -n dev.optio.android/dev.optio.feature.widgets.debug.PinWidgetActivity \
  --es kind work --es server dev-server
# Push without Firebase: a data message as FCM delivers it (e.g. the `data` of a line of
# fcm-outbox.jsonl from `test-api.sh start --auth --fcm-fake`)
adb shell am broadcast -p dev.optio.android -a dev.optio.android.DEBUG_PUSH --es data '{"type":"alert",…}'
# A fake FCM token, registered with every paired server
adb shell am broadcast -p dev.optio.android -a dev.optio.android.DEBUG_FCM_TOKEN --es token fake-token-…
# One background check now
adb shell am broadcast -p dev.optio.android -a dev.optio.android.DEBUG_GLANCE_CHECK
```

`DebugPushReceiver` (`:feature:glance`, debug source set) also takes `DEBUG_FOLLOW_TASK --es id
<taskId>` and `DEBUG_KEEP_WATCHING --ez on true` (with the app on screen). Always pass
`-p dev.optio.android`: manifest receivers don't get implicit broadcasts.

## Testing

- **Unit and ViewModel tests** use JUnit 4 with `kotlin.test`, coroutines-test and Turbine,
  Robolectric for anything that needs Android, and `FakeOptioServer` from `:core:testing` (a
  MockWebServer that routes paths to JSON fixtures) for the API.
  `./gradlew testDebugUnitTest :core:model:test :core:network:test` runs them all. The rules are in
  [Conventions › Tests](#tests).
- **Screenshot tests** (Robolectric + Roborazzi) render screens with sample data in light and dark:
  extend `ScreenshotTest` and call `captureScreens("Name") { … }` from `:core:testing`.
  `./gradlew :<module>:recordRoborazziDebug` writes `<module>/build/outputs/roborazzi/<Name>_light.png`
  and `_dark.png`; `testDebugUnitTest` runs the same code without writing, as a cheap "does it
  compose" check. No reference images are committed: record after a UI change and look at the PNGs.
- **Live tests** (`*Live*Test`) call a running test API and are skipped unless
  `OPTIO_TEST_API_URL` is set. Most send `OPTIO_TEST_API_TOKEN` (default `dev`) and read the
  instance's `seed.json` (or the file in `OPTIO_TEST_SEED`); a few auth-only suites take more
  variables, listed in their KDoc. Add `--rerun`: the variables aren't task inputs, so Gradle could
  otherwise report an earlier, skipped run as up to date.

```bash
apps/android/scripts/test-api.sh start --port 4962      # from the repo root
cd apps/android
OPTIO_TEST_API_URL=http://127.0.0.1:4962 ./gradlew :core:data:testDebugUnitTest --tests '*LiveApiTest*' --rerun
```

## Shared types

`core/model/src/main/kotlin/dev/optio/core/model/SharedTypes.kt` is generated from the TypeScript
types in `packages/shared/src/types/` by `pnpm gen:kotlin` (run from the repo root;
`packages/shared/scripts/gen-kotlin.ts`, the Kotlin twin of `gen-swift.ts`). Never edit it by hand:
change the TypeScript and regenerate. Type names match the Swift output (`OptioTask`, `WsEvent`, …),
string enums get an `UNKNOWN` fallback and unions an `Unknown(raw)` variant, so a server that adds a
state never breaks decoding. The hand-written support (`OptioJson`, `FlexibleInstantSerializer`,
`RawEnum`, …) lives beside it. When a generated model disagrees with a real response, decode that
piece as `JsonElement` locally. Route-local envelopes (`{ tasks, total }`) are declared beside the
feature that uses them, with its `ApiClient` extension functions.

## CI

Two jobs in `.github/workflows/ci.yml` cover the app:

- **Android (build + unit tests)** runs
  `./gradlew assembleDebug testDebugUnitTest :core:model:test :core:network:test --stacktrace` in
  `apps/android` on Ubuntu with Temurin JDK 21. Live tests skip there (no `OPTIO_TEST_API_URL`).
- **Kotlin Types In Sync** runs `scripts/check-kotlin-types.sh`, which regenerates `SharedTypes.kt`
  and fails when the committed file is stale.

Screenshot recording and emulator checks are local only.

## Troubleshooting

- **Sign-in spins, then "Couldn't reach …", or requests hang, on a LAN or emulator address.** The
  app lacks Android 17's local network permission. Allow **Nearby devices** in the app's system
  settings, install with `adb install -r -g`, or run
  `adb shell pm grant dev.optio.android android.permission.ACCESS_LOCAL_NETWORK`. A probe from the
  shell (`emu.sh http`) succeeds either way, so it proves nothing about the app.
- **"Couldn't reach … Check the address and that this phone is on the same Tailscale network."**
  Tailscale is off, the port is wrong, or the address got `https://` while the server speaks plain
  HTTP: type `http://`.
- **"… answered, but not like an Optio server."** Something other than the Optio API answered at
  that address (another service on the port, a web page). Check the address and the port.
- **"The server rejected that token."** The PAT was revoked or has expired. Create a new one.
- **401s on Workspace, API keys or notification settings, and no push registration.** The server
  runs with `OPTIO_AUTH_DISABLED=true` and has no real user. That is expected; use an auth-enabled
  server (in the dev lab, `test-api.sh start --auth`).
- **No push.** "Firebase: Not in this build" means the build had no `app/google-services.json`.
  "Registered · no FCM" means the server has no FCM key. Devices that keep disappearing from the
  server's list usually mean its key comes from another Firebase project (`SENDER_ID_MISMATCH`; see
  docs/android-push.md).
- **429 Too Many Requests.** The app talks to the API directly and polls several endpoints; raise
  the server's `OPTIO_RATE_LIMIT_MAX` (default 600 per minute).
- **The app closed, or its home-screen icon vanished, after changing the icon.** Both are how
  launchers treat activity aliases; reopen Optio from the app drawer.
- **`emu.sh start` exits 75.** The dev lab is full (`OPTIO_EMU_MAX`, default 3). Do JVM and
  Robolectric work and retry later; never stop someone else's emulator.
- **Every Compose UI test fails in `InputManager.getInstance()`.** Robolectric ran on SDK 37. Keep
  the shared `sdk=36` (`gradle/robolectric/robolectric.properties`); override per class with
  `@Config(sdk = [...])`.
- **JDK.** Gradle runs on Android Studio's JBR 25 (any JDK 17–25 works; CI uses Temurin 21), and
  all bytecode targets Java 17. Robolectric on a recent JDK needs the `--add-exports`,
  `--add-opens` and `--enable-native-access` flags that build-logic adds to every Android test
  task, so run tests through Gradle.

## Toolchain

| Piece       | Version                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| Gradle      | 9.7.1 wrapper, with the configuration cache and the build cache on           |
| AGP         | 9.4.1, using its built-in Kotlin support (no `org.jetbrains.kotlin.android`) |
| Kotlin      | 2.4.20, plus the Compose compiler and kotlinx.serialization plugins          |
| JDK         | Gradle runs on JBR 25; all bytecode targets Java 17                          |
| Android SDK | compileSdk 37 (minor 2, AGP 9.4.1's newest), targetSdk 37, minSdk 29         |
| Compose     | BOM 2026.09.00 (Material 3 1.4.0), Navigation 3 1.1.7, Lifecycle 2.11.0      |

The versions of everything else are in `gradle/libs.versions.toml`, and the SDK levels are in
`build-logic/convention/src/main/kotlin/dev/optio/buildlogic/OptioSdk.kt`.

## Modules

| Module              | Kind            | What it holds                                                                                    |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `:app`              | application     | `OptioApplication` + `AppGraph`, `MainActivity`, root, `MainShell`, the five hubs                |
| `:core:model`       | Kotlin/JVM      | generated wire types (`SharedTypes.kt`), `OptioJson`, serializers                                |
| `:core:network`     | Kotlin/JVM      | `ApiClient`, `WebSocketClient`, `EventHub`, auth endpoints                                       |
| `:core:data`        | Android         | server profiles, `TokenStore`, `SessionStore`, `CurrentUser`, `DeepLink`                         |
| `:core:navigation`  | Android+Compose | `Tab`, `Section`, `WorkView`, routes, `AppRouter`, `Navigator`                                   |
| `:core:ui`          | Android+Compose | `OptioTheme`, shared components, placeholders, the hub slot API                                  |
| `:core:terminal`    | Android+Compose | the terminal view and key bar on the Termux emulator libraries                                   |
| `:core:testing`     | Android+Compose | Robolectric/Roborazzi helpers, `FakeOptioServer`, sample models (tests only)                     |
| `:core:workfeed`    | Android         | the merged Work feed (web `lib/work-feed.ts`)                                                    |
| `:core:glance`      | Android         | needs-you snapshots and Watch state for the widgets, tiles and notifications                     |
| `:feature:auth`     | feature         | `SignInScreen`, `AddServerRoute`                                                                 |
| `:feature:overview` | feature         | `OverviewScreen`                                                                                 |
| `:feature:work`     | feature         | `WorkListSection`                                                                                |
| `:feature:workform` | feature         | the New / Edit work form                                                                         |
| `:feature:tasks`    | feature         | task, job, job run and scheduled screens                                                         |
| `:feature:reviews`  | feature         | `ReviewsSection`, `InboxSection`, review detail                                                  |
| `:feature:insights` | feature         | `AnalyticsSection`, `CostsSection`, `ActivitySection`, `ClusterSection`, pod detail              |
| `:feature:local`    | feature         | `MachinesSection`, Local terminal and automation screens                                         |
| `:feature:agents`   | feature         | persistent-agent chat and form                                                                   |
| `:feature:sessions` | feature         | pod session screen                                                                               |
| `:feature:library`  | feature         | `PromptsSection`, `ReposSection`, `ConnectionsSection` and their screens                         |
| `:feature:more`     | feature         | `MoreScreen`, settings, admin, servers                                                           |
| `:feature:glance`   | feature         | the Watch notification, alerts and their actions, FCM push, the background check, Watch settings |
| `:feature:widgets`  | feature         | the Work and Run widgets, Quick Settings tiles, app shortcuts                                    |

Packages are `dev.optio.core.<module>`, `dev.optio.feature.<module>` and `dev.optio.app`, and the
same names are used as the Android namespaces. The applicationId is `dev.optio.android`. Two
modules share the name `glance` (`:core:glance`, `:feature:glance`), so always refer to them by
path.

### Dependency rules (binding)

```
:app                 → every :feature:* and :core:*
:feature:*           → :core:* only, NEVER another :feature:*
:core:ui             → :core:data, :core:navigation, :core:model
:core:navigation     → :core:data
:core:data           → :core:network → :core:model
:core:workfeed       → :core:data (+ network, model)
:core:glance         → :core:data, :core:workfeed (+ network, model)
:core:terminal       → Android + Termux libraries only
:core:testing        → test helpers, used via testImplementation
```

A feature that needs another feature's screen pushes that feature's route key (every key lives in
`:core:navigation`) and never imports the other feature's code.

## Convention plugins (`build-logic/`)

Module build files apply one of these and add only what is specific to them:

| Plugin id                       | For                            | Adds                                                                                                                                                |
| ------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `optio.android.application`     | `:app`                         | Android app + Compose, targetSdk, androidTest deps                                                                                                  |
| `optio.android.library`         | non-UI Android modules         | Android library settings + unit-test setup                                                                                                          |
| `optio.android.library.compose` | UI modules                     | the library settings + Compose (BOM, ui, foundation, material3, tooling), Compose UI tests, Roborazzi                                               |
| `optio.android.feature`         | every `:feature:*`             | library.compose + serialization + `:core:model/network/data/navigation/ui` + Navigation 3 + lifecycle/ViewModel Compose + `:core:testing` for tests |
| `optio.jvm.library`             | `:core:model`, `:core:network` | Kotlin/JVM, Java 17, JUnit 4                                                                                                                        |

In module build files use the catalog aliases, e.g. `alias(libs.plugins.optio.android.feature)`.
Add `alias(libs.plugins.kotlin.serialization)` when a non-feature module declares `@Serializable`
types. Every Android module gets minSdk/compileSdk, Java 17, unit tests with Android resources and
default return values, and JUnit 4, `kotlin-test-junit`, coroutines-test, Turbine, Robolectric and
AndroidX Test on the unit-test classpath. Compose modules also opt in to
`ExperimentalMaterial3Api` module-wide.

## Conventions

### Routes

Routes are `@Serializable` Navigation 3 `NavKey`s: a `data class` when they take arguments and a
`data object` when they take none. Each area has one file in
`core/navigation/src/main/kotlin/dev/optio/core/navigation/routes/<Area>Routes.kt` (`TaskRoutes.kt`,
`LibraryRoutes.kt`, …), and owners add routes to their own area file only. Keep arguments to
strings, numbers, booleans and enums. Back stacks are saved across process death by serializing
their keys, so a key must never hold a model object.

```kotlin
@Serializable
data class TaskDetailRoute(val id: String) : NavKey

@Serializable
data object SettingsRoute : NavKey
```

`HubRoute(tab)` is the root of every tab's back stack and is owned by `:app`.

### Entry registration

Each feature module exports exactly one entry function, named after the module, which registers a
screen for each of its routes:

```kotlin
fun EntryProviderScope<NavKey>.tasksEntries() {
    entry<TaskDetailRoute> { key -> TaskDetailScreen(taskId = key.id) }
    entry<JobRunRoute> { key -> JobRunScreen(jobId = key.jobId, runId = key.runId) }
}
```

The functions are `authEntries`, `overviewEntries`, `workEntries`, `workFormEntries`,
`tasksEntries`, `reviewsEntries`, `insightsEntries`, `localEntries`, `agentsEntries`,
`sessionsEntries`, `libraryEntries`, `moreEntries` and `glanceEntries`. `:feature:widgets` has no
routes: its widgets, tiles and shortcuts reach the app through `optio://` links. `MainShell` calls
all of them once, in `app/src/main/kotlin/dev/optio/app/shell/AppEntries.kt`. An entry's screen
draws its own `Scaffold` and top app bar with a back button that calls
`LocalNavigator.current.pop()`. `viewModel()` inside an entry is scoped to that entry: it lives
while the entry is on its back stack, including while another tab is on screen.

### Sections

Hub sections, and the single-screen hubs `OverviewScreen` and `MoreScreen`, all share one
signature:

```kotlin
@Composable
fun ReposSection(contentPadding: PaddingValues, modifier: Modifier = Modifier)
```

The hub in `:app` draws the chrome: the top app bar with the tab title, the segmented switcher and
the FAB slot. The section draws only its body. It fills the available space and applies
`contentPadding` to its scrolling container (`LazyColumn(contentPadding = contentPadding)`), so the
content scrolls under the bars. It never adds a top bar of its own.

| Hub      | Sections (switcher order)                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview | `OverviewScreen` (`:feature:overview`)                                                                                                      |
| Work     | All `WorkListSection` (work) · Reviews `ReviewsSection` · Inbox `InboxSection` (reviews)                                                    |
| Library  | Prompts `PromptsSection` · Repos `ReposSection` (library) · Machines `MachinesSection` (local) · Connections `ConnectionsSection` (library) |
| Insights | `AnalyticsSection` · `CostsSection` · `ActivitySection` · `ClusterSection` (insights)                                                       |
| More     | `MoreScreen` (`:feature:more`)                                                                                                              |

### Hub slot API (`dev.optio.core.ui.hub`)

A section contributes top-bar actions and a FAB to the hub that hosts it:

```kotlin
@Composable
fun ReposSection(contentPadding: PaddingValues, modifier: Modifier = Modifier) {
    val navigator = LocalNavigator.current
    HubActions {
        IconButton(onClick = { navigator.push(NewRepoRoute) }) {
            Icon(Icons.Filled.Add, contentDescription = "Add repo")
        }
    }
    HubFab {
        ExtendedFloatingActionButton(onClick = { … }, icon = { … }, text = { Text("New") })
    }
    LazyColumn(modifier.fillMaxSize(), contentPadding = contentPadding) { … }
}
```

`HubActions { }` takes a `RowScope` lambda for `TopAppBar(actions = …)`, and `HubFab { }` takes the
FAB. A registration lives as long as the section is composed, and the newest one wins. Call each at
most once per section. Outside a hub (details, previews, screenshot tests) both calls do nothing.
The hub side uses `rememberHubController()`, provides it through `LocalHubController`, and renders
`controller.actions` and `controller.fab`.

### Moving around

- `LocalNavigator.current` is what features use. `push(route)` and `pop()` act on the current tab.
  `open(section, view)` switches to the tab that owns the section, pops it to its hub and selects
  the section. `openExternal(url)` opens a Custom Tab. `openDeepLink(url)` routes an `optio://`
  link like a notification tap (a `?server=<id>` for another paired server switches first).
  `showCreatedWork(route, toast)` is the New/Edit work form's "done": it closes the form, lands on
  Work › All with `route` pushed and shows `toast`. The default is `Navigator.None`, so previews and
  screenshots need no setup.
- `LocalAppRouter.current` (the shell and the hubs) holds the selected tab, one
  `SnapshotStateList<NavKey>` back stack per tab, the section selected in each hub, and
  `pendingWorkView`. Tapping the selected tab pops it to its hub, and Back at the hub of any tab
  other than Overview returns to Overview. The router's state survives rotation and process death.
  `handle(url)` / `handle(DeepLink)` route `optio://` links (details push onto the Work tab).

### Tests

- Use JUnit 4 with `kotlin.test` assertions, `kotlinx-coroutines-test` and Turbine.
- For Robolectric, annotate the class with `@RunWith(AndroidJUnit4::class)`. Tests run on **SDK 36**
  by default (`gradle/robolectric/robolectric.properties`, added to every module's test resources):
  on API 37, Espresso 3.7.0's idling hook calls `InputManager.getInstance()`, which no longer exists,
  so every Compose UI test would fail. The test JVM also gets
  `--add-exports java.base/jdk.internal.access=ALL-UNNAMED` (Robolectric on JDK 25).
- For Compose UI tests, use `androidx.compose.ui.test.junit4.v2.createComposeRule`, because the
  un-versioned one is deprecated.
- For screenshots, add `@GraphicsMode(GraphicsMode.Mode.NATIVE)` and call
  `compose.onRoot().captureRoboImage("build/outputs/roborazzi/<Name>.png")`. Files are written only
  by `./gradlew :<module>:recordRoborazziDebug`; `testDebugUnitTest` runs the same test without
  writing. Use `@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)` for phone size and append
  `+night` for dark mode. `app/src/test/.../MainShellTest.kt` is a working example. For light and
  dark captures of one screen, `captureScreens` in `:core:testing` does all of this (see
  [Testing](#testing)).

### Version catalog

Add entries to `gradle/libs.versions.toml` as needed, but never change an existing version
without the orchestrator. Compose libraries take their version from the BOM. Firebase messaging
(through the Firebase BOM) is a dependency of `:feature:glance`; the google-services plugin is
applied to `:app` only when `app/google-services.json` exists (see
[Server push](#server-push-optional-fcm)).

## Gotchas

- AGP 9 compiles Kotlin itself. Never apply `org.jetbrains.kotlin.android`, and use
  `kotlin { compilerOptions { … } }` or the convention plugins, not `kotlinOptions`.
- Kotlin block comments nest, so a `/*` inside KDoc, such as `Features/Overview/*`, opens a
  comment that never closes ("Unclosed comment").
- `libs.plugins.optio.android.library` is both an alias and the prefix of
  `optio.android.library.compose`. `alias(...)` handles that; code that calls `.get()` needs
  `.asProvider()`.
- Termux artifacts resolve only from JitPack (an exclusive content filter on
  `com.github.termux.*`); nothing else is fetched from JitPack.
- `MainShell` keeps every tab's entries decorated (`rememberDecoratedNavEntries`), so switching tabs
  preserves scroll positions and ViewModels. The root keys it on `session.generation`, so a server
  switch drops all of it (every screen restarts for the new server, like iOS).
- Android 17 (API 37) blocks local-network addresses (a LAN laptop, the emulator's `10.0.2.2`)
  without the runtime permission `ACCESS_LOCAL_NETWORK` ("Nearby devices"): requests just time
  out. The app asks when you connect to a local address (`LocalNetworkAccess` in `:core:data`). For
  scripted runs, install with `adb install -r -g` (grants it) or
  `adb shell pm grant dev.optio.android android.permission.ACCESS_LOCAL_NETWORK`.
- Debug builds read `OPTIO_DEV_*` launch extras (servers, `OPTIO_DEV_SECTION`,
  `OPTIO_DEV_OPEN_URL`, `OPTIO_DEV_TOAST`, …); see [Debug dev extras](#debug-dev-extras). `adb shell`
  splits arguments on spaces, so quote values that contain them twice:
  `--es OPTIO_DEV_TOAST "'Hello there'"`.

## App icon

The adaptive launcher icon is `app/src/main/res/drawable/ic_launcher_foreground.xml`: the lucide
`bot` glyph from `apps/ios/Design/app-icon.svg`, converted by hand to stroked paths inside the 66dp
safe zone. It sits on `#6d28d9` and doubles as the monochrome (themed-icon) layer.
`./gradlew :app:recordRoborazziDebug` renders it to `app/build/outputs/roborazzi/LauncherIcon.png`,
with the safe zone outlined.

The seven alternates (see [App icons](#widgets-quick-settings-tiles-app-shortcuts-and-app-icons))
are rendered from the iOS sources in `apps/ios/Design/icons/<slug>.svg` by
`node apps/android/feature/more/scripts/render-app-icons.mjs` (run from the repo root; it uses
`sharp` from the pnpm store). It writes the adaptive-icon layers
(`app/src/main/res/drawable-nodpi/ic_launcher_alt_<slug>.webp`) and the picker thumbnails
(`feature/more/src/main/res/drawable-nodpi/app_icon_<slug>.webp`). The adaptive-icon XMLs
(`app/src/main/res/mipmap-anydpi/ic_launcher_<slug>.xml`) and the `<activity-alias>` entries are
hand-written; keep the slugs in sync with `AppIconOption` in `:feature:more`.
