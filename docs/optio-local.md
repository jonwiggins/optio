# Optio Local

Optio Local manages **terminal sessions running on your own machine** from the Optio web UI.
A small daemon (`optio local up`, part of the Optio CLI) runs on your workstation, makes a
single **outbound** WebSocket connection to the API, and exposes an allowlisted set of
directories. From the browser you can spawn terminals in those directories (bare shells,
raw commands, or agent CLIs like `claude`), switch between many of them, and see at a
glance which ones **need you**. Tickets, webhooks, and schedules can spawn terminals
automatically via **Local Blueprints** wired into the existing polymorphic trigger system.

Contrast with the cluster plane: cluster Tasks are unattended (dispatch → PR comes back);
Local terminals are attended (you converse with the agent in your own checkout). Local
runs use your locally-installed CLIs and their local auth — the server never ships
secrets to your machine.

## Concepts

- **Host** (`local_hosts`) — one paired machine, bound to the registering **user** (hosts
  are personal, never workspace-shared compute). Carries an allowlist of directories, each
  with an auto-detected git remote. Online/offline tracked via daemon heartbeat.
- **Terminal** (`local_terminals`) — one PTY on a host: state machine
  `pending → launching → running → exited | error`, plus an **attention state**
  (`working` / `needs_you` / `idle`) that drives the UI's "needs you" queue.
- **Blueprint** (`local_blueprints`) — a reusable terminal spec (dir + command template
  rendered with `{{param}}` substitution). Triggers (`workflow_triggers` with
  `target_type = "local_blueprint"`) spawn terminals from blueprints on webhook, schedule,
  or ticket events. `spawn_mode = "hold"` creates the terminal `pending` for one-click
  human start; `"auto"` spawns immediately (or queues as `pending`/`host_offline` when the
  host is offline, flushed on reconnect). When `agent` is set (`claude-code` / `codex` /
  `cursor` / `gemini` / `opencode`), the rendered template is the agent's prompt and the
  spawn runs through the daemon's agent path — so automation-spawned agents get the same
  attention hooks as hand-started ones and enter the "needs you" queue while alive, not
  only on exit. When `agent` is null it's a plain shell command.

## Attention detection (daemon-side)

Layered, best signal wins per terminal:

1. **Claude Code hooks** (exact). For `agent: "claude-code"` spawns the daemon injects a
   settings file (`--settings`) whose `Stop` / `Notification` / `UserPromptSubmit` hooks
   POST to the daemon's localhost hook server (`http://127.0.0.1:$OPTIO_LOCAL_DAEMON_PORT/hook/$OPTIO_LOCAL_TERMINAL_ID`).
   `Stop` → `needs_you` (reason `stop`), `Notification` → `needs_you` (reason
   `notification`), `UserPromptSubmit` → `working`. Once a hook fires, heuristics are
   disabled for that terminal.
2. **Terminal bell** (generic). A BEL (0x07) in PTY output that is **not** an OSC/DCS/APC
   string terminator → `needs_you` (reason `bell`). The scanner is a small cross-chunk
   state machine (ESC `]`/`P`/`_`/`^` opens a string; BEL or ESC `\` closes it).
3. **Silence** (fallback). Output → `working`; ≥12 s of quiet after prior output → `idle`
   for shells and commands (deliberately _not_ `needs_you` — a quiet test watcher isn't
   asking for you). For **agent** spawns quiet means the opposite — an interactive agent
   CLI is either streaming or waiting on the human (Claude Code's trust/login prompts fire
   before any hook does; non-hooked agents sit at their input line) → `needs_you`
   (reason `quiet`). Layer 1 disables this once a hook has fired.

Exit: `spawnedBy != "manual"` → `needs_you` (reason `exit`) so automation results land in
the queue for review; manual shells exit to `idle`.

## Architecture

```
Browser ── /ws/local/terminals/:id/stream ──┐
Browser ── REST /api/local/* ───────────────┤
                                            ├── API (relay, DB)  ⇐ outbound WS ⇐  Daemon (optio local up)
Webhook/Schedule/Ticket triggers ───────────┘        /ws/local/daemon               node-pty PTYs in
                                                                                    allowlisted dirs
```

- The relay (`apps/api/src/services/local-relay.ts`) holds daemon sockets in-process
  (single API replica assumption, same as pod exec sessions) and routes frames by
  `terminalId`. Browsers never connect to the daemon; the daemon never accepts inbound
  connections (its hook server binds 127.0.0.1 only).
- Scrollback lives in the daemon (512 KB ring per terminal). The DB stores only metadata
  plus a throttled ANSI-stripped `preview` (last ~12 lines) for the wall view.
- Live UI updates: content-free nudges `{type:"local:changed", terminalId, hostId, userId}`
  on the shared `/ws/events` stream (that stream is visible to all authenticated users, so
  no terminal content may ever be published there); clients refetch via REST.
- Daemon auth: the CLI's existing PAT via `Sec-WebSocket-Protocol` (`optio-auth-<pat>`),
  same as every other WS. The hello's `hostId` must belong to the authenticated user.

## REST API (all under `/api/local`, member role for mutations, owner-scoped)

- `POST /api/local/hosts/register` — daemon upsert by `(userId, hostname)`; body
  `{name?, hostname, platform, arch, daemonVersion, dirs: [{path, repoUrl?}]}` → `{host}`
- `GET /api/local/hosts` / `DELETE /api/local/hosts/:id`
- `GET /api/local/terminals?state=&hostId=` — caller's terminals (with `preview`)
- `POST /api/local/terminals` — `{hostId, dir?, title?, spec?}` where `spec` is
  `{kind:"shell"} | {kind:"command", command} | {kind:"agent", agent, prompt?}` (defaults to
  `{kind:"shell"}`); optional `ticket: {repoId, issueNumber, title, body?, agentType?}` — when
  present, the repo's matching allowlisted dir is resolved (so `dir` may be omitted), the
  issue's comments are fetched and appended to the seeded agent prompt, the terminal is
  linked to the issue, and a "working on this" comment is posted. Dir must be inside the
  host allowlist.
- `GET /api/local/terminals/:id`
- `POST /api/local/terminals/:id/start` — spawn a `pending` terminal
- `POST /api/local/terminals/:id/kill` — `{signal?}` (default SIGTERM)
- `POST /api/local/terminals/:id/input` — `{data}` (fallback for non-WS input; primary
  input path is the stream WS)
- `DELETE /api/local/terminals/:id` — delete a non-running record
- `GET|POST /api/local/blueprints`, `GET|PATCH|DELETE /api/local/blueprints/:id`
- `POST /api/local/blueprints/:id/spawn` — `{params?}` manual run
- `GET|POST /api/local/blueprints/:id/triggers`,
  `PATCH|DELETE /api/local/blueprints/:id/triggers/:triggerId` — standard trigger CRUD
  (`manual` | `schedule` | `webhook` | `ticket`), rows in `workflow_triggers` with
  `target_type = "local_blueprint"`. Webhook ingress reuses `POST /api/hooks/:webhookPath`.

**Command safety**: webhook/trigger payloads never carry commands. Params substitute into
the blueprint's user-authored `commandTemplate` via `renderTemplateString`, and every
substituted value is shell-single-quoted before insertion. Agent prompts are passed as a
single quoted argv element, never interpolated into shell syntax.

## Daemon WebSocket protocol (`/ws/local/daemon`, JSON text frames)

Daemon → server:

- `{type:"hello", hostId, daemonVersion, dirs, terminals:[{terminalId, running}]}` —
  first frame; server reconciles DB rows against `terminals` (rows believed running that
  the daemon doesn't have → `exited`, reason `daemon_restart`) and flushes
  `pending/host_offline` spawns.
- `{type:"started", terminalId}` / `{type:"spawn-error", terminalId, message}`
- `{type:"output", terminalId, dataB64}` — only while the server holds a subscription
- `{type:"scrollback", terminalId, attachId, dataB64}` — snapshot addressed to one
  viewer's attach; `{type:"attach-error", terminalId, attachId, message}` when unknown
- `{type:"attention", terminalId, state, reason}`
- `{type:"preview", terminalId, preview, lastActivityAt}` — throttled (≥2 s)
- `{type:"links", terminalId, links:[{url, kind:"pr"|"issue"|"ref", provider, label}]}` — PR /
  ticket links found anywhere in the scrollback ring (`extractWorkLinks` in
  `@optio/shared`: GitHub PRs/issues, GitLab MRs/issues, Linear, Jira; hard-wrapped URLs
  are healed; URLs inside OSC 8 hyperlinks are harvested before ANSI stripping since
  Claude Code / gh print `#581` with the URL only in the escape; bare `#N` mentions
  resolve to the dir's GitHub/GitLab remote as kind `ref`). Rides the preview throttle, sent only when the set changes; the server
  sanitizes (https only, known kinds/providers, ≤50) and stores it in
  `local_terminals.links`
- `{type:"exit", terminalId, exitCode}`
- `{type:"ping"}` every 30 s (server updates `lastSeenAt`, replies `{type:"pong"}`)

Server → daemon:

- `{type:"spawn", terminalId, dir, cols, rows, spec}` (spec as in REST)
- `{type:"input", terminalId, dataB64}` / `{type:"resize", terminalId, cols, rows}`
- `{type:"kill", terminalId, signal}`
- `{type:"attach", terminalId, attachId}` / `{type:"detach", terminalId}` — daemon
  snapshots the ring buffer and enables live output atomically on attach; the snapshot
  is routed only to the attaching viewer (no gap, no duplicated history for others)
- `{type:"pong"}`

Host liveness: sweeper marks hosts offline after 90 s without a ping and fails
`launching` terminals older than 30 s ("spawn timeout, host unreachable").

## Browser stream WebSocket (`/ws/local/terminals/:id/stream`)

Auth: standard WS auth + `requireWsRole(member)` + terminal ownership. Server → client:
**binary frames are raw terminal bytes** (scrollback replay first, then live); JSON text
frames are control: `{type:"status", state, attentionState}` | `{type:"exit", exitCode}` |
`{type:"error", message}`. Client → server (JSON only — no raw-keystroke frames, which
eliminates the classic "pasted JSON swallowed as control" bug):
`{type:"input", data}` | `{type:"resize", cols, rows}`.

## Web UI

- `/local` — the cockpit: hosts status bar, "Needs you" queue strip (sorted by wait time),
  filterable grid of terminal cards (preview, attention-colored border, dir, source badge),
  New Terminal dialog, Blueprints section, empty-state onboarding (`optio login` →
  `optio local up`).
- `/local/[id]` — focus view: full xterm.js terminal + header (title, host, dir, state,
  attention, PR / ticket badges, Kill / Start / Delete). Inside a terminal the app sidebar
  is replaced by the **session rail** (`components/local/terminal-rail.tsx`): every
  terminal grouped as Needs you (oldest wait first) / Working / Idle / Finished, searchable
  by title, dir, host, or PR / ticket, with badges per row. Keyboard, captured before
  xterm: `Ctrl/⌘+Shift+↑/↓` previous / next session, `Ctrl/⌘+Shift+↵` jump to the oldest
  "needs you" session, `Ctrl/⌘+Shift+B` hide / show the rail (also the ⊟ button in the
  rail header and the ⊞ button in the terminal header; persisted in `localStorage`,
  wide screens only — `components/local/rail-store.ts`). Inside the terminal,
  `Shift+↵` sends `ESC CR` (what `claude /terminal-setup` installs) so Claude Code inserts
  a newline instead of submitting; `components/local/conn-state.ts`.
- **Attention from another tab** (`components/local/attention-watcher.tsx`, mounted on
  every `/local*` route): the favicon gets a status dot — yellow = a session needs you,
  green = agents working, grey = quiet — and the tab title a `(N)` needs-you count. The
  same yellow / green / grey scheme is used for the attention dots in the rail, rows, and
  cards. The **bell** in a session's header arms a browser Notification for that session
  (per browser, `localStorage`, `components/local/bell-store.ts`): it fires the moment the
  session flips to needs-you unless you're already looking at it, and clicking it focuses
  the tab on that session. Uses the page-scoped Notification API, so the tab must be open
  (server Web Push for Local sessions is not wired up yet). All Local pages share one
  terminals/hosts feed (`components/local/local-feed.ts`).
- **Usage in the header** (`components/local/usage-chips.tsx`): the gauge pill shows the
  Claude subscription's 5-hour / 7-day limit utilization (account-wide, from
  `GET /api/auth/usage`, polled every minute; the server caches the upstream call for
  5 min), turning yellow at 80% and red at 95%. The coin chip is _this session's_ tokens
  and estimated spend: the daemon reads the `transcript_path` from Claude Code's hooks
  and folds the transcript's assistant turns incrementally (`cli/src/local/usage-tracker.ts`,
  deduped by message id since Claude Code writes one line per content block), prices them
  with the public list prices in `packages/shared/src/utils/agent-usage.ts`, and sends a
  `usage` frame; stored on `local_terminals.usage`. Works for agent spawns _and_ for a
  `claude` you start by hand in an Optio shell: the daemon prepends a `claude` shim
  (`<config>/bin/claude`, written by `writeClaudeShim`) to every spawn's PATH that adds
  `--settings <hook file>` unless you passed your own. A login rc that _resets_ PATH
  (rather than prepending) drops the shim, and that terminal falls back to the silence
  heuristic.
- **One status dot per header** (`StatusDot`, `statusDescriptor` in `terminal-card.tsx`):
  lifecycle + attention folded into a single color — yellow pulse needs you, green working,
  grey idle, amber launching/pending, red error, dim grey exited — with the description on
  hover. Inside `/local/:id` the favicon shows _that_ session's dot; on `/local` it shows the
  fleet's (yellow beats green beats grey). The `(N)` title badge is always the fleet's
  needs-you count.
- **Rename in place**: the title in the terminal header is a text box (Enter / blur saves,
  Escape reverts); `PATCH /api/local/terminals/:id { title }`.
- **Split view** — up to three terminals at once: `/local/<primary>?split=<id2>,<id3>`
  (`&layout=rows` stacks them; phones always stack). Open a pane from the rail row's ⧉
  button or Shift+click; each extra pane has a one-line strip with kill / make-primary /
  close. Switching primaries keeps the open panes. State helpers in
  `components/local/split-state.ts`, per-pane UI in `components/local/terminal-pane.tsx`.
- **Work-link badges** (`components/local/work-links.tsx`) — the daemon-scanned PR / ticket
  links (plus the spawning ticket) render as badges on cockpit cards, the focus header,
  and rail rows; each opens in a new tab. The cockpit and rail searches match badge labels
  and URLs, so a session is findable by the PR or ticket it's working on.
- Issues page (`/issues`) gains **"Work on locally"** next to "Assign to Optio" when an
  online host advertises a dir whose `repoUrl` matches the issue's repo.
- Sidebar: **Local** under the "Live" group.
- **Overview (`/`)**: the dashboard opens with a cross-concept **Needs you** strip (local
  terminals waiting on you + repo tasks in `needs_attention`, oldest wait first —
  `components/dashboard/needs-you.tsx`), then one stats strip per concept. **Local** gets
  the same strip as the others (needs you / working / idle / finished / hosts online,
  `variant="local"`) plus cards for live terminals and anything finished in the last 24 h.
  A concept with nothing live folds into the single **Quiet** line (`quiet-sections.tsx`)
  so the page is only as tall as what's happening; roll-up rules live in
  `components/dashboard/local-stats.ts`. A paired host with an open terminal counts as
  "started" — the welcome hero no longer shows just because there are zero repo tasks.

## CLI

- `optio local up` — register host (name defaults to `os.hostname()`), connect, serve.
- `optio local add <dir>` / `optio local remove <dir>` / `optio local dirs`
- `optio local status` — host + terminal summary.
- Dir list persists in `~/.optio/local.json`; git remote auto-detected per dir.

## Non-goals / follow-ups (v1)

- **Cost tracking** for local terminals (needs transcript-sidecar parsing; column exists).
- **GitHub notifications poller** (review-requested → blueprint spawn) — requires the
  GitHub OAuth `notifications` scope / App permission, which the login flow doesn't
  request yet.
- Web push for `needs_you` transitions (in-app only for now).
- Multi-replica API relay (daemon sockets are in-process, matching exec-based sessions).
- Terminal survival across daemon restarts (PTYs are daemon children; `claude --continue`
  in the same dir is the recovery path).
