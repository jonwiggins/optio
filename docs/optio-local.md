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
  (`working` / `needs_you` / `idle`) that drives the UI's "needs you" queue. A terminal
  may execute a Job run or a Repo Task whose run location is this host
  (`spawned_by = "job" | "task"`, see "Local runs" below).
- **Automation** (`local_blueprints`; "blueprint" in the API and code) — "when X happens,
  run this agent on my machine". Who (`agent`: `claude-code` / `codex` / `cursor` /
  `gemini` / `opencode`, or null for a plain shell command), What (`commandTemplate`,
  rendered with `{{param}}` substitution — the agent's prompt, or the shell command; or
  `promptTemplateId`, a saved prompt from the Prompts library that replaces it, so one
  reviewed "review this PR" prompt can back many automations), Where
  (`hostId` / `dir` / `repoUrl`, all optional — see dir resolution below), When (triggers)
  and Then (`sessionMode`). Triggers are rows in `workflow_triggers` with
  `target_type = "local_blueprint"`: the generic `manual` / `schedule` / `webhook` / `ticket`
  ones shared with Jobs and Task Configs, plus the **event triggers** `github` / `slack` /
  `linear` fed by the signed ingress endpoints (see "Automations" below).
  `spawn_mode = "hold"` creates the terminal `pending` for one-click human start; `"auto"`
  spawns immediately (or parks as `pending`/`host_offline` when the host is offline, flushed
  on reconnect). Agent spawns get the same attention hooks as hand-started ones and enter
  the "needs you" queue while alive, not only on exit.
- **Session mode** (`sessionMode`, agent automations only):
  - `interactive` (default) — the agent runs at its normal prompt. When its turn ends it
    halts and waits (`needs_you`, reason `stop`); you open the session and keep chatting.
  - `headless` — the agent's one-shot entry point (`claude -p`, `codex exec`,
    `cursor-agent -p`, `gemini -p`, `opencode run`): it prints its result and the process
    exits. A clean exit lands in the queue as `needs_you` / `done` for review. Claude Code
    still fires hooks in `-p` mode, so the daemon captures the agent's own `session_id`
    (`local_terminals.agent_session_id`) and the run can be **resumed** later.
- **Resume** — `POST /api/local/terminals/:id/resume` (the "Resume chat" button on an
  exited agent session) opens a fresh interactive terminal in the same dir with
  `claude --resume <id>` (or `codex resume <id>`), inheriting the ticket / automation
  badges; `spawnedBy = "resume"`, so exiting it later goes quiet like a manual shell.

## Local runs: Tasks and Jobs on your machine

Run location is a first-class attribute of every **Task**, **Job**, and scheduled Task
blueprint (`run_target` on `tasks`, `workflows`, `task_configs`): `cluster` (an Optio pod,
the default) or `local` — a directory on one of your paired hosts. The "Where" section of
the New Task form, the Job editor, and the scheduled-Task editor all use the same picker
(`components/run-location-picker.tsx`): choose **Optio pod** or **My machine** first — a
pod Task then picks a registered repo, while on a machine you pick the host and a
directory (for a Task only git checkouts are offered, and the checkout's detected remote
becomes the task's repo — there is no separate repo choice) — and **Then** — `headless`
(default: `claude -p` etc., the run
finishes when the agent exits) or `interactive` (the agent stays at its prompt; the run
keeps going until you close the session).

A local run is an ordinary run row plus a `local_terminals` row that executes it
(`spawned_by = "job" | "task"`, back-links `workflow_run_id` / `task_id`; the run points
back via `local_terminal_id`). The pipeline, in `services/local-run-service.ts`:

1. The run is created and queued exactly as before (REST, trigger, schedule, webhook,
   retry). The workflow / task worker picks it up and, seeing `run_target = "local"`,
   calls `dispatchLocalWorkflowRun` / `dispatchLocalTask` instead of provisioning a pod.
   No cluster concurrency or off-peak gating applies; the reconciler skips capacity,
   stall, and pod-death checks for local runs (`spec.runTarget`).
2. Dispatch re-checks the location (host still paired, dir still allowlisted, agent one the
   daemon can launch — Claude Code / Codex / Cursor / Gemini / OpenCode), claims a terminal
   id on the run under CAS (so a worker + reconciler race can't spawn twice), and
   `createTerminal`s an `{kind: "agent"}` spec: the rendered prompt, the session mode, and
   the Job's `model` (`--model` / `-m`). A Task's prompt is wrapped with "work on
   `optio/task-<id>` off `<base>`, push, open a PR, print its URL"; a resume (CI failure /
   review feedback) carries the resume prompt and, for Claude Code, `-p --resume <session>`.
   Host offline → the terminal parks and the run stays `queued` until the daemon's next
   hello flushes it.
3. Daemon frames drive the run (`syncLinkedRun`, called from every terminal update):
   `launching`/`running` → Job `running` (Task `provisioning` → `running`); `usage` → live
   cost / tokens / model on the run; `session` → `tasks.session_id` (resume handle); a
   `links` frame with a PR of the task's repo → Task `pr_opened` (the PR watcher and
   auto-review / auto-merge take over from there); `exit 0` → Job `completed` (Task
   `completed`, or `pr_opened` when a PR exists — even on a non-zero exit); `exit ≠ 0` /
   `spawn-error` → `failed`. The last preview lines, session id, and links are stored in
   the Job run's `output`.
4. Cancel / server-side failure (cancel button, reconciler intent, dependency cascade,
   force redo) kills the terminal; the daemon's trailing `exit` then changes nothing.

Local runs use the machine's own agent CLI and login — no server secrets ship to laptops —
and follow the same attention rules as automations: a finished run lands in **Needs you**
(`done` / `exit`). The Job run page and the Task page embed the session
(`components/local/embedded-session.tsx`) in place of the pod log viewer; the Local cockpit
shows the same terminal with a `job` / `task` badge and an "Open run" / "Open task" link.
The REST bodies: `runTarget`, `localHostId`, `localDir`, `localSessionMode` on
`POST /api/tasks` (all kinds), `POST/PATCH /api/jobs`, and `POST/PATCH /api/task-configs`
(validated by `validateRunLocation`: the host must be the caller's own).

## Automations: event triggers

Three ingress endpoints turn things that happen to _you_ into automation runs. They are
public, verified purely by the provider's HMAC, workspace-wide (one webhook per GitHub
org / Slack app / Linear workspace), and each trigger's `config` carries the identity it
listens for, so several people's automations can share one ingress.

| Source | Ingress                                                                                            | Secret                  | Trigger `config`                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| GitHub | `POST /api/webhooks/github` (the existing receiver, `X-Hub-Signature-256`)                         | `GITHUB_WEBHOOK_SECRET` | `{ events?: ("review_requested" \| "mentioned" \| "assigned" \| "pr_opened" \| "issue_opened")[], login?, repos?: ["owner/name"] }` |
| Slack  | `POST /api/webhooks/slack/events` (Events API; answers `url_verification`; `X-Slack-Signature` v0) | `SLACK_SIGNING_SECRET`  | `{ channelId, keyword?, mentionOnly?, includeThreads? }`                                                                            |
| Linear | `POST /api/webhooks/linear` (`Linear-Signature` over the raw body + `webhookTimestamp` ≤ 60 s)     | `LINEAR_WEBHOOK_SECRET` | `{ events?: ("assigned" \| "mentioned" \| "created" \| "labeled")[], user?, labels?, teams? }`                                      |

Matching lives in `services/local-event-service.ts` as pure functions
(`normalize*` → one event; `match*` → the matched kind or null); `fireLocalEventTriggers`
fans an event out to every enabled trigger of that type and spawns each match's automation
with the event's fields as prompt params. Personal kinds (`review_requested`, `mentioned`,
`assigned`) only match when the trigger's `login` / `user` is among the event's targets
(reviewer, assignee, `@`-mentions, case-insensitive; Linear matches user id, name, display
name, or the `@handle` in a mention link); `pr_opened` / `issue_opened` / `created` /
`labeled` need no identity. A comment you wrote that mentions yourself never fires.

Prompt params: GitHub `{{event}} {{kind}} {{repo}} {{repoUrl}} {{number}} {{title}} {{body}}
{{url}} {{author}} {{headBranch}} {{baseBranch}} {{commentBody}} {{commentUrl}} {{action}}`;
Slack `{{channelId}} {{userId}} {{text}} {{ts}} {{threadTs}} {{permalink}}`; Linear
`{{event}} {{identifier}} {{title}} {{description}} {{url}} {{labels}} {{teamKey}}
{{assignee}} {{priority}} {{state}} {{commentBody}} {{commentUrl}} {{actor}}` plus the
`ticket*` aliases used by ticket triggers. GitHub and Linear runs are linked to the PR /
issue (`ticket_*` columns) so the session shows the badge.

**Dir resolution** (`resolveBlueprintDir`): the automation's `dir` → the host dir whose git
remote matches its `repoUrl` → the dir matching the _event's_ repo (a GitHub PR's
repository) → the host's first allowlisted dir, but only when the spawn names no repo at
all (Slack, manual). A repo the host doesn't have — pinned or from the event — is an error,
not a fallback: "review acme/api#12" must never run inside an unrelated checkout. So
"Where: the event's repo" makes one PR-review automation cover every repo you have
checked out, and skips the ones you don't.

**Scoping and replay**: a GitHub event about a repo registered in Optio only reaches
automations in that repo's workspace (or workspace-less ones, i.e. auth-disabled dev),
whatever `login` they claim. Deliveries are
de-duplicated in-process by id (`X-GitHub-Delivery`, Slack `event_id`, Linear
type+action+entity+timestamp) so provider retries don't fire twice. An automation's
pinned `hostId` must be the caller's own host — checked on create/update and again at
spawn.

Slack notes: subscribe the app to `message.channels` (plain messages) and/or
`app_mention` (`mentionOnly` triggers listen to the latter only, so an @-mention never
fires twice), invite the app to the channel, and use the channel _id_ (`C0…`) from the
channel details. Bot messages, edits, and other subtypes are dropped; thread replies only
match with `includeThreads`; `event_id`s are remembered so Slack's retries don't
double-fire. The endpoint acks before dispatching (Slack retries anything slower than 3 s).

### Recipes

- **"When I'm tagged on a PR, review it, then stop"**: automation with agent Claude Code,
  Where = the event's repo, Then = exit when done, prompt using `{{url}}` /
  `{{headBranch}}` / `{{baseBranch}}`; trigger `github` with `events:
["review_requested", "mentioned"]` and your `login`. The result lands in Needs you with
  reason `done`; "Resume chat" picks the session back up if you want to discuss it.
- **"When a message lands in #channel, do it and wait for me"**: agent automation with
  Then = keep the session open and a prompt around `{{text}}` / `{{permalink}}`; trigger
  `slack` with the `channelId` (optionally a `keyword`).
- **"When a Linear ticket is assigned to me, triage it and open a PR"**: agent automation
  pinned to the repo's dir (or `repoUrl`), Then = exit when done, prompt around
  `{{identifier}}` / `{{title}}` / `{{description}}` / `{{url}}`; trigger `linear` with
  `events: ["assigned"]` and your `user`.

The Automations section on `/local` ships these three as one-click presets.

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
3. **Silence** (fallback). Output → `working`; ≥12 s of quiet after prior output means
   the terminal is waiting on you → `needs_you`. For **agent** spawns always (reason
   `quiet` — Claude Code's trust/login prompts fire before any hook does; non-hooked
   agents sit at their input line). For shells and commands once you have typed in them
   (reason `finished` — your command is done); a shell nobody has typed in that just went
   quiet at its prompt is `idle`, not a request. Layer 1 disables this once a hook has
   fired.

`needs_you` is sticky against output and silence; it clears when you respond
(`UserPromptSubmit` hook or any keystroke) and **decays to `idle` after 2 hours** with no
response (reason `stale`, `STALE_MS`) — a session you walked away from stops shouting.
The decay applies to hook-owned terminals too.

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
  plus a throttled ANSI-stripped `preview` (last ~12 lines) for the wall view — and, once
  a terminal exits, its **final screen**: the daemon sends the ring's tail (≤384 KB, raw
  bytes) plus the PTY grid right before `exit`, stored in `local_terminal_snapshots`
  (own table, so terminal rows and list responses stay lean; cascades on delete). Opening
  an exited terminal replays it into the xterm at the recorded grid, so a finished session
  reads the way it ran instead of as a text preview; the preview is the fallback for rows
  recorded before snapshots existed.
- **The conversation** (`local_terminal_transcripts`). A screen is not a record of an agent
  session: Claude Code draws a full-screen TUI, so the bytes that survive its exit are one
  redraw of the last screen — the last message, not the exchange. For Claude Code spawns
  the daemon also distills the agent's own transcript (the JSONL at the hooks'
  `transcript_path`, the same file the usage chip is summed from,
  `cli/src/local/transcript-tracker.ts`) into plain entries — every prompt, reply, tool
  call (name + one-line summary + full input, bounded) with its result (bounded), and
  thinking — and streams them as `transcript` frames: on every hook, every 3 s while the
  session runs, and once more right before `exit`. Rows are keyed by the daemon's
  per-terminal `seq`, so a re-sent batch is a no-op; sidechain (subagent) lines and Claude
  Code's bookkeeping lines (slash-command echoes, meta) are skipped. `GET
/api/local/terminals/:id/transcript` serves it; the session page opens a finished agent
  session on this **Transcript** view (the **Screen** toggle brings the recorded grid
  back), which reflows to any width — a session run on a 132×40 grid reads on a phone.
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
- `GET /api/local/terminals/:id/transcript?after=&limit=` — the agent session's
  conversation as `{entries, complete}` (see "The conversation" above); `after` is a seq,
  for live polling
- `POST /api/local/terminals/:id/start` — spawn a `pending` terminal
- `POST /api/local/terminals/:id/resume` — new interactive terminal resuming the agent's
  own session (`agentSessionId`); 409 when the session never reported one
- `POST /api/local/terminals/:id/kill` — `{signal?}` (default SIGTERM)
- `POST /api/local/terminals/:id/input` — `{data}` (fallback for non-WS input; primary
  input path is the stream WS)
- `DELETE /api/local/terminals/:id` — delete a non-running record
- `GET|POST /api/local/blueprints`, `GET|PATCH|DELETE /api/local/blueprints/:id` —
  automations (`agent`, `commandTemplate`, `hostId?`, `dir?`, `repoUrl?`, `spawnMode`,
  `sessionMode`)
- `POST /api/local/blueprints/:id/spawn` — `{params?}` manual run
- `GET|POST /api/local/blueprints/:id/triggers`,
  `PATCH|DELETE /api/local/blueprints/:id/triggers/:triggerId` — trigger CRUD
  (`manual` | `schedule` | `webhook` | `ticket` | `github` | `slack` | `linear`), rows in
  `workflow_triggers` with `target_type = "local_blueprint"`. Generic webhook ingress
  reuses `POST /api/hooks/:webhookPath`; event ingress is described under "Automations".
- `POST /api/webhooks/slack/events`, `POST /api/webhooks/linear` — signed event ingress
  (`routes/local-ingress.ts`); GitHub events ride the existing `POST /api/webhooks/github`.

**Command safety**: webhook/trigger payloads never carry commands. Params substitute into
the blueprint's user-authored `commandTemplate` via `renderTemplateString`, and every
substituted value is shell-single-quoted before insertion (`{{#if}}` blocks are decided on
the raw values first, so an empty param drops its block). Agent prompts are passed as a
single quoted argv element, never interpolated into shell syntax; a prompt that starts with
`-` gets a leading space so an event payload can't smuggle in a CLI flag.

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
- `{type:"session", terminalId, agentSessionId}` — the agent CLI's own session id, once its
  hooks report it (sent once per terminal); stored on `local_terminals.agent_session_id`
  and what `POST /api/local/terminals/:id/resume` hands back to `claude --resume`
- `{type:"links", terminalId, links:[{url, kind:"pr"|"issue"|"ref", provider, label}]}` — PR /
  ticket links found anywhere in the scrollback ring (`extractWorkLinks` in
  `@optio/shared`: GitHub PRs/issues, GitLab MRs/issues, Linear, Jira; hard-wrapped URLs
  are healed; URLs inside OSC 8 hyperlinks are harvested before ANSI stripping since
  Claude Code / gh print `#581` with the URL only in the escape; bare `#N` mentions
  resolve to the dir's GitHub/GitLab remote as kind `ref`). Rides the preview throttle, sent only when the set changes; the server
  sanitizes (https only, known kinds/providers, ≤50) and stores it in
  `local_terminals.links`
- `{type:"transcript", terminalId, entries:[{seq, role, kind, text, detail, toolName,
toolUseId, isError, at}]}` — new conversation entries distilled from the agent's transcript
  (Claude Code), batched (40 per frame), in `seq` order; sent on hooks, every 3 s while the
  session runs, and flushed once more just before `exit`. Accepted only from the owning host
  while the row is live; the server bounds text (16 KB) / detail (8 KB) and caps a terminal
  at 20 000 entries
- `{type:"snapshot", terminalId, dataB64, cols, rows}` — the final screen (ring tail +
  grid), sent right before `exit`; its own frame so an oversize one the server drops
  (>1 MB) can never swallow the exit. Accepted only from the owning host while the row
  is still live.
- `{type:"exit", terminalId, exitCode}`
- `{type:"ping"}` every 30 s (server updates `lastSeenAt`, replies `{type:"pong"}`)

Server → daemon:

- `{type:"spawn", terminalId, dir, cols, rows, spec}` (spec as in REST; agent specs may
  carry `model`, passed to the CLI as `--model` / `-m`, and `mode: "headless"` combined with
  `resumeSessionId` runs `claude -p --resume` for Claude Code)
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
frames are control: `{type:"status", state, attentionState}` | `{type:"size", cols, rows}` |
`{type:"exit", exitCode}` | `{type:"error", message}`. An exited terminal is not attached:
the server sends `size` (the grid the final screen was recorded at), the screen bytes, then
`exit` — in that order, so the viewer lays the grid out before painting. The web pane pins
that grid ("Recorded screen 132×40" strip, no "use this screen"), so a click to select text or
a window resize can never reflow the replay. Client → server (JSON only — no raw-keystroke frames, which
eliminates the classic "pasted JSON swallowed as control" bug):
`{type:"input", data}` | `{type:"resize", cols, rows}`.

## Web UI

- `/local` — the cockpit: hosts status bar, "Needs you" queue strip (sorted by wait time),
  filterable grid of terminal cards (preview, attention-colored border, dir, source badge),
  New Terminal dialog, Blueprints section, empty-state onboarding (`optio login` →
  `optio local up`).
- `/local/[id]` — focus view: full xterm.js terminal + header (title, host, dir, state,
  attention, PR / ticket badges, Kill / Start / Delete). Agent sessions with a recorded
  conversation get a **Transcript / Screen** toggle (`components/local/session-view-toggle.tsx`,
  rule in `session-view.ts`): a session opened after it finished lands on the transcript
  (`components/local/transcript-view.tsx` — prompts, markdown replies, tool calls with
  results folded underneath, thinking collapsed, sticks to the bottom while live); a live
  session opens on its screen, and one you watched end stays on the screen. The Job run /
  Task pages' embedded session does the same. Inside a terminal the app sidebar
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
  `--settings <hook file>` unless you passed your own. For **zsh** the daemon also routes
  the shell's dotfiles through a `ZDOTDIR` wrapper (`<config>/zsh/`, `writeZshDotDir`)
  that sources your real `.zshenv`/`.zprofile`/`.zshrc`/`.zlogin` and then moves the shim
  back to the front of PATH — otherwise an rc file that prepends `~/.local/bin` or asdf
  shims buries the shim behind the real `claude` and that terminal silently loses hooks.
  A daemon started from _inside_ an Optio terminal inherits the outer daemon's shim and
  wrapper: the shim skips any other Optio shim on PATH (else the two exec each other
  forever) and the spawn keeps the recorded `OPTIO_USER_ZDOTDIR` rather than the
  inherited wrapper (else the wrapper sources itself until zsh's recursion limit).
  Bash keeps the plain prepend: an rc that _resets_ PATH drops the shim there, and the
  terminal falls back to the silence heuristic.
- **One status dot per header** (`StatusDot`, `statusDescriptor` in `terminal-card.tsx`):
  lifecycle + attention folded into a single color — purple working, yellow pulse needs
  you, green completed (exit 0), grey idle/pending/killed/error (`sessionTone` in
  `attention.ts`, shared by card, row, rail and favicon) — with the description on
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
  Three more overview panels: **Usage limits** (`limits-panel.tsx`) shows Claude's live
  5h / 7d account utilization next to **Codex**'s — the daemon reads Codex's newest
  `rate_limits` snapshot from `~/.codex/sessions/**/rollout-*.jsonl` (no token leaves the
  laptop; `cli/src/local/codex-limits.ts`), reports it in an `agent-limits` frame every few
  minutes, and it lands on `local_hosts.agent_limits`; the panel labels it "as of <when>"
  since it only moves when Codex runs, and zeroes a window whose reset has passed.
  **Live** (`live-panel.tsx`) is one grid of every open local terminal, interactive
  session, and awake persistent agent, each linking into its view. **Recent**
  (`recent-runs.tsx`) is a newest-first feed of repo tasks, job runs, and agent turns from
  `GET /api/runs/recent` (`routes/recent-runs.ts`, a workspace-scoped UNION).

## CLI

- `optio local up` — register host (name defaults to `os.hostname()`), connect, serve.
- `optio local add <dir>` / `optio local remove <dir>` / `optio local dirs`
- `optio local status` — host + terminal summary.
- Dir list persists in `~/.optio/local.json`; git remote auto-detected per dir.

## Non-goals / follow-ups (v1)

- **Cost tracking** for local terminals (needs transcript-sidecar parsing; column exists).
- **GitHub notifications poller** as an alternative to the webhook for review requests
  (for installs without a public URL) — needs the `notifications` OAuth scope, which the
  login flow doesn't request yet.
- Web push for `needs_you` transitions (in-app only for now).
- Multi-replica API relay (daemon sockets are in-process, matching exec-based sessions).
- Terminal survival across daemon restarts (PTYs are daemon children; `claude --continue`
  in the same dir is the recovery path).
