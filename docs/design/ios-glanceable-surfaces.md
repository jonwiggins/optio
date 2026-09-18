# Optio iOS — Glanceable Surfaces

_Product brief: Live Activities, widgets, StandBy, Controls, App Intents. Status: proposal._

The job: **"I kicked off agents; tell me the moment one needs me, and let me answer from wherever I am, without babysitting."** Everything below is judged against that sentence. The phone is a remote control over Tailscale, not a second monitor.

## 1. Principles

- **One object owns the island: the thing waiting on you.** The Dynamic Island shows at most one Optio activity, and what it displays is the oldest item in the "needs you" queue. Not a dashboard, not a fleet view, not "5 running · 2 queued · $1.32".
- **Every Live Activity has a natural end.** An activity starts when work you care about begins and ends when nothing is running _and_ nothing is waiting on you (or at the 8-hour cap). No "Optio is online" activity that lives forever.
- **Silence is the default state.** `working` never alerts. `idle` never alerts. Only a transition into `needs_you` / `needs_attention` / `failed`, or something you explicitly asked to follow (a PR you're waiting on), gets sound or a banner.
- **Answering beats watching.** Each surface must offer the shortest path to the composer for the item shown. The metric is taps from lock screen to a sent reply (target: 2).
- **No vanity.** No cost tickers, no token counts, no sparkline of throughput on the lock screen. Insights stay in the app.
- **Monospace is earned, not decorative.** Directory basenames, branches, PR numbers, agent slugs get SF Mono. Prose and status words do not.
- **Degrade honestly.** If the API is unreachable (laptop asleep, tailnet down) the surface says so in plain words and stops pretending to be live.

What we will **not** do: dashboards in the island; a Live Activity per terminal (three agents would fight for the island and flicker); per-second log tails on the lock screen; pulsing or looping animations; a widget that just deep-links to the app with a logo.

## 2. Surface-by-surface spec

### 2a. Live Activity: "Watch" (one per user, the primary surface)

**Decision: one aggregate activity, not one per terminal, task, or episode.** A per-episode activity (`needs_you` → answered) is too short and too frequent: Claude Code stops every few minutes, so the island would start/end constantly and burn push budget. A per-terminal activity breaks the moment you run two agents (iOS shows two activities as minimal pills, three as nothing). One activity whose _content_ is "the oldest thing waiting on you, plus how many more" maps exactly to the job statement and gives the island one stable tenant.

**Sources feeding the Watch:** Local terminals with `spec.kind=agent` (attention state from the daemon), Repo Tasks the user started or follows, Persistent Agent turns the user triggered by message, and Interactive Sessions once they gain attention hooks (see 2d). Each source contributes an item with `{kind, id, title, mono (dir/branch/slug), attention, since, reason, link?}`.

**Lifecycle**

- **Start (push-to-start via APNs):** the first item enters `working`/`running` while no Watch is active. Also started locally by "Follow" on a task or when the user spawns a terminal from the phone.
- **Update (push):** any item enters or leaves `needs_you`, a followed task changes state, or the count changes. Item-to-item churn while everything is `working` does _not_ push (budget discipline). Alerting update (`alert` payload) only on a transition _into_ needs-you when the queue was previously empty.
- **End:** nothing running and nothing waiting for 2 minutes; or the user kills/answers the last item; or 8h elapsed (ActivityKit hard cap; it may linger dismissed on the lock screen up to 12h total, so the final content must read as a summary, not a stale prompt).
- Ended state content: "Quiet. 3 answered, 1 PR merged." then dismissal after 15 minutes via `dismissalPolicy(.after(...))`.

**States** → `waiting` (queue non-empty) · `working` (queue empty, n running) · `offline` (host or API unreachable >90 s) · `done`.

**Dynamic Island content**

| Region            | `waiting`                                                                                                                      | `working`                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Compact leading   | Optio glyph, purple                                                                                                            | Optio glyph, secondary                                                                |
| Compact trailing  | `web-ui` in mono, purple · "+2" if more                                                                                        | "3 running" secondary                                                                 |
| Minimal           | Purple dot with count                                                                                                          | Grey glyph                                                                            |
| Expanded leading  | State glyph + attention word "Needs you"                                                                                       | "Working"                                                                             |
| Expanded center   | `optio/apps/web` (mono, truncating head) · one line of the last prompt/permission text from `preview` (plain text, 1 line max) | Title of the most recent item · elapsed time (`timerInterval`, the only live element) |
| Expanded trailing | "4m" waiting (relative timer)                                                                                                  | Count "3"                                                                             |
| Expanded bottom   | **Reply…** and **Later** buttons                                                                                               | none (no filler)                                                                      |

Never show the terminal preview verbatim if it contains ANSI residue; the server's `preview` is already stripped, take the last non-empty line only.

**Lock screen / StandBy:** same hierarchy as expanded, two lines plus the button row. StandBy inherits automatically; the only adjustments are larger mono sizes and dropping the preview line.

**Interactivity (App Intents on Button):** `Later` — an intent that acknowledges the item (client-side "seen" set, drops it to the back of the queue for 15 minutes; no server state). `Reply…` — `openAppWhenRun` to the item's composer (`optio://local/terminals/<id>?compose=1`, `optio://agents/<id>?compose=1`, `optio://tasks/<id>`). For followed tasks in `pr_opened`: **Open PR** (opens `prUrl` in Safari) and, when `needs_attention`, **Resume**. No blind "Continue"/"y" button: sending an Enter into a permission prompt you can't read is the opposite of tasteful.

**Locked vs unlocked:** the preview line is `privacySensitive()` — locked shows the mono path and "Needs you", the prompt text appears only after Face ID. Buttons work locked (they're App Intents), but `Reply…` opens the app and therefore prompts to unlock.

**Copy:** "Needs you · `apps/web` · 4m" / "Waiting on a permission" / "Claude stopped — reply to continue" / "3 running · quiet" / "Laptop unreachable since 10:42" / "Quiet. 3 answered, 1 PR merged."

### 2b. Repo Task (queued → running → PR opened → CI → merged)

**Verdict: earns a Live Activity only when explicitly followed; by default it is a notification + widget object.** Most tasks are dispatched and forgotten until the PR comes back — that's the product's promise. But "I'm waiting on _this_ PR to merge" is a bounded event with a clear end, which is exactly what ActivityKit is for. Task detail gets a single **Follow on Lock Screen** action. A followed task joins the Watch as an item; it does not create a separate activity.

Timeline copy within the Watch: "Queued · `fix/login-redirect`" → "Running · 12m" → "PR #581 open · CI running" → "CI passed · review pending" → "Merged" (ends the follow). `needs_attention` promotes it to the front of the queue with reason text ("Merge conflict — resume?"). `failed` alerts once and offers **Retry**.

### 2c. Persistent Agent turn / chat

No Live Activity of its own. A PA turn you triggered by message behaves like a text conversation: the reply arrives as a **notification with the message body**, grouped in a thread per agent, with a `Reply` text-input action that posts to `/api/persistent-agents/:id/messages` from the notification. While the turn runs it is an item in the Watch (`working`, "Vesper is thinking · 40s") only if the user sent the message from the phone in the last hour — scheduled/webhook turns never touch the island. Turn `failed` after `consecutive_failure_limit` → alert with **Resume** action.

### 2d. Interactive Session

Sessions have a terminal and chat but no attention state today, so there is nothing honest to show. Defer: once sessions get the daemon-style hook/bell/quiet detector, they become a Watch source with the same card as a local terminal. Until then: notification on session exit/error only.

### 2e. Home Screen widgets (two earn existence)

1. **Agents** — `systemSmall`, `systemMedium`, `systemLarge`, plus every lock-screen accessory family. One list: what needs you first (yellow), then what's working (purple), one row per item, every row a deep link. Small shows the count and the top row; medium three rows; large seven and the Repo Tasks in flight. Rows never carry a sentence: `[kind glyph] name ……… [symbol + one word] 4m`, where the word comes from a fixed vocabulary — `Allow?`, `Reply`, `Quiet`, `Bell`, `Review`, `Stuck`, `Conflict`, `Failed`, `PR`, `CI`, `Queued`, `Starting` — and the name is the leaf of the terminal title or path. A moon icon per needs-you row is **Later** (App Intent, no app launch). With several servers the row carries a coloured server dot instead of the list being sectioned. This replaced the earlier "Needs You" + "In Flight" pair, whose headers ("Nothing running · 3 need you") summarised without listing.
2. **Run** — `systemSmall`, configurable: pick a Job, Task blueprint, or Local blueprint. Single tap fires it via App Intent and flips to "Started · 2s ago" for one timeline entry. This is the phone-as-remote-control widget. Ships with a confirmation toggle in the widget config for anything with `spawn_mode=auto`.

Refresh: rely on push-triggered reloads (iOS 26 WidgetKit push) with a 15-minute timeline fallback; the ~40–70/day budget rules out polling. If push isn't wired yet, the widget shows its `asOf` time in the footer rather than lying.

### 2f. Lock Screen accessory widgets

- `accessoryCircular`: count of needs-you items inside a ring; blank ring when quiet.
- `accessoryRectangular`: "Needs you +2" / `[terminal] web · Allow?` / "4m" — the oldest item only. Taps into it.
- `accessoryInline`: "Optio · 2 need you" or "Optio · quiet". Also the Apple Watch complication shape.

All monochrome by design; hierarchy comes from weight and the mono face.

### 2g. Control Center controls (iOS 18)

Two, no more:

- **Jump to what needs me** — button; opens the app at the oldest needs-you item (`router.open(.local)` with the terminal id). Grey when quiet.
- **Run ⟨blueprint⟩** — configurable button that fires one Job/blueprint. Shows a checkmark for 3 s after firing.

A "quiet hours" toggle was considered and rejected: Focus modes already do this per app.

### 2h. App Intents / Shortcuts / Siri

Entities: `Terminal`, `Task`, `Agent`, `Blueprint`, `Job`. Actions: **Get Things That Need Me** (returns entities, so Shortcuts can chain), **Reply to Terminal** (text), **Send Message to Agent** (text), **Run Blueprint/Job**, **Retry Task**, **Follow Task**, **Kill Terminal** (requires confirmation). Phrases: "Hey Siri, what needs me in Optio", "Tell Vesper to ship the healthz PR", "Run the nightly digest in Optio", "Retry the login task". Every intent returns a one-sentence `IntentDialog` so it works headless on AirPods.

### 2i. Notifications (they are the other half of this system)

| Event                                                                  | Delivery                                                                      | Actions                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------- |
| Local terminal → `needs_you` (reasons `stop`, `notification`, `quiet`) | Alert; also updates the Watch; sound only when queue was empty                | Reply… (text input, posts to `/input`), Later |
| Terminal `exit` from automation (`spawnedBy != manual`)                | Alert, no sound                                                               | Open                                          |
| Task `needs_attention`, `failed`                                       | Alert                                                                         | Resume / Retry, Open                          |
| Task `pr_opened`                                                       | Alert if not followed (it's the deliverable); silent Watch update if followed | Open PR                                       |
| Task `completed` (merged)                                              | Silent unless followed                                                        | —                                             |
| PA turn reply to your message                                          | Alert with body, thread per agent                                             | Reply (text)                                  |
| PA scheduled turn done                                                 | Silent (widget refresh only)                                                  | —                                             |
| Host offline                                                           | Alert once, then silent                                                       | —                                             |
| All `working`/`idle` transitions, queue reorder                        | Silent (`content-available`)                                                  | —                                             |

Grouping: `threadIdentifier` = the object id, so a chatty terminal collapses into one stack. When the Watch is active and expanded, `needs_you` alerts still fire (the island can be missed) but use the shorter body. Server work implied: APNs provider alongside the existing web-push, and `local.needs_you` / `agent.turn_completed` added to `NotificationEventType`.

## 3. Visual language

- **Purple (#6d28d9) means "you."** It appears only when something needs you: the compact-trailing text, the minimal dot, the count. Working states are `.secondary`; idle is `.tertiary`; failure is system red, used sparingly. When the queue is empty, no purple anywhere — the absence is the signal.
- **Glyph:** a single custom SF Symbol (a terminal caret inside a rounded square) with `.hierarchical` rendering. No wordmark on the island.
- **Type:** SF Pro for labels, SF Mono (`.monospaced()` design, `.semibold` for the path) for dir basenames, branches, `#581`, agent slugs. Truncate paths head-first (`.truncationMode(.head)`) so the leaf survives.
- **Motion:** only `contentTransition(.numericText())` on counts and the system relative timer. Never a pulse, never a spinner. The state change itself is the animation.
- **Dark / light / tinted:** the island is always dark, so purple sits on black at ~8:1 contrast. On the light lock-screen wallpaper the activity's background is system-material, and purple text stays readable. For iOS 18 **tinted** home screens mark the count and glyph `widgetAccentable()` and let the wallpaper tint replace purple; hierarchy must survive in grey, so test every widget with `.accented` and `.vibrant` rendering modes first, then colour.
- **Density:** one mono line, one prose line, one number. If a layout needs a third row it is a widget, not an island.

## 4. Roadmap

**Tier 1 — ship first**

- Watch Live Activity (local terminals as the only source) + APNs push-to-start/update. _Rationale: this is the wish, verbatim, and the one surface that changes behaviour._
- `needs_you` notification with Reply/Later actions. _Same server plumbing; works on phones without the island._
- Agents widget (small/medium/large) + rectangular/inline accessories. _Pure read of the same data; near-zero regret._

**Tier 2**

- Follow Task → joins the Watch; task actions (Resume/Retry/Open PR). _Second most common wait; bounded, so it fits ActivityKit._
- PA reply notifications with inline text reply; Send Message to Agent intent. _Makes agents feel like contacts._
- Controls: Jump to what needs me. _One intent, ten minutes of work once entities exist._

**Tier 3**

- Run widget + Run control + full Shortcuts entity graph. _Useful, but "start work" is the opposite of the core job._
- Interactive Sessions as a Watch source. _Blocked on session attention detection._

## 5. Open questions

1. APNs needs an Apple team key on the server. For a self-hosted OSS deployment, do we ship a per-install key configuration (`APNS_KEY_ID/TEAM_ID/.p8` secret) or run a small hosted relay?
2. Should `Later` be purely client-side, or do we want a server-side "snoozed until" on `local_terminals` so the web cockpit's queue agrees with the phone?
3. Is one Watch per user correct across workspaces, or does switching workspace in the app also switch the island?
4. Do you want the terminal's last prompt line on the lock screen at all (hidden behind Face ID), or is the mono path plus "Needs you" enough?
5. Which blueprint(s) would you actually pin to a Control — is a "Run" surface worth Tier 3, or should it be dropped?
