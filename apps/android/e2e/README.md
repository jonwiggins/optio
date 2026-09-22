# Android dev lab

Device and test infrastructure for the Optio Android app. Everything here runs next to the
user's real Optio (k8s cluster on `localhost:30400`, a real `optio local up` daemon and
`~/.config/optio`) without touching it.

| Tool                                  | What it gives you                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/android/scripts/emu.sh`         | Headless emulator instances of the shared AVD `optio` (read-only, several at once)        |
| `apps/android/scripts/test-api.sh`    | A private Optio API: real server, fake agent runtime, auth disabled, seeded data          |
| `apps/android/scripts/test-daemon.sh` | An isolated Optio Local daemon attached to a test API, for live terminals and transcripts |
| `apps/android/e2e/launch-api.ts`      | What `test-api.sh` runs: infra, hermetic API process, seed, `seed.json`                   |
| `apps/android/e2e/verify-daemon.mjs`  | What `test-daemon.sh verify` runs                                                         |

## Quick start

Shell state does not persist between Bash calls, so start each one with the environment
(PLAN §2) and run the scripts from your worktree root:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"   # JBR 25
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

apps/android/scripts/test-api.sh start            # shared API on 4961 (idempotent), ~25 s
SERIAL=$(apps/android/scripts/emu.sh start --port 5562)   # prints emulator-5562, ~23 s
adb -s "$SERIAL" install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$SERIAL" shell am start -n dev.optio.android/dev.optio.app.MainActivity \
  --es OPTIO_DEV_SERVER_URL http://10.0.2.2:4961 --es OPTIO_DEV_TOKEN dev
adb -s "$SERIAL" exec-out screencap -p > /tmp/shot.png    # then Read the PNG

apps/android/scripts/emu.sh stop "$SERIAL"        # always stop what you started
```

`pnpm install --frozen-lockfile --prefer-offline` must have run once in your worktree (the
test API runs the API from your worktree's `apps/api`). Docker must be running (test
Postgres/Redis containers).

## Ports

| What                   | Port                                                       | Notes                                                         |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| Shared test API        | **4961**                                                   | Start it if it is not running; stop it only if you started it |
| Private test APIs      | **4962–4979**                                              | Your own seeded copy; use it for anything that mutates a lot  |
| Emulator console ports | even numbers **5554–5680** (adb uses port+1)               | Serial is `emulator-<port>`                                   |
| Never                  | 4931, 3131 (web e2e), 30400, 30310 (the user's real Optio) | The scripts refuse these                                      |

Suggested fixed ports so parallel agents never race for one:

| Agent             | Emulator                      | Private API                  |
| ----------------- | ----------------------------- | ---------------------------- |
| Orchestrator / QA | 5554                          | 4975                         |
| A1 … A9           | 5556 … 5572 (A_n = 5554 + 2n) | 4962 … 4970 (A_n = 4961 + n) |
| C / U / X         | 5574 / 5576 / 5578            | 4971 / 4972 / 4973           |
| S, T              | 5580                          | 4976                         |
| D (DevLab)        | 5582                          | 4977                         |
| P                 | 5584                          | 4974                         |

`emu.sh start` without `--port` takes the first free even port from 5554.

## Emulator: `emu.sh`

```
emu.sh start [--port N] [--avd NAME] [--window] [--gpu MODE] [--timeout SECS] [--reuse]
emu.sh stop <serial|port> [--force] [--timeout SECS]
emu.sh list
emu.sh http <serial|port> <http://host:port/path>
```

- `start` launches `emulator -avd optio -port N` in its own session with
  `-read-only -no-snapshot-load -no-snapshot-save -no-audio -no-boot-anim -no-metrics` and
  `-gpu host -no-window`, waits for `sys.boot_completed`, a live package manager and a guest
  network that reaches the host (`ping 10.0.2.2`), re-applies the test settings, and prints
  **only the serial** on stdout (progress goes to stderr). Exit 1 with the log tail when the
  emulator dies or does not boot within `--timeout` (default 240 s).
- An emulator already on the port is an error that names its pid, AVD and owner; `--reuse`
  returns its serial instead when it is booted.
- `stop` runs `adb emu kill`, falls back to SIGTERM/SIGKILL of that pid only, and waits until
  adb forgets the serial. It refuses to stop an instance another worktree started (`--force`
  overrides; don't). Stopping a port with nothing on it is a no-op.
- `list` shows every emulator on the machine (adb, emu.sh state, qemu processes): serial, adb
  state, AVD, pid, uptime, booted, owner worktree.
- `http` GETs a URL from inside the device with toybox `nc` (the image has no curl/wget).
- `--window` shows the emulator window on the user's desktop (default: headless);
  `--gpu swiftshader_indirect` is the software fallback if `host` misbehaves.
- State and logs: `~/.android/optio-devlab/emulators/<port>/` (`emulator.log`, pid, owner).

### The AVDs

| AVD                | Image                                                                                                                                                   | Hardware                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `optio` (default)  | `system-images;android-37.0;google_apis;arm64-v8a` r6: Android 17, API 37.0, Google APIs with Google Play services (FCM-capable), userdebug, 4 KB pages | Pixel 10 profile, 1080×2424 @ 420 dpi, 4 GB RAM, 4 cores, hardware keyboard, 8 GB data, no SD card, emulated back camera |
| `optio-16k` (opt.) | `system-images;android-37.2;google_apis_ps16k;arm64-v8a` r5: API 37.2, **16 KB pages**                                                                  | Same                                                                                                                     |

API 37.0 is the newest stable 4 KB-page Google APIs image; 37.1/37.2 ship only as 16 KB-page
builds. Use `--avd optio-16k` once to check the app on 16 KB pages: native libraries that are
not 16 KB-aligned (e.g. Termux's `libtermux.so`, which we never load: exclude it from
packaging) trigger Android's page-size compatibility mode and its warning dialog there.

Both AVDs have these baked into their base userdata: animations off, stay awake while
plugged in, screen-off timeout max, lock screen disabled, adb-install verification off (no
Play Protect prompts), immersive-mode hint confirmed. Emulator 37.1.11, platform-tools 37.0.1,
cmdline-tools 23.0.

**Read-only means disposable.** Each start is a cold boot from that base; installed APKs and
app data vanish on stop. Never boot `optio` without `-read-only` (Android Studio's device
manager does): a writable boot changes the base for everybody.

### Driving the UI

```bash
adb -s $SERIAL exec-out screencap -p > shot.png                  # screenshot (1080×2424)
adb -s $SERIAL shell uiautomator dump /sdcard/ui.xml && adb -s $SERIAL exec-out cat /sdcard/ui.xml
android --no-metrics layout --device=$SERIAL --flat              # JSON: resource-id, text, bounds, center
android --no-metrics screen capture --device=$SERIAL -a -o shot.png   # screenshot with numbered UI labels
adb -s $SERIAL shell input tap 540 1200
adb -s $SERIAL shell input text 'hello%sworld'                   # %s = space
adb -s $SERIAL shell input keyevent KEYCODE_ENTER                # BACK, ESCAPE, TAB, DPAD_*, …
adb -s $SERIAL shell am start -a android.intent.action.VIEW -d 'optio://section/work?view=recurring'
adb -s $SERIAL logcat -d -t 200 '*:W'
```

- Compose `testTag`s show up as resource-ids when the app sets `testTagsAsResourceId`.
- `android layout` (new Android CLI in cmdline-tools) installs a helper on the device the first
  time per boot (~5 s).
- The hardware keyboard is on, so the soft keyboard stays hidden (clean screenshots). To see the
  IME and its insets (terminal key bar, chat composer):
  `adb -s $SERIAL shell settings put secure show_ime_with_hard_keyboard 1`.
- `sys.boot_completed` fires before the launcher finishes painting; that is fine for
  `am start`, but a screenshot right after `start` may show a half-drawn home screen.

### Reaching the API from the device

The API listens on 127.0.0.1 only. The emulator maps **`10.0.2.2` to the host's loopback**,
so `http://10.0.2.2:4961` works with no setup; check it with
`emu.sh http emulator-N http://10.0.2.2:4961/api/health` (`emu.sh start` already waits until the
guest network can reach the host). Alternative: `adb -s $SERIAL reverse tcp:4961 tcp:4961` and
use `http://127.0.0.1:4961` in the app (handy for a second profile on the same API, or to test
"localhost" URLs). Plain HTTP must be allowed by the app's network security config.

## Private test API: `test-api.sh`

```
test-api.sh start  [--port N] [--no-seed] [--timeout SECS] [--log-level LEVEL]
test-api.sh stop   [--port N] [--force]
test-api.sh status [--port N | --all]
```

`start` (default port 4961) backgrounds `launch-api.ts` and returns once the API is healthy
**and** seeding finished. It is idempotent: if the port already runs a ready instance, from
any worktree, it prints the summary and exits 0. `stop` stops the API and **drops its
database**, so the next `start` gets fresh ids. `status` exits 0 when ready, 3 when not
running.

What runs: the test Postgres/Redis containers (`scripts/test-infra.sh`, shared with the other
test tiers; `stop` never removes them), a private database cloned from the migrated template,
and the real API server (`tsx apps/api/src/index.ts`) with `OPTIO_RUNTIME=fake`,
`OPTIO_AUTH_DISABLED=true` and the pipeline-e2e worker intervals. Agents are played by the fake
runtime (`packages/container-runtime/src/fake.ts`), so nothing costs money.

State: `apps/android/e2e/.run/<port>/` in the worktree that started it: `api.log` (launcher +
API, `LOG_LEVEL=warn`), `server.json` (phase, pids, database), `seed.json`, `launcher.pid`,
`api.pid`. `~/.android/optio-devlab/test-api/<port>` points at the owning run dir, which is how
other worktrees find a shared instance (and why only its owner, or `--force`, can stop it).

### Hermetic by design

- Listens on 127.0.0.1 only (reach it from a device via 10.0.2.2).
- `KUBECONFIG` points at a **fake read-only Kubernetes API** served by the launcher (one
  `docker-desktop` node, Optio pods incl. one in CrashLoopBackOff, services, events, metrics),
  and `kubectl`/`helm` on its PATH are stubs. The cluster screens work; nothing reaches the real
  cluster (the stock e2e stack would read, and `restart`/`update` would act on, the real one).
- A `security` stub and an empty `CLAUDE_CONFIG_DIR` hide this Mac's Claude login: the API
  reports no subscription and never validates, stores or serves the user's token.
- Credential env vars (`GITHUB_*`, `ANTHROPIC_*`, `AWS_*`, …) and `OPTIO_*` settings from your
  shell are not passed on. Dev-only overrides: `OPTIO_STALL_THRESHOLD_MS` and
  `OPTIO_STALE_TASK_MS` (one year, so seeded "running" work stays running) and a known
  `GITHUB_WEBHOOK_SECRET` (in `seed.json`) for signed GitHub events.

### What is seeded

Names are stable; ids change on every fresh start, so read them from `seed.json`.

| Area           | Seeded                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets        | `GITHUB_TOKEN`, `ANTHROPIC_API_KEY` (dummy values; setup wizard reads as done)                                                                                                                                                                                                                                                                                                                                        |
| Repos          | `e2e-org/e2e-repo` (maxConcurrentTasks 6), `e2e-org/mobile-app`                                                                                                                                                                                                                                                                                                                                                       |
| Tasks          | `pr_opened` (cost $0.42, with a comment), `completed` via a signed PR-merged webhook ($0.88), `failed` (maxRetries 0), `needs_attention` (finished without a PR), `running` (hangs forever, on mobile-app), `cancelled`, `waiting_on_deps`, `queued` (runs on the offline laptop), and a completed **review** subtask of the PR task                                                                                  |
| Jobs           | "Nightly release notes": runs `completed` ($0.052), `failed`, `running` (hangs). "Triage Sentry alerts": a **webhook trigger** (`/api/hooks/android-e2e-sentry-<port>`) and one webhook-started run                                                                                                                                                                                                                   |
| Scheduled task | "Weekly dependency bump" (task config) with a **schedule trigger** `0 9 * * 1` and one prior run (`pr_opened`)                                                                                                                                                                                                                                                                                                        |
| Prompts        | One named prompt per kind: `prompt`, `task`, `job`, `review` (the global default templates are untouched)                                                                                                                                                                                                                                                                                                             |
| Agents         | "Release Captain" (idle, one user message processed; reply in its turn logs; daily schedule trigger), "Docs Gardener" (paused, on-demand pods)                                                                                                                                                                                                                                                                        |
| Local          | Host **"E2E laptop"** (offline) with 2 dirs; automation "Fix flaky tests" (headless Claude Code, schedule trigger); a **recorded agent session** (exited 0, needs you/done, 14-entry transcript with thinking, tool calls, an error result and markdown, usage $0.0184, PR link, final screen); a recorded failed `npm run build` session (exit 2, screen only); a shell parked `pending` because the host is offline |
| Pod sessions   | "Investigate slow cold start" (active, a PR, one chat exchange), "Try the new image loader" (ended)                                                                                                                                                                                                                                                                                                                   |
| Connections    | "Docs filesystem" (filesystem, marked healthy), "Status page API" (custom HTTP, assigned to e2e-repo); MCP server "everything"                                                                                                                                                                                                                                                                                        |
| Webhooks       | One outbound webhook to `https://hooks.example.invalid/optio` (never resolves, so its delivery history fills with failures)                                                                                                                                                                                                                                                                                           |
| Settings       | Optio agent settings: model sonnet, confirm writes, 20 max turns                                                                                                                                                                                                                                                                                                                                                      |
| Derived        | Costs, recent runs, cluster pods and overview fill in from the above                                                                                                                                                                                                                                                                                                                                                  |

The "recorded" Local sessions are played over the real daemon protocol by a scripted daemon
during seeding (no daemon, no LLM): the Transcript and Screen faces render exactly as for a real
session. For a live session, use the test daemon below.

### `seed.json`

Every entry is optional: a seed step that fails is logged, listed in `errors`, and skipped.

```text
{
  "version": 1,
  "generatedAt": "2026-09-22T23:24:31.512Z",
  "api": {
    "port": 4961,
    "baseUrl": "http://127.0.0.1:4961",
    "emulatorBaseUrl": "http://10.0.2.2:4961",
    "token": "dev",
    "authDisabled": true,
    "githubWebhookSecret": "android-devlab-github-webhook-secret"
  },
  "errors": [],                       // [{ "step": "...", "error": "..." }]
  "secrets": ["GITHUB_TOKEN", "ANTHROPIC_API_KEY"],
  "repos": { "main": { "id", "repoUrl", "fullName" }, "second": { … } },
  "prompts": { "prompt": { "id", "name", "kind" }, "task": …, "job": …, "review": … },
  "tasks": {
    "prOpened": { "id", "title", "state", "prUrl", "commentId" },
    "completed": { "id", "title", "state", "prUrl" },
    "failed" | "needsAttention" | "running" | "cancelled" | "waitingOnDeps" | "queuedLocal" | "review": { "id", "title", "state" }
  },
  "jobs": {
    "main": { "id", "name", "runs": { "completed", "failed", "running" } },
    "webhook": { "id", "name", "triggerId", "webhookPath", "hookUrl", "runId" }
  },
  "scheduled": { "id", "name", "triggerId", "cron", "lastRunTaskId" },
  "agents": { "main": { "id", "slug", "name", "triggerId" }, "paused": { "id", "slug", "name", "state" } },
  "connections": { "filesystem": { "id", "name" }, "http": { "id", "name", "assignmentId" } },
  "mcpServer": { "id", "name" },
  "webhooks": { "main": { "id", "url" } },
  "sessions": { "active": { "id", "title", "state", "chatEvents" }, "ended": { "id", "title", "state" } },
  "local": {
    "offlineHost": { "id", "name", "hostname", "dirs": [{ "path", "repoUrl"? }] },
    "automation": { "id", "name", "triggerId" },
    "recordedAgentSession": { "terminalId", "title", "transcriptEntries", "prUrl" },
    "recordedCommandSession": { "terminalId", "title", "exitCode" },
    "parkedTerminal": { "id", "title", "state" }
  },
  "daemon": { "hostId", "hostName", "dirs", "verifiedAt", "transcriptTerminalId"? }  // added by test-daemon.sh verify
}
```

Read it with `node -p 'require("./apps/android/e2e/.run/4961/seed.json").tasks.running.id'`,
or from a JVM test via `OPTIO_TEST_API_URL` + the path (an instance started from another
worktree lives in `readlink ~/.android/optio-devlab/test-api/4961`).

### Auth-disabled mode

Any token works (`OPTIO_DEV_TOKEN dev`); `GET /api/auth/me` returns the synthetic "Local Dev"
user; `GET /api/auth/ws-token` returns `auth-disabled`; WebSockets take any
`optio-auth-<token>` subprotocol. These answer **401** because there is no real user (expected;
handle it gracefully): `/api/workspaces/**`, `/api/auth/api-keys/**`, every
`/api/notifications/**` route (preferences, devices, subscriptions, live activities),
**`GET /api/glance/watch`** and `GET /api/users/lookup`.

### Known gaps

- **Reviews list and Inbox are empty.** `GET /api/pull-requests` and `GET /api/issues` are
  fetched live from GitHub; the seeded repos are fake. External PR reviews cannot be created
  either. Use fixtures for those screens (a review subtask exists on the PR task).
- **`GET /api/activity` returns 500** on current main: `apps/api/src/routes/activity.ts:168`
  does `COALESCE(te.from_state, 'new')` on an enum column (needs `te.from_state::text`). Not a
  test-API problem; the Activity screen shows its error state until the API is fixed.
- `GET /api/auth/usage` reports no subscription (Claude login hidden on purpose).
- `POST /api/repos/:id/detect` returns 500 with auth disabled.

### Making more data

The fake runtime reads directives from the prompt (or title): `[[mock:pr]]` (opens a PR →
`pr_opened`), `[[mock:fail]]`, `[[mock:silent]]` (no output → failed), `[[mock:sleep:MS]]`,
`[[mock:hang]]`, `[[mock:cost:X]]`. Only `claude-code` (and `cursor`) agents are playable.

```bash
API=http://127.0.0.1:4962   # prefer a private instance for writes
curl -s $API/api/tasks -H 'content-type: application/json' -d '{"title":"Try it","prompt":"Do it [[mock:pr]] [[mock:cost:0.2]]","repoUrl":"https://github.com/e2e-org/e2e-repo","agentType":"claude-code"}'
curl -s $API/api/jobs/<jobId>/runs -H 'content-type: application/json' -d '{"params":{"mode":"[[mock:fail]]"}}'
curl -s $API/api/persistent-agents/<agentId>/messages -H 'content-type: application/json' -d '{"body":"Status?"}'
curl -s $API/api/hooks/android-e2e-sentry-4962 -H 'content-type: application/json' -d '{"title":"Boom","url":"https://x.invalid/1"}'
```

Completing a `pr_opened` task: POST a `pull_request` `closed`+`merged` event for its `prUrl` to
`/api/webhooks/github` with the header `X-Hub-Signature-256: sha256=<hex HMAC-SHA256>` of the
raw body, keyed by `api.githubWebhookSecret` (see `githubEvent()` in `launch-api.ts`). Messaging a
`needs_attention`/`pr_opened`/`failed` task resumes it (back to `queued`). Seeded "running"
work never stalls; cancel it instead.

### Limits

- **50 WebSockets per client IP**, hard-coded in the API. Every emulator and the test daemon
  arrive as 127.0.0.1, so on the shared instance everybody shares that budget: close sockets you
  open, and use a private instance for socket-heavy tests. (The HTTP rate limit exempts
  127.0.0.1.)
- Global concurrency is the API default (5 task runs, 5 job runs); the seed keeps one task run
  and one job run busy (they hang on purpose).

## Isolated Optio Local daemon: `test-daemon.sh`

```
test-daemon.sh start  [--port N]            # needs a running test API on that port
test-daemon.sh stop   [--port N]
test-daemon.sh status [--port N]
test-daemon.sh verify [--port N] [--agent]
```

`start` builds `apps/cli` if `dist/optio.js` is missing or older than its sources, then runs
`node apps/cli/dist/optio.js --server http://127.0.0.1:<port> --api-key devlab local up` with
`XDG_CONFIG_HOME=apps/android/e2e/.run/<port>/daemon/xdg` (its own `local.json`, hook settings,
`claude` shim and zsh wrapper), and waits for the host to show online (~2 s). The host is named
after this Mac (`hostname`), with two allowlisted dirs in
`apps/android/e2e/.run/<port>/playground/`:

- `e2e-repo`: a git checkout whose `origin` is the seeded repo, so "run on my machine" Tasks and
  Local runs match it;
- `scratch`: a plain dir for shells and jobs.

One daemon per API port (they would share the host row); a daemon started from another
worktree is reported, not replaced. Log: `.run/<port>/daemon/daemon.log`.

`verify` checks the host is online, creates a `{kind:"shell"}` terminal, attaches to
`/ws/local/terminals/:id/stream` (subprotocols `optio-ws-v1`, `optio-auth-dev`), types a command
through the socket and reads its output back, then kills and deletes the terminal (~7 s).
`verify --agent` additionally runs **one headless Claude Code session (haiku) — a real LLM call
on this Mac's own Claude login, about $0.01** — and checks that
`GET /api/local/terminals/:id/transcript` has the prompt and the reply. That terminal is kept, and its
id is written to `seed.json` as `daemon.transcriptTerminalId`.

Things to know:

- Terminals are real processes on this Mac, running as the user in the playground dirs. Shells
  are login shells (your zsh dotfiles run). Agent terminals are real `claude` runs: real cost,
  and they write session files to `~/.claude/projects/` like any Claude Code session.
- The daemon **cannot hand this Mac's Claude login to the test API**: the Node preload
  `apps/android/e2e/no-host-claude-login.mjs` hides it from the daemon process (hosts report
  `claudeCredentials=false`), while the `claude` it spawns still uses the login. Set
  `OPTIO_DEVLAB_SHARE_CLAUDE_LOGIN=1` only to test "refresh token from machine" on purpose.
- It never touches the user's daemon or `~/.config/optio`, and `stop` only signals the pid it
  started (and only if its command line is this port's `local up`).

## Pointing the app at the API (debug dev extras)

Debug builds read launch-intent extras (mirroring the iOS `SIMCTL_CHILD_OPTIO_DEV_*` variables).
One server, opening a section:

```bash
adb -s $SERIAL shell am start -S -n dev.optio.android/dev.optio.app.MainActivity \
  --es OPTIO_DEV_SERVER_URL http://10.0.2.2:4961 --es OPTIO_DEV_TOKEN dev \
  --es OPTIO_DEV_SECTION local
```

Two servers (ids `dev-server`, `dev-server_2`, …; the second one a private instance on 4962):

```bash
adb -s $SERIAL shell am start -S -n dev.optio.android/dev.optio.app.MainActivity \
  --es OPTIO_DEV_SERVER_URL http://10.0.2.2:4961 --es OPTIO_DEV_TOKEN dev \
  --es OPTIO_DEV_SERVER_URL_2 http://10.0.2.2:4962 --es OPTIO_DEV_TOKEN_2 dev \
  --es OPTIO_DEV_SERVER_NAME_2 Staging
```

A deep link delivered after launch, e.g. the recorded Local session from `seed.json`:

```bash
TERM_ID=$(node -p 'require("./apps/android/e2e/.run/4961/seed.json").local.recordedAgentSession.terminalId')
adb -s $SERIAL shell am start -S -n dev.optio.android/dev.optio.app.MainActivity \
  --es OPTIO_DEV_SERVER_URL http://10.0.2.2:4961 --es OPTIO_DEV_TOKEN dev \
  --es OPTIO_DEV_OPEN_URL "optio://local/$TERM_ID?server=dev-server"
```

`-S` force-stops the app first so the extras apply to a fresh start. Sections: work, reviews,
inbox, prompts, repos, machines, connections, analytics, costs, activity, cluster, more.

## Timings (M1 Max, 64 GB)

| Step                                       | Time                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `emu.sh start` (headless, `-gpu host`)     | ~23 s: 15–18 s cold boot + ~5 s until the guest network is up (swiftshader +3 s; `optio-16k` ~26 s) |
| Two instances booting at once              | 15–17 s each                                                                                        |
| Idle emulator                              | ~2.9 GB memory footprint, ~40 % CPU                                                                 |
| `test-api.sh start` (full seed)            | ~25–30 s (`--no-seed`: ~5 s)                                                                        |
| `test-daemon.sh start`                     | ~2 s (+ ~1.5 s if the CLI is rebuilt)                                                               |
| `test-daemon.sh verify` / `verify --agent` | ~7 s / ~11 s                                                                                        |
| First `android layout` per boot            | ~5 s                                                                                                |

## Gotchas

- Stop what you start: `emu.sh stop`, `test-daemon.sh stop`, `test-api.sh stop` (only if you
  started it). Kill only your own pids; `pgrep -fl "local up"` also lists the user's real daemon
  (`--server http://localhost:30400`), which must never be touched.
- `adb devices` keeps a stopped emulator as `offline` for a moment; `emu.sh stop` waits it out.
- A stopped/restarted test API is a new database: ids in an old `seed.json` are gone.
- `apps/android/e2e/.run/` is git-ignored and prettier-ignored (its JSON is generated).
- The Android CLI (`android …`) prints a metrics notice; pass `--no-metrics`.
