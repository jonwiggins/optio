# Optio Local

Optio Local manages **terminal sessions running on your own machine** from the Optio web UI.
A small daemon (`optio local up`, part of the Optio CLI) runs on your workstation, makes a
single **outbound** WebSocket connection to the API, and exposes an allowlisted set of
directories. From the browser you can spawn terminals in those directories (bare shells,
raw commands, or agent CLIs like `claude`), switch between many of them, and see at a
glance which ones **need you**. Tickets, webhooks, and schedules can spawn terminals
automatically via **Local Blueprints** wired into the existing polymorphic trigger system.

In the [session model](tasks.md), Optio Local is the **Where = your machine** answer.
Every kind of session that can run in a pod can run in a directory on a paired machine
instead — a one-shot PR session on a new branch, a scheduled or webhook job, an
interactive agent you chat with, or an automation woken by GitHub / Slack / Linear events
(those only run on a machine) — picked from the same New Session form and shown in the
same Sessions feed. Local runs use your locally-installed CLIs and their local auth — the
server never ships secrets to your machine.

## Concepts

- **Host** (`local_hosts`) — one paired machine, bound to the registering **user** (hosts
  are personal, never workspace-shared compute). Carries an allowlist of directories, each
  with an auto-detected git remote. Online/offline tracked via daemon heartbeat.
  **Directories** live in the machine's `local.json` and belong to its daemon: the CLI's
  `optio local add|remove` edit them there, and the Machines page / New work form edit
  them through the daemon (`POST|DELETE /api/local/hosts/:id/dirs` → a `dirs` frame; the
  daemon resolves `~` and symlinks, checks the directory exists, detects its remote,
  saves, and answers with the whole new list, which the row mirrors). From Optio a path must be absolute or under `~`,
  and `/` is refused. `optio local up --no-remote-dirs` keeps the list local-only (the hello
  then doesn't set `manageDirs`, and the server never asks). A shell in any allowlisted
  directory can already reach the rest of the account, so the list scopes where work runs
  rather than fencing the machine off from its owner.
  **Identity**: the daemon keeps the host id each server gave it (`local.json`, per server
  URL) and sends it back on every registration, so a machine keeps its row — terminals,
  automations, resumable sessions — when its hostname changes (macOS renames itself as it
  moves between networks); the row's hostname, and its name unless someone chose one,
  follow. Without an id (first pairing, or a daemon from before ids were sent) the row is
  matched by `(user, hostname)`. A computer that got a second row under an old daemon
  shows up twice, the old row offline for good: **Merge** on the Machines page
  (`POST /api/local/hosts/:id/merge`) moves the offline row's terminals, automations, and
  Task / Job run locations to the other machine and removes it; terminals that were
  waiting for it start there. A daemon that sends its id under a hostname an offline row
  of the same user still has folds that row in by itself.
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
  (`hostId` / `dir` / `repoUrl`, all optional — see dir resolution below; plus
  `baseBranch`: when set, an agent spawn's prompt is wrapped with "create a branch off
  this base, commit, push, open a PR" instructions — the "new branch that becomes a PR"
  choice in the New session form; the same wrapper applies to a hand-opened agent
  terminal whose spec carries `baseBranch`), When (triggers) and Then (`sessionMode`). Triggers are rows in `workflow_triggers` with
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
  It runs on the session's own host (the agent's transcript lives there); while that host
  is offline the new terminal waits as `pending` / `host_offline` and its page says so.
  Asking again while a resume of the same session hasn't ended (waiting, starting, or
  open) returns that one (`reused: true`) instead of a second copy of the conversation.

## Claude token refresh from your machine

The cluster's `CLAUDE_CODE_OAUTH_TOKEN` expires; the old fix was a Keychain one-liner and a
paste into Secrets. A paired machine already holds a fresh login, so the daemon can hand it
over (`services/local-auth-refresh-service.ts`, `cli/src/local/claude-credentials.ts`):

- The daemon's `hello` carries `claudeCredentials: true` when the machine has a Claude Code
  login (macOS Keychain item "Claude Code-credentials", else
  `$CLAUDE_CONFIG_DIR/.credentials.json`). Live only — `GET /api/local/hosts` reports it
  per host, false while offline.
- The server sends `{type:"credentials", requestId}`; the daemon answers
  `{type:"credentials-result", requestId, token, expiresAt}` with the **access token only**
  (the refresh token never leaves the machine), or an `error`. The server validates the
  token against Anthropic, stores it as the global `CLAUDE_CODE_OAUTH_TOKEN` (what the
  validation worker, usage probe, and agent pods read), invalidates the credential / usage
  caches, marks the validation cache good, and publishes `auth:status_changed`.
- Who may: a host owned by a workspace **admin** (the same gate as the Secrets page), or
  any host in auth-disabled dev.
- **Explicit**: `POST /api/auth/claude-token/refresh-from-host {hostId}` (admin, own host);
  the expired-token banner shows a "Refresh from _machine_" button for every online host
  that can, above the copy/paste steps.
- **Automatic**: when the token-validation worker finds the stored token expired it tries
  every capable online host first and only raises the `auth:failed` banner if none worked;
  and a capable daemon that connects while the stored token is known-bad refreshes it on
  hello. Each host is tried at most once per 10 minutes, so a machine whose own login is
  also stale ("run `claude` there to sign in again") isn't polled on every cycle.

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
   what the run's agent options set for a run on a machine (`localAgentParams` in
   `@optio/shared`): the model (`--model` / `-m`), the reasoning effort, and Claude Code's
   permission mode — see "Launching agents" below. A Task's prompt is wrapped with "work on
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

Matching lives in `services/event-trigger-service.ts` as pure functions
(`normalize*` → one event; `match*` → the matched kind or null); `fireEventTriggers`
fans an event out to every enabled trigger of that type — whatever it targets: a Local
automation, a Job or scheduled Task in a pod, a persistent agent — and starts each match
through the shared trigger dispatcher with the event's fields as prompt params. Personal kinds (`review_requested`, `mentioned`,
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

The Automations section on `/machines` ships these three as one-click presets.

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

Kill: `POST /api/local/terminals/:id/kill` marks the terminal `idle` with reason `killed`
before the daemon hears of it. Whatever the process does on its way out (a last `Stop`
hook, shutdown output, a non-zero exit) changes nothing, and it lands in **Finished**:
you ended it, so there's nothing to review. A run behind the terminal ends too
(`killedOutcome` in `local-run-service.ts`). An interactive run **completes**, because
closing its session is how it ends. A headless run killed mid-flight **stops** without a
retry: a Task is cancelled, and a Job run is marked "Stopped by user" with its retry
budget spent, like a cancel. A Task that already opened a PR follows its PR.

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
- Scrollback lives in the daemon (512 KB ring per terminal), alongside a **screen model**
  (`@xterm/headless`, 2000 lines of scrollback) fed the same bytes. Previews and links are
  read off the screen model, never off the flattened byte stream: TUIs paint cells, and
  Claude Code repaints only the cells that changed with absolute cursor moves, so
  stripping ANSI from the stream glues fragments of different repaints into text that was
  never on screen (`…/jonwi` + jump + `ns/optio/pull/607`, or `#6` + jump + `07`). The DB
  stores only metadata plus a throttled `preview` (last ~12 lines) for the wall view — and, once
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
  **Backfill**: a finished Claude Code session with a session id but no stored entries (it
  ran under a daemon that predates transcripts, or its hooks never named the file) is read
  off its machine on demand. The first transcript read asks the host's daemon
  (`transcript-request`, only to daemons whose hello set `transcriptBackfill`); the daemon
  finds `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<session id>.jsonl`, refuses a
  session whose working dir is outside its allowlist, and answers with the whole
  conversation as `transcript-backfill` frames addressed to the request id. Meanwhile the
  read returns `backfilling: true` and clients poll briefly; a host that had nothing isn't
  asked again for 10 minutes (`cli/src/local/transcript-backfill.ts`,
  `requestTranscriptBackfill` in `local-terminal-service.ts`).
- Live UI updates: content-free nudges `{type:"local:changed", terminalId, hostId, userId}`
  on the shared `/ws/events` stream (that stream is visible to all authenticated users, so
  no terminal content may ever be published there); clients refetch via REST.
- Daemon auth: the CLI's existing PAT via `Sec-WebSocket-Protocol` (`optio-auth-<pat>`),
  same as every other WS. The hello's `hostId` must belong to the authenticated user.
  Clients may send the moment the socket opens: every WS route holds frames that
  arrive while it is still authenticating and setting up, then handles them in order
  (`ws/ws-connection.ts`; a client that sends more than 256 frames or 4 MB before then
  is closed with 1008), so the daemon's `hello` can go out on `open`.

## REST API (all under `/api/local`, member role for mutations, owner-scoped)

- `POST /api/local/hosts/register` — daemon registration: the host it names in `hostId`
  (its id from last time), else upsert by `(userId, hostname)`; body
  `{hostId?, name?, hostname, platform, arch, daemonVersion, dirs: [{path, repoUrl?}]}` →
  `{host}` (see "Identity" under Host)
- `GET /api/local/hosts` / `DELETE /api/local/hosts/:id` — each host carries the live
  `claudeCredentials` and `manageDirs` of its connected daemon (false while offline)
- `POST /api/local/hosts/:id/dirs` `{path}` / `DELETE /api/local/hosts/:id/dirs?path=` —
  add / remove an allowlisted directory through the machine's daemon (see Host above) →
  `{host, path}` with `path` as the machine resolved it; 400 with the daemon's reason (no
  such directory, not in the list, a relative path), 409 while the machine is offline or its
  daemon didn't offer `manageDirs`, 504 when it doesn't answer within 10 s
- `POST /api/local/hosts/:id/merge` — `{intoHostId}`: one computer registered twice;
  moves this (offline) host's terminals, automations, and run locations to `intoHostId`,
  removes it, and starts terminals that were waiting for it → `{host, moved: {terminals,
automations, runLocations}}`; 409 while the host is connected
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
  conversation as `{entries, complete, backfilling}` (see "The conversation" above);
  `after` is a seq, for live polling; `backfilling` while the host reads a finished
  session's conversation off disk
- `POST /api/local/terminals/:id/start` — spawn a `pending` terminal
- `POST /api/local/terminals/:id/resume` — new interactive terminal resuming the agent's
  own session (`agentSessionId`) → 201 `{terminal, reused: false}`, or 200
  `{terminal, reused: true}` with a resume of that session that hasn't ended; 409 when the
  session never reported an id
- `POST /api/local/terminals/:id/kill` — `{signal?}` (default SIGTERM); the session
  finishes (see "Kill" under Attention detection)
- `POST /api/local/terminals/:id/input` — `{data}` (fallback for non-WS input; primary
  input path is the stream WS)
- `DELETE /api/local/terminals/:id` — delete a non-running record
- `GET|POST /api/local/blueprints`, `GET|PATCH|DELETE /api/local/blueprints/:id` —
  automations (`agent`, `commandTemplate`, `hostId?`, `dir?`, `repoUrl?`, `spawnMode`,
  `sessionMode`)
- `POST /api/local/blueprints/:id/spawn` — `{params?}` manual run
- `GET|POST /api/local/blueprints/:id/triggers`,
  `PATCH|DELETE /api/local/blueprints/:id/triggers/:triggerId` — trigger CRUD
  (`manual` | `schedule` | `webhook` | `ticket` | `github` | `slack` | `linear` — the same
  seven every target takes, see docs/tasks.md "Triggers"), rows in `workflow_triggers`
  with `target_type = "local_blueprint"`, served by the shared `services/trigger-service.ts`.
  Generic webhook ingress reuses `POST /api/hooks/:webhookPath`; event ingress is described
  under "Automations".
- `POST /api/webhooks/slack/events`, `POST /api/webhooks/linear` — signed event ingress
  (`routes/event-ingress.ts`); GitHub events ride the existing `POST /api/webhooks/github`.
  Events fan out to every matching trigger whatever it targets (`fireEventTriggers` in
  `services/event-trigger-service.ts`) — a Job or scheduled Task in a pod as well as a
  Local automation.

**Command safety**: webhook/trigger payloads never carry commands. Params substitute into
the blueprint's user-authored `commandTemplate` via `renderTemplateString`, and every
substituted value is shell-single-quoted before insertion (`{{#if}}` blocks are decided on
the raw values first, so an empty param drops its block). Agent prompts are passed as a
single quoted argv element, never interpolated into shell syntax; a prompt that starts with
`-` gets a leading space so an event payload can't smuggle in a CLI flag.

## Launching agents

`cli/src/local/agent-command.ts` builds each agent's command line; every value in it is a
single shell-quoted argv element.

- **Permissions (Claude Code).** Agents start with `--permission-mode auto` unless the
  spawn asks for another mode: Claude's classifier approves routine actions (edits and
  commands in the working directory) and blocks risky ones. Without a flag, a headless
  `claude -p` starts in Manual mode, where every action that needs approval is denied
  because nobody can answer the prompt, and a fresh install's first interactive session
  stops at each one. The spec's `permissionMode` picks `bypassPermissions` ("Skip all
  checks": `--dangerously-skip-permissions`) or `default` ("Ask first"); it is the
  `claudePermissionMode` catalog field, shown only for runs on a machine (pods always skip
  checks). Claude Code falls back to Manual on its own when auto mode isn't available to
  the account or model.
- **Effort.** The spec's `effort` becomes Claude Code's `--effort` and Codex's
  `-c model_reasoning_effort="…"`. The New work form offers it for runs on a machine as
  well as in pods.
- **What the CLI accepts.** The daemon reads `claude --help` at start and hourly
  (`cli/src/local/cli-probes.ts`). An older Claude Code without auto mode or `--effort`
  would refuse to start with them, so they're left out for it.
- **Codex's models.** On connect and every 6 hours the daemon runs `codex debug models`
  (Codex's own catalog, refreshed the way Codex refreshes it, else the list its release
  ships with; `~/.codex/models_cache.json` as a fallback) and sends the models Codex lists
  in its picker, each with its reasoning efforts and default, in an `agent-models` frame.
  The server keeps it on `local_hosts.agent_models`, and `GET /api/agents/openai/options`
  merges it ahead of the baseline (`mergeCodexModels`): `?hostId=` for a run on that
  machine, else the freshest list any of the caller's machines reported. The picker narrows
  the effort field to the chosen model's own efforts, and says "Models from Codex on
  <machine>". Codex runs in pods get the same model and effort (`-m`,
  `model_reasoning_effort`).

## Daemon WebSocket protocol (`/ws/local/daemon`, JSON text frames)

Daemon → server:

- `{type:"hello", hostId, daemonVersion, dirs, terminals:[{terminalId, running}],
claudeCredentials?, transcriptBackfill?, manageDirs?}` — first frame; server reconciles DB rows against `terminals` (rows believed running that
  the daemon doesn't have → `exited`, reason `daemon_restart`) and flushes
  `pending/host_offline` spawns.
- `{type:"started", terminalId}` / `{type:"spawn-error", terminalId, message}`
- `{type:"output", terminalId, dataB64}` — only while the server holds a subscription
- `{type:"scrollback", terminalId, attachId, dataB64}` — snapshot addressed to one
  viewer's attach; `{type:"attach-error", terminalId, attachId, message}` when unknown.
  A terminal whose process has exited stays attachable until its final `preview`,
  `snapshot` and `exit` are sent (a command like `echo hi` is done before its pane
  opens); it is forgotten only after its `exit`. If the daemon still refuses an attach
  and the terminal is (or within 3 s becomes) exited, the server sends that viewer the
  recorded screen instead of the error.
- `{type:"attention", terminalId, state, reason}`
- `{type:"preview", terminalId, preview, lastActivityAt}` — throttled (≥2 s)
- `{type:"session", terminalId, agentSessionId}` — the agent CLI's own session id, once its
  hooks report it (sent once per terminal); stored on `local_terminals.agent_session_id`
  and what `POST /api/local/terminals/:id/resume` hands back to `claude --resume`
- `{type:"links", terminalId, links:[{url, kind:"pr"|"issue"|"ref", provider, label}]}` — PR /
  ticket links found anywhere on the screen model (normal buffer + scrollback, plus the
  alternate screen while a full-screen program is up), merged into every link seen
  before — a full-screen agent scrolls its own history off the screen, but a PR printed
  ten minutes ago still identifies the session (`extractWorkLinks` in `@optio/shared`:
  GitHub PRs/issues, GitLab MRs/issues, Linear, Jira; soft wraps are healed by the
  emulator, hard-wrapped URLs by the scanner — only after lines that reach the terminal's
  width, so a URL ending a short line isn't glued to digits opening the next; URLs inside OSC 8 hyperlinks are harvested
  from the raw bytes since Claude Code / gh print `#581` with the URL only in the escape;
  bare `#N` mentions resolve to the dir's GitHub/GitLab remote as kind `ref`). One link
  per PR / ticket (`dedupeWorkLinks`): a bare `#607` seen early and the PR's URL printed
  later are one PR, and so are owner / repo spellings that differ in case; the most telling
  link wins. Rides the preview throttle, sent only when the set changes; the server
  sanitizes (https only, known kinds/providers, ≤50), dedupes again for older daemons, and
  stores it in `local_terminals.links`. Terminal responses dedupe once more, for rows
  stored before, and carry `triggerType` (`github`, `schedule`, …) so a trigger-started
  session's badge names its source instead of "trigger"
- `{type:"transcript", terminalId, entries:[{seq, role, kind, text, detail, toolName,
toolUseId, isError, at}]}` — new conversation entries distilled from the agent's transcript
  (Claude Code), batched (40 per frame), in `seq` order; sent on hooks, every 3 s while the
  session runs, and flushed once more just before `exit`. Accepted only from the owning host
  while the row is live; the server bounds text (16 KB) / detail (8 KB) and caps a terminal
  at 20 000 entries
- `{type:"dirs-result", requestId, dirs?, path?, error?}` — answer to `dirs`: the whole
  allowlist after the change (stored as the host's `dirs`) and the directory as resolved, or
  why the daemon refused
- `{type:"transcript-backfill", requestId, terminalId, entries, done, error?}` — answer to
  `transcript-request`: a finished session's whole conversation read off disk, batched
  (40 per frame) with `seq` from 1; `done` on the last frame, `error` when there was
  nothing to send. Stored only when it answers the request in flight for that terminal,
  from the host it was sent to
- `{type:"snapshot", terminalId, dataB64, cols, rows}` — the final screen (ring tail +
  grid), sent right before `exit`; its own frame so an oversize one the server drops
  (>1 MB) can never swallow the exit. Accepted only from the owning host while the row
  is still live.
- `{type:"exit", terminalId, exitCode}`
- `{type:"credentials-result", requestId, token?, expiresAt?, error?}` — answer to the
  server's `credentials` request (see "Claude token refresh from your machine")
- `{type:"agent-limits", limits:{codex?}}` — Codex's newest rate-limit snapshot (see
  "Usage limits" under Web UI); on connect, every 3 minutes, and a moment after any
  attention change (a turn ending logs fresh limits)
- `{type:"agent-models", models:{codex?:{models:[{id, label, description?, efforts,
defaultEffort}], fetchedAt}}}` — the models the machine's Codex offers (see "Launching
  agents"); sanitized and stored per host
- `{type:"ping"}` every 30 s (server updates `lastSeenAt`, replies `{type:"pong"}`)

Server → daemon:

- `{type:"spawn", terminalId, dir, cols, rows, spec}` (spec as in REST; agent specs may
  carry `model`, passed to the CLI as `--model` / `-m`, `effort`, and `permissionMode`
  (Claude Code; `auto` when absent) — see "Launching agents" — and `mode: "headless"`
  combined with `resumeSessionId` runs `claude -p --resume` for Claude Code)
- `{type:"input", terminalId, dataB64}` / `{type:"resize", terminalId, cols, rows}`
- `{type:"kill", terminalId, signal}`
- `{type:"attach", terminalId, attachId}` / `{type:"detach", terminalId}` — daemon
  snapshots the ring buffer and enables live output atomically on attach; the snapshot
  is routed only to the attaching viewer (no gap, no duplicated history for others)
- `{type:"credentials", requestId}` — ask for the machine's Claude OAuth access token
- `{type:"transcript-request", requestId, terminalId, agent, agentSessionId}` — read a
  finished session's conversation off disk (see "Backfill" above)
- `{type:"dirs", requestId, op:"add"|"remove", path}` — change the allowlist, as
  `optio local add|remove` would on the machine; only sent to daemons whose hello set
  `manageDirs` (`services/local-dirs-service.ts`, `cli/src/local/dir-allowlist.ts`)
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
a window resize can never reflow the replay. A viewer that was streaming when the terminal
exited gets `exit` followed by a `size` with that recorded grid, so it pins the same way. Client → server (JSON only — no raw-keystroke frames, which
eliminates the classic "pasted JSON swallowed as control" bug):
`{type:"input", data}` | `{type:"resize", cols, rows}`.

## Web UI

- `/sessions` — local terminals are rows in the unified sessions list (the old `/local`
  cockpit redirects here; `/local?new=1` redirects to `/sessions/new`). Paired hosts, their
  directories, and the **Automations** (blueprints) editor live on `/machines`. **Add
  machine** there (and "My machine" in the New work form while none is paired) shows the
  pairing steps with this server's own commands — `--server` is the API as the page reaches
  it, sign-in is skipped when auth is off — and watches for the machine to connect
  (`components/local/pair-machine.tsx`). Each machine's directories are added and removed
  there, and the form's Directory list has "+ Add a directory…"
  (`components/local/host-dirs.tsx`); a machine that can't take the request shows the
  `optio local add` command instead.
- `/local/[id]` — focus view: full xterm.js terminal + header (title, host, dir, state,
  attention, PR / ticket badges, where it came from — GitHub, Slack, Linear, a schedule, …
  for a trigger-started one — Kill / Start / Delete). **Sessions** on the Work list
  (`/work`) opens it at the session that has waited on you longest, else the most recently
  active one (`sessionScreenTarget` in `lib/work-feed.ts`). Agent sessions with a recorded
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
  a newline instead of submitting; `components/local/conn-state.ts`. On a Mac, Option
  keys reach the agent as a Mac terminal sends them (`⌥↑` is `ESC[1;3A`, Codex's key for
  answering a question or editing a queued message). This relies on
  `apps/web/next.config.ts` including xterm.js unparsed: webpack's `process` polyfill
  otherwise makes xterm.js believe it runs under Node and drop its Mac key handling
  (`e2e/terminal-keys.spec.ts`).
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
  hover. Inside `/local/:id` the favicon shows _that_ session's dot; on `/sessions` it shows the
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
  since it only moves when Codex runs, and zeroes a window whose reset has passed. A
  session's header shows the same numbers (`SessionLimitsPills` in
  `components/local/usage-chips.tsx`): Codex's in a Codex session, Claude's otherwise,
  and both in a plain terminal on a machine where Codex ran inside its current 5-hour
  window.
  **Live** (`live-panel.tsx`) is one grid of every open local terminal, interactive
  session, and awake persistent agent, each linking into its view. **Recent**
  (`recent-runs.tsx`) is a newest-first feed of repo tasks, job runs, and agent turns from
  `GET /api/runs/recent` (`routes/recent-runs.ts`, a workspace-scoped UNION).

## CLI

- `optio local up` — register host (name defaults to `os.hostname()`), connect, serve.
  `--no-remote-dirs`: Optio can't add or remove this machine's directories.
- `optio local add <dir>` / `optio local remove <dir>` / `optio local dirs`
- `optio local status` — host + terminal summary.
- Dir list and the host id each server gave this machine persist in
  `~/.config/optio/local.json` (`$XDG_CONFIG_HOME/optio/local.json`); git remote
  auto-detected per dir. The host id is the machine's identity: don't copy this file to
  another computer.

## Non-goals / follow-ups (v1)

- **Cost tracking** for local terminals (needs transcript-sidecar parsing; column exists).
- **GitHub notifications poller** as an alternative to the webhook for review requests
  (for installs without a public URL) — needs the `notifications` OAuth scope, which the
  login flow doesn't request yet.
- Web push for `needs_you` transitions (in-app only for now).
- Multi-replica API relay (daemon sockets are in-process, matching exec-based sessions).
- Terminal survival across daemon restarts (PTYs are daemon children; `claude --continue`
  in the same dir is the recovery path).
