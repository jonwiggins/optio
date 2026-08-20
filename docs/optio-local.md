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
  host is offline, flushed on reconnect).

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
   (deliberately _not_ `needs_you` — a quiet test watcher isn't asking for you).

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
- `POST /api/local/terminals` — `{hostId, dir, title?, spec}` where `spec` is
  `{kind:"shell"} | {kind:"command", command} | {kind:"agent", agent, prompt?}`; optional
  `ticket: {source, externalId, url?, title, body?, repoId?, issueNumber?}` (when
  `repoId`+`issueNumber` given, issue comments are fetched and appended to the prompt and
  a "working on this" comment is posted). Dir must be inside the host allowlist.
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
  attention, ticket link, Kill / Start / Delete).
- Issues page (`/issues`) gains **"Work on locally"** next to "Assign to Optio" when an
  online host advertises a dir whose `repoUrl` matches the issue's repo.
- Sidebar: **Local** under the "Live" group.

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
