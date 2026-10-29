# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A session's PR badges wear the PR's state once GitHub / GitLab has answered: grey while a draft, green open, purple merged, red closed. An open PR carries one small mark after its number for how it is going — an amber dot while CI runs, green when it passes (a check once a reviewer has approved), red when CI fails or changes were requested — and the tooltip spells it out ("open · CI passing · approved"). Tickets get the same, quietly: a GitHub / GitLab issue's glyph closes when it is done, a Linear / Jira ticket shows a dot while in progress and a check when done (through the workspace's ticket provider). The web asks `GET /api/work-links/status` once a minute for every badge on the page, with the viewer's own access; the API caches answers in Redis so many viewers cost one host lookup per PR per minute.

### Changed

- "Kill" on a Local session is now "End session" and no longer asks first — ending a process is reversible (resume the chat). Deleting a session (the trash icon in the rail, the session header, and the session card) now asks instead, since that removes its record and transcript.

### Added

- **Twenty more GitHub trigger kinds** (#687). Work can now start when an issue is commented on, edited, reopened or closed, when a label is removed, when a PR is commented on, gets a review, gets new commits, or is closed without merging, when a tag is pushed or a branch created or deleted, when a deployment succeeds or fails, on a `repository_dispatch`, on a Dependabot / code scanning / secret scanning alert, and when a discussion is started or commented on — on the web, iOS and Android, grouped in the form. New filters say who and what: **Written by** (people by default, so an agent's own comment, review or PR push as a GitHub App never wakes it again; bots; anyone), **Never from these users** (nothing those accounts do fires the trigger, whatever the kind — name an agent that works with a personal token here; the trigger's own username is always skipped for comments, reviews, edits and PR pushes), **Only when the author replies** (the reporter answering a triage question, not a bystander), **Comment starts with** (a slash command like `/optio retry`, or a `/regex/i` — one that can't backtrack catastrophically), the review states a submitted review must be in, and the severities a security alert must have. Prompts get `{{commentAuthor}}`, `{{actor}}`, `{{changes}}` (what an edit changed), `{{reviewState}}`, `{{environment}}`, `{{alertSeverity}}`, `{{dispatchType}}` and `{{dispatchPayload}}`. The triage flow — an agent asks for details and labels the issue `needs-info`, the reporter replies, the agent wakes and re-checks — is `events: issue_commented + issue_edited, labels: needs-info, authorOnly`.

### Changed

- A GitHub comment that @-mentions the trigger's username is skipped when that username wrote it (it used to be skipped when the issue's author matched instead, which also dropped other people's mentions on that person's own issues).
- A GitHub trigger saved with no event kinds meant "every kind". Existing such triggers are pinned to the eleven kinds that existed when they were saved (a migration), so the twenty new kinds don't start them on every comment, edit, push to a PR, close, branch and alert. New triggers always say their kinds.
- A GitHub review in state "commented" with no text no longer counts as a review: GitHub sends one around every single inline comment, which already arrives as a PR comment, so a trigger listening for both fired twice.

## [0.22.0] - 2026-10-27

### Added

- **The built-in Redis can keep its data.** `redis.persistence.enabled=true` gives the chart's Redis a ReadWriteOnce volume (`redis.persistence.size`, `redis.persistence.storageClass`) and runs it with an append-only file, so BullMQ's delayed and in-flight jobs and short-lived keys survive a pod restart or a node pool scaled to zero (runs are recovered from Postgres either way). An init container owns the volume for Redis on storage drivers that do not apply `fsGroup`. Off by default; turning it on or off replaces the dataset. See `docs/redis.md`. (#688, thanks @travis-burmaster)

### Changed

- Project instructions for coding agents live in `AGENTS.md`; `CLAUDE.md` imports it and holds only Claude-Code-specific notes.
- Security vulnerabilities are reported through GitHub's private vulnerability reporting for the repository (`SECURITY.md`), not by email.

### Fixed

- **Repo pods could never start under the resource quota.** With `resourceQuota.enabled` (as `values.production.yaml` sets it), Kubernetes rejected every container without its own cpu/memory requests and limits, and tasks sat in `provisioning`. The chart now also renders a LimitRange (`resourceQuota.limitRange`, on by default: 250m / 512Mi requested, 2 CPU / 4Gi limits) that fills them in for every container Optio creates without its own settings — repo, Job, agent and session pods, and the chart's own Postgres init and test pods. `default` is a hard cap per container and counts against the quota's `limits.*`; `docs/production-eks.md` says how to size it. (#685, thanks @travis-burmaster)

## [0.21.0] - 2026-10-27

### Added

- Optio Local reads the agent's own status. The daemon's terminal answers the OSC 7501 Program Status Protocol query (the protocol Ghostty 1.4 ships and Claude Code, Pi and Crush emit), so an agent reports `working`, `blocked` (waiting for permission, a question, or a sign-in), `done`, `error` and `idle` itself instead of Optio inferring them from hooks, bells and silence. The "needs you" queue and the terminal cards, on the web, iOS and Android, say what the agent is waiting for.

## [0.20.0] - 2026-10-25

### Added

- Pi agent support for pod-based tasks, Jobs, persistent agents, interactive sessions, and PR reviews, with isolated credentials and MCP configuration, model selection, streamed results, and session resume. Supports Anthropic, OpenAI, and Gemini API keys; Pi on Local machines is not yet supported.
- Pod sessions discover PR and ticket references in chat and terminal output, persist them, and display searchable badges in the header, sidebar, and Work list.
- Pod-session inline renaming, saved chat drafts, readable ended-session chat history, sending selected terminal text to the agent, and keyboard and mobile terminal scrolling improvements.

### Changed

- Standardize service images, agent images, development, and CI on Node.js 26.12.1, including the October security fixes for CVE-2026-111497 and other advisories. Node images are pinned by multi-platform digest; Ubuntu agent images copy the same runtime. Install pnpm explicitly because Node 26 no longer bundles Corepack.
- Refresh compatible dependency releases, including Fastify, AWS SDK, MCP SDK, React, Tailwind, Playwright, authentication libraries, tooling, and the latest Next.js 15 patch. Keep larger framework migrations and documented agent workaround pins separate.
- The GitHub Pages site prominently links to the repository in desktop and mobile headers, with View on GitHub as the primary home-page action.

### Fixed

- Repository setup and pod-naming helpers preserve dotted repository names (#676).
- Cleanup keeps PR-review worktrees while their reviews are running (#677).
- iOS chat tables render in horizontally scrolling columns.

## [0.19.2] - 2026-10-22

### Changed

- The Work list and a session page load behind skeletons shaped like what is coming — row placeholders with their attribute pills and status chips, and a session header over the dark screen — instead of a "Loading work…" line in the corner.

### Fixed

- A session's PR / ticket badges no longer repeat: the Linear or Jira ticket a session was started for showed as a generic badge next to the agent's own Linear badge for the same issue, and a bare `#1234` sat next to a `repo#1234` PR badge. Badges match by what they name (a Linear / Jira URL goes by its key whatever brand it was stored with), a bare ref gives way to any branded badge of its number, and the API folds the ticket into the session's links so the web, iOS and Android all show one badge per ticket.

## [0.19.1] - 2026-10-22

### Added

- **A queued session on a machine can jump the line.** A session waiting for a free agent slot (the machine's "Agents at once" limit) now opens on a Queued panel with its place in line instead of a terminal stuck on "Connecting", and offers **Move to front** (the next to start when an agent finishes) and **Start now** (starts at once, past the limit) — on the web, iOS and Android, and as `POST /api/local/terminals/:id/front` and `POST /api/local/terminals/:id/start` with `{ "now": true }`. Terminals carry `queuePosition` while queued.

### Changed

- **Agents on your machine skip permission checks by default**, the way agents in pods always have: Claude Code starts with `--dangerously-skip-permissions` and Codex with `--yolo`, whether a person, a trigger, or Ask Optio started the session. The work form's Permissions field (runs on a machine only) still opts into Auto (Claude's classifier; Codex's workspace-write sandbox, new) or Ask first / Codex's own settings. Daemons on the previous release keep their old `auto` default until updated.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Codex runs in pods passed `--full-auto`, which recent Codex releases (0.162+) reject; pods now run `codex exec --dangerously-bypass-approvals-and-sandbox` (the pod is the sandbox). They also no longer hang on "Reading additional input from stdin": the run's stdin stays open for messages, so Codex is started with none.

## [0.19.0] - 2026-10-21

### Added

- **Ask Optio runs in the API pod** by default: a turn is a child process of the API (the API image now carries Claude Code and Codex) instead of a pooled agent pod per conversation. `OPTIO_ASSISTANT_PLACEMENT=agent-pod` (Helm `optio.assistant.placement`) keeps the separate pod; a turn with a repo, another harness, or past `OPTIO_ASSISTANT_IN_POD_MAX` (default 3) running turns goes to an agent pod anyway.
- Machines have an **agent limit** (default 3, on the Machines page): agent sessions that automations, Jobs, Tasks and tickets start past it queue ("Queued") and start as agents finish, oldest first, the way a repo's concurrency limit queues pod tasks. A session you open by hand always starts but counts; shells and plain commands never count. The limit is set on the Machines page on the web, and on a machine's page in the iOS and Android apps (`PATCH /api/local/hosts/:id`).

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- iOS: swiping through a Codex session's terminal scrolls again. Wheel reports carried the bottom-right cell as the pointer, which Codex ignores (it only scrolls over its transcript); Claude Code scrolled regardless.

## [0.18.2] - 2026-10-20

### Changed

- Session sidebar: a running session's row shows a **Kill** button instead of the trash. One click stops the session; once it has exited the same slot becomes the **Delete** trash button. Stopped sessions show the trash straight away.
- Deleting the session you are viewing moves you to the next session in the sidebar (or the previous one when it was last) instead of the landing page.

## [0.17.4] - 2026-10-15

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Session trash buttons stop running sessions and delete them in one click, without a confirmation popup or a separate Stop step. Deletion waits for the session to exit before removing its record.
- Sidebar session actions appear in the order **Trash · Side by side · Pin**, with Pin at the right edge.
- Creating a task while another server queues or starts it no longer returns an error or resets the task to queued.

## [0.17.2] - 2026-10-13

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- PR and ticket badges in work sessions, cards, and the session sidebar can expand to show every link with **+N more**, then collapse again with **Show less**. The controls support keyboard navigation and do not trigger the surrounding card or session link.

## [0.17.1] - 2026-10-13

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Switching between Work sessions keeps the session sidebar and layout mounted while the next session loads, preserving search, scroll position, and sidebar width instead of flashing the normal navigation.
- Session sidebar rows keep their initial recency order while the sidebar is open, so typing and live updates do not move work out from under the pointer. Pinning, new sessions, and the Live / Finished sections continue to update.
- Live updates no longer repeatedly scroll the sidebar back to the selected session while browsing other work.

## [0.17.0] - 2026-10-12

### Added

- **Controller MCP**: agents and external clients can discover, create and edit work, manage schedules, inspect results and logs, and exchange messages with persistent agents and active task/Job agents. Per-run read/manage access, workspace boundaries and authenticated sender attribution apply across all six supported runtimes.

### Changed

- Tasks and Local sessions share **`/work/:id`**, with the full task context, PR/CI status, conversation and terminal in one workspace. Task links follow the current attempt, previous attempts remain selectable, and legacy links preserve split state when redirected.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Watch updates for one user are serialized across API instances so a delayed quiet update cannot overwrite a newer running state or recreate its end timer.
- Local tasks are excluded from the pod stall detector, preserving running work instead of showing a false execution failure.
- Auto-merge defers on CI API errors, rechecks CI before merging, and pins the merge to the checked commit. GitHub and GitLab PRs with no checks remain eligible after a one-minute registration grace period; CodeCommit keeps merging without that delay. No settings changes are required.
- iOS task, Job, and review logs recover missed history after reconnecting, including long outages, without dropping concurrent live rows or duplicating persisted lines. WebSocket connections report ready after the handshake succeeds, and log recovery also covers the first connection.
- iOS app and widget archives report `0.17.0` with the supplied build number. Both include required-reason privacy manifests and use the signing prefix for shared Keychain access. The app declares local-network access and push notifications, and both targets allow user-selected HTTP servers consistently.
- iOS Makefile commands propagate build/test failures and provide explicit archive, export, and TestFlight upload commands. See [the release guide](apps/ios/RELEASING.md) for account setup and device acceptance checks.

## [0.16.0] - 2026-10-11

This version was prepared but not tagged; its changes are included in v0.17.0.

### Added

- **Usage** (`/usage`): a combined people and organization-work leaderboard, token and cost trends, model and repository filters, private activity drilldowns, and monthly organization/person/work budgets. An atomic usage ledger preserves unknown prices, separates reported and estimated costs, and counts Local attempts once. See `docs/usage.md`.
- **Durable trigger delivery**: events are saved before acknowledgment, scheduled occurrences commit with schedule advancement, and retries recover the original run identity. Work → Trigger history shows dispatch outcomes and offers retry for failures. See `docs/trigger-delivery.md`.

- **Scale-out, phase D: Optio Local across API pods, and any number of API replicas** (`docs/plans/scale-out.md` §4, "Several API instances" in `docs/optio-local.md`). A daemon is one socket on one API instance, the host's **owner**, which holds the lease `local-host:<id>` (30 s, renewed every 10 s, held per daemon connection); viewers, REST calls and workers on any other instance reach it over the **Local bus** (`services/local-bus.ts`: one Redis subscriber per instance, started after `listen` and retried with backoff; binary envelopes, so terminal bytes cross without base64; sharded pub/sub in `REDIS_MODE=cluster`, so a channel keeps publish order). Everything for a daemon goes on `optio:local:host:<id>:in`, which only its owner subscribes to, naming the lease holder its sender read; what a terminal's viewers get goes on `optio:local:term:<id>:out`, subscribed only while an instance has a viewer of it, and published only while a viewer is on another instance; answers come back on `optio:local:reply:<instance>`. A viewer on any instance gets the attach snapshot and live output in order and its input, resize and view reports reach the daemon, with the grid arbiter kept by the owner; spawn and kill are acknowledged by the owner: nobody listening counts as offline (a spawn parks, a kill settles the row, as before), while an owner that heard a frame but didn't acknowledge it in 5 s counts as unknown — a spawn stays `launching` and is never sent again (`started` settles it from `launching` or `pending`; the stuck-launching sweep fails it otherwise) — so **a kill through another instance no longer marks the terminal exited while its PTY keeps running, and a spawn no longer parks as host-offline**; dirs, limits and transcript backfill get their daemon's answer relayed back to the instance that asked, in order per host; **a Claude token never crosses Redis**: a token refresh asked on another instance runs entirely on the daemon's instance and only the outcome comes back. "The newest daemon wins" across instances: a new connection seizes the lease and publishes `host-taken`, which only makes the others re-read the lease — a connection gives the host up (without marking it offline) only once its own claim has completed and the lease names another connection, so two daemons connecting at once leave exactly one; frames for a connection that arrive before its claim completes are handled right after it; a disconnect releases only its own connection's lease (one that closed mid-claim gives it back once the claim lands, before the offline mark), and a host is marked offline only while no connection holds one. Online is the lease everywhere: `isHostOnline`, and `getHost` / `listHosts` / `pickOnlineHost` derive `state` from it in the same query (the column stays the last-known state for alerts and the sweep); what a daemon can do is stored on the host row (`local_hosts.capabilities`, new migration) and read off the rows already loaded, so the host list makes no query per host. Every 10 s (one tick at a time, one lease query for every host) each instance reports its remote viewers whose attach has gone out to their owners and checks the owner still holds the host: viewers of a daemon that moved (or whose owner died) are closed with 4503 and reattach, as the clients already do. The liveness sweep is a BullMQ job scheduler (`local-sweep.sweep`) under the `poller:local-sweep` lease, and also marks offline hosts whose lease lapsed and starts terminals parked as host-offline whose host is back; the automatic Claude token refresh window is a lease shared by every instance. **The chart no longer requires `api.replicas: 1`** or forbids autoscaling (the HPA owns the count when enabled; the Deployment omits `replicas` then); rollouts stay `Recreate`. Coverage: `local-bus.test.ts` and `local-relay-cluster.test.ts` (routing, request/reply, handover, claim backlog, ordered relayed replies, owner tasks), `local-bus.int.test.ts` and `local-cluster.int.test.ts` (real Redis and Postgres: two bus instances, lease seized on `host-taken` or at renew, a late acknowledgement sends a spawn once, a close mid-claim leaves no lease, online from the lease), `redis-cluster.int.test.ts` (1000 frames in order through each bus on the three-master test cluster), and `apps/api/e2e/scale-out-local.e2e.test.ts` on three real API servers — a viewer on B streaming a daemon on A, spawn / kill / dirs / limits / input through B, the daemon reconnecting to B, A SIGKILLed while it owns the host, a local Job run started through B, every server agreeing on online state, and two hellos at once on A and B leaving exactly one connection, 20 times over. The e2e Local test clients are shared (`test-utils/e2e/local-fakes.ts`).

- **Scale-out, phase B: agent runs outlive the API process that started them** (`docs/plans/scale-out.md` §1–2, `docs/reconciliation.md` → Attachment). Repo Tasks, Job runs, persistent-agent turns and PR-review runs all start under the run protocol and are streamed through one attach loop (`services/run-attachment.ts`): the attached instance holds a lease on the run (60 s, renewed every 20 s, `attached_by` / `attach_lease_until`), reads the agent's output file from byte 0, replays what earlier attachments stored into its in-memory derivations (PR tool calls, session id, terminal event, the result and auth-failure digest, a command's exit receipt) and stores the rest as log rows **with the consumed offset in one transaction**, so a run that changes hands gets no duplicate line and no gap. No worker keeps a run's whole output in memory any more: each agent adapter reads its result line by line (`createResultParser`). A run's exit and its spend are recorded once (`settleRun`), whichever instance finishes it. When an instance goes away its runs' leases expire; an attach sweep (every 30 s) and the reconciler's new `reattach` action hand them to another instance, which claims each by CAS; a run whose starter went away before its agent started is put back by its kind's own retry (`requeueRun`), and a stall counts only while a run is attached. On SIGTERM an instance gives its runs up at once. Cancel (a task, a Job run, a review, an archived agent's turn) signals the agent's process group from whichever instance takes the request, and a mid-run message to a task is appended to its agent's stdin by the route; the Redis channel only notifies viewers. A boot no longer fails or flags runs in flight. A task or review run is `running` (an agent `running` a turn) only once its agent started. A job that started or claimed an agent and ends without finishing its run (an error while setting it up, a cancel or requeue under it) stops that agent, scoped to its supervisor's pid, while an error once the agent streams (a database or parser failure) only gives the lease up so another job attaches — after three failed attach jobs in a row the run fails and its agent is stopped; every path back to `queued` (a force-redo too) stops the last attempt's agent; a re-attach never claims a run already finished, nor one a job of the same instance holds (`attached_by` names the hold); a review cancelled while its run is set up cancels the run and writes nothing to the review; on SIGTERM a run past its stream finishes settling first (up to 20 s, `OPTIO_DETACH_SETTLE_WAIT_MS`); a fresh start stops a stale supervisor TERM → KILL and moves the old attempt's files aside; a message sent after the agent finished its turn is marked undelivered; a Claude `result` event decides a task's or review's success whatever the process's exit code (other agents keep their failure-signal rule, the exit code unused, as before); a re-attach reads a Job run or turn by what the attempt ran; and a failed, lost or silent run's error carries the tail of the agent's stderr. A pod row a server abandoned mid-creation (still `provisioning` past `OPTIO_STALE_PROVISIONING_MS`, 10 min) is taken over by whoever needs the pool — a persistent agent's pod too, which before waited on it forever — and a waiter waits only until then.
- **Scale-out, phase C2: sessions, glance and skills on every API pod** (`docs/plans/scale-out.md` §3). A pod session's chat turn still runs on the API instance that received the prompt, but its frames now reach a viewer connected to any instance: every instance subscribes once to the **session bus** (Redis channel `optio:session-bus`, `services/session-bus.ts`; after the server listens, retried with backoff, so REST serves while Redis is down) and delivers what arrives to its own sockets, while the instance that published acts on its own message first and skips it when it comes back, so a local viewer never waits on Redis. **Interrupt, end-session and share revocation work across instances**: an interrupt is recorded on the running turn's row (`finished_at` set while the turn is still `running` — no other write produces that), nudged over the bus naming that turn, and honored by the instance running the turn on its next two-second control poll even if the bus message was lost (`watchTurnControl`); a session ended or a share revoked through one instance closes the sockets held by every other one, and the 10 s recheck now also closes a socket whose session has ended. The instance running a turn holds the lease `chat-turn:<id>` (60 s, renewed every 20 s), and recovery — at boot and on every 30 s housekeeping sweep — settles only `running` turns whose lease has lapsed, so a replica booting never interrupts a live turn and a crashed instance's turn is settled within about a minute. The **glance / push bookkeeping** that lived in one process's memory — the last attention state pushed per terminal, the last needs-you and running counts per user, hosts already alerted offline, and the two timers (the Watch's quiet-period end, a snooze's expiry) — is rows in `glance_state` (`services/glance-state-service.ts`), shared by every instance; a terminal's previous attention state is read and replaced in one locked step, so a transition taken by several instances alerts once, an outage is claimed with one insert, and a change that changes nothing writes nothing; timers are due rows fired by whichever instance's sweep claims them (`workers/glance-sweep-worker.ts`, a BullMQ job scheduler with a stable id every 30 s, run under the `sweep:glance` lease, the rows claimed atomically so a timer fires once), up to one interval late; the APNs / FCM one-second Watch coalescer stays per instance (worst case one duplicate push, folded by the collapse id). **Marketplace skills live in the database**: the sync worker writes every file of a synced skill to `installed_skill_files` with the manifest in one transaction, a run spawned on any instance reads them there (`readInstalledSkillFiles`), a `.optio-synced` sentinel row marks a skill synced at its commit (a skill with no files included), a re-sync at the same commit is a no-op, a skill synced before the upgrade (a commit but no sentinel) is due again on the pass the worker enqueues at boot, syncs of one skill collapse into one queued job (`sync-one-<id>`) and overlapping writes upsert, and the clone is scratch under `/tmp` (`OPTIO_SKILLS_SCRATCH_DIR`). The chart's `installedSkillsCache` PVC, volume and mount are gone (the value is ignored; `helm upgrade` deletes the claim — `docs/production-eks.md`).

- **Scale-out, phase A: the foundation for API pods that share one database and runs that outlive them** (`docs/plans/scale-out.md`). Every API process has an id (`OPTIO_INSTANCE_ID`, the pod's name from the chart, plus a suffix new at every boot; `GET /api/health` says which instance answered, to a signed-in request only). One migration adds every table and column the plan's phases build on: the attachment columns on runs (`exec_state`, `exec_pid`, `consumed_bytes`, `attached_by`, `attach_lease_until`, on tasks, Job runs, PR-review runs and agent turns), `leases`, `ws_upgrade_tokens`, `inbound_webhook_deliveries`, `glance_state`, `installed_skill_files`, `ticket_sync_claims`, and one active PR review per PR URL. `services/lease-service.ts` is the one way an instance claims something for a while. The **run protocol** (`packages/container-runtime/src/run-protocol.ts`) is on every container runtime — `startRun`, `attachRun`, `deliverStdin`, `killRun`: a start script launches the agent under a supervisor in its own session in the run's home, with stdin fed from a file through a FIFO until the `__OPTIO_STDIN_EOF__` line, its output appended to `output.ndjson` and its exit code to `exit`; the supervisor writes its own pid file (`<pid> <starttime>`) once its TERM trap is in place, and attach, kill and the pooled start guard trust a pid only when the live process's start time matches it; stdin bytes travel over the exec's stdin (`head -c <n>`), never in a script or its environment; an attach is `tail --pid` from a byte offset; the exec that started a run can go away and any instance can attach later. `tini` is the pods' pid 1 (`images/base.Dockerfile`, every init script), so finished runs are reaped — **the agent images must be rebuilt for the protocol**. The repo-cleanup worker removes the run homes of finished runs from every pod (`run-home-sweep-service.ts`), the backstop for the attached worker that removes them once a run is terminal and consumed (phase B). `buildTaskStartScript` / `buildPooledStartScript` build the start scripts beside the exec scripts the workers still use (they switch in phase B). The fake runtime keeps its pods on disk (`OPTIO_FAKE_RUNTIME_DIR`) and plays a protocol run as a detached process (`fake-agent.mjs`, every event with a `seq`), and `test-utils/e2e/api-cluster.ts` boots N real API servers on one database for the e2e tier: two boot together, one is SIGKILLed, a third joins.

- **Scale-out, phase C1: coordination that holds across API instances** (`docs/plans/scale-out.md` §3). A run's concurrency claim — fewer than the limit running, so take this one — runs under a Postgres advisory lock on the global limit (`claim:tasks`, `claim:workflows`; a repo's or a Job's own limit is counted under it) in one READ COMMITTED transaction (`services/claim-lock.ts`), in place of a mutex one process kept to itself; the count and the compare-and-swap claim run on the lock's transaction (`claimTransitionIn`, `claimWorkflowRunIn`), and what follows the claim (events, webhooks, the reconciler) is registered with `afterCommit` and runs once it commits. A claimer waits for the lock at most 10 s (`lock_timeout`) and otherwise re-queues as when a limit is full. Every periodic sweep (ticket sync, the schedule checker, external PR review, pod cleanup, the PR watcher, the reconcile resync, skill sync, token validation, the config directory) runs on one instance at a time under a lease (`services/poller-lease.ts`), and each is safe to overlap anyway: ticket sync claims each (source, ticket, repo) in `ticket_sync_claims` before creating a task (a claim whose task was deleted, or whose sweep died before making one, is taken over); the schedule checker advances a trigger's `next_fire_at` by compare-and-swap before firing it, so a tick fires once; an external PR review sweep launches only while the review is still the one it saw (none, for a new PR) and treats a lost race or the one-active-review-per-PR conflict as someone else's launch. Repeat jobs are BullMQ job schedulers with stable ids (`services/repeat-jobs.ts`), so instances booting in any order leave exactly one schedule per tick; boot no longer wipes every repeat job, only the hash-keyed ones an older build registered. Inbound webhook deliveries (GitHub, GitLab, Slack, Linear, Jira, PagerDuty, Sentry) are claimed in `inbound_webhook_deliveries` (`services/inbound-delivery-service.ts`) instead of a per-process set and a Redis key; WebSocket upgrade tokens live in `ws_upgrade_tokens`, so a token minted on one instance is accepted by whichever one the browser's upgrade lands on, once; the Optio assistant's one-conversation-per-user rule (30 s lease renewed every 10 s), a user's GitHub token refresh and the config directory's apply are leases (`withLease` takes a `wait` option for the latter two). A GitHub user token is only ever refreshed under its lease — GitHub rotates the refresh token, so two instances refreshing at once would strand one: a waiter re-reads the token the holder stored, the call to GitHub times out after 15 s, a wait that times out uses the stored token while it works and otherwise the PAT, and a refused refresh deletes the stored tokens only while the refresh token is still the one it sent. A skill sync that finds the skill's lease held retries with backoff, and records its result only while the skill's ref and subpath are still the ones it resolved (a compare-and-swap in the same transaction): a sync of the old ref that finishes after a PATCH moved the ref writes nothing, and the skill stays due for the next pass. "Sync now" answers 409 while another instance is applying the directory. A webhook delivery's claim gets one second (`statement_timeout`) before the delivery is accepted unclaimed; an upgrade token's expiry is the database's clock. A housekeeping tick (`workers/sweep-worker.ts`, every 30 s under a lease, `registerSweep` for more) removes deliveries older than a day, expired upgrade tokens and long-expired leases. `docs/production-eks.md` says what stays per pod. Coverage: integration tests drive every claim with two racing callers; `apps/api/e2e/scale-out-coordination.e2e.test.ts` runs two real API servers with auth on — an upgrade token minted on A accepted by B once, one signed webhook delivery posted to both firing once, a due schedule fired once by two sweepers, and one scheduler per repeat job after both boot.
- **Android: every trigger type in the automations and agent trigger sheets.** A Local automation's Add trigger sheet and a persistent agent's New trigger sheet take all fourteen trigger types — GitLab, Jira, Pylon, PagerDuty, Sentry, Alertmanager and Datadog events included, with their event kinds, identity and filters — through the same rows as the New work form (one trigger editor in `core:ui`, `triggers/`). A Pylon / Alertmanager / Datadog trigger's own URL and shared secret are shown once, with copy buttons, right after it is created, in the sheets and in the New work form.
- **Every agent runtime gets the work's MCP servers.** Connections' tools and MCP servers reached only Claude Code (`.mcp.json`) and Codex (`config.toml`); a Job on Gemini, a persistent agent on Copilot, or a Task on OpenCode or Cursor had the connections' credentials and notes but no tools. Each runtime now gets the same servers in the file it reads, established from the versions the agent image installs: Gemini CLI in the user `settings.json` of a `GEMINI_CLI_HOME` of the run's own (the adapter's settings merged in, each server `trust: true`), OpenCode in an `OPENCODE_CONFIG` file merged before the project's own, GitHub Copilot CLI through `--additional-mcp-config @<file>` (`type: "local"`, every tool enabled), and Cursor in the project's `.cursor/mcp.json` with `--approve-mcps`. See `docs/connections.md` → "Which runtime reads which file".
- The per-run files live in one **run home**, `/home/agent/optio/runs/<run id>` (`OPTIO_RUN_HOME`), named after the task, Job run, or agent turn — so a retry lands in the same place — and removed when the run's script exits and again when the task's worktree is cleaned up. Codex's per-run `CODEX_HOME` moves there too; it used to be a random directory that was never removed from the repo pod's home volume.

### Changed

- **One sidebar for the dashboard and sessions.** Local and pod session pages share the dashboard's header, workspace switcher and account menu (`components/layout/sidebar-chrome.tsx`): the Optio mark opens a menu with the dashboard's destinations (keyboard navigable; Escape closes it and returns focus), Settings lives in the account menu instead of a separate footer row, and both session rails draw one header — back to All work, a session count, New session, and a search scoped to the sessions listed. On narrow screens every drawer keeps focus inside it and closes with Escape (`use-sidebar-drawer.ts`).
- **Android: work cards and session headers match iOS v0.15 and the web session sidebar.** Work, Overview and the Machines page draw one card (`core:workfeed`, `ui/WorkRowCard`): the harness logo with a status dot, the name and place, the host or pod and the recency, the status, the trigger and exit condition where they matter, and tappable ticket and PR badges (two at rest, up to eight expanded). The feed keeps a task's PR and the links its local terminal saw, shows each link once, and the Overview's Needs-you section no longer lists a local task twice. Local terminal and pod session headers show the harness, title, location, status, usage and cost together, with a full-width Chat / Terminal switch for local sessions and the link badges scrolling in a bounded area.
- Android trigger rows (automations, agents, the work form's summaries) read one dialect everywhere: `0 9 * * 1-5 · weekdays at 09:00 UTC`, `review requested, mentioned · @octocat · acme/web`, `firing · HighErrorRate · critical`.
- **iOS: real brand marks for PagerDuty, Pylon, Datadog, Alertmanager and AWS.** The four event sources left on SF Symbols (a bell, a life preserver, an ECG line, a dog) show the same marks as the web and Android apps everywhere a trigger is drawn — the New work form's Starts menu, scheduled Task, Job and agent trigger lists, Local automations — and `Brand(url:)` recognizes PagerDuty, Pylon, Datadog and Grafana / Alertmanager links. The Connections hub draws each catalog provider, the new-connection sheet and every connection row with the provider's brand (Notion, GitHub, Slack, Linear, Sentry, AWS, Pylon, PagerDuty) instead of a stand-in symbol; the generic providers (database, filesystem, terminal, HTTP API) keep theirs.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- A Helm release runs its agent pods in its own namespace: the chart sets `OPTIO_NAMESPACE` from the pod's namespace (downward API), and the Kubernetes runtime and the cluster and assistant routes read it (default `optio`), so a second release in another namespace no longer tries to create pods in the first one's. (#671)
- A task, Job run or PR review log view whose socket dropped (its API pod restarted or was replaced) fetches the rows it missed when it reconnects, instead of showing a gap until a reload. (#672)
- A persistent agent's turn is created and held before its pod is made, so an API server that dies mid pod creation no longer leaves the agent in provisioning for minutes: the turn's lease lapses, the turn is halted, and the agent wakes again with its messages still pending. (#673)
- **Session chat frames keep their order in `REDIS_MODE=cluster`.** A broadcast `PUBLISH` reaches subscribers through whichever node took it, so two frames on the session bus could arrive swapped; the session bus (and the new Local bus) publish and subscribe through one choice in `redis-config.ts` (`publishOrdered` / `createOrderedSubscriber`): sharded pub/sub (`SPUBLISH` / `SSUBSCRIBE`, Redis 7) in cluster mode, plain pub/sub in standalone mode (`docs/redis.md`).
- A Local daemon that reconnected while its old connection still looked open (a laptop waking up) left the terminals' viewers on the old connection, frozen: the new connection starts with no viewers, and nothing re-attached them. Their streams are now closed with 4503 so they reconnect to the new connection, as after any host blip.
- The setup-file writer merges a runtime's project config into the repo's own file instead of replacing it (`merge: "json"`), and marks a tracked file it wrote over `skip-worktree`, so an agent's `git add -A` can never commit Optio's MCP servers and their credentials over a repo's committed `.cursor/mcp.json` or `.mcp.json`. The image entrypoint writes `/opt/optio/…` setup files into the agent's home like the pod exec scripts do.
- Connections and providers can no longer set a runtime's config env (`GEMINI_CLI_HOME`, `OPENCODE_CONFIG*`, `COPILOT_HOME`, `CURSOR_CONFIG_DIR`) in a pod, as they already could not set `CODEX_HOME`.
- iOS builds again from a fresh checkout: SwiftTerm is pinned to 1.20.0 in `project.yml`, since 1.99.0 (released 2026-10-08) removed `TerminalView.getTerminal()`, which the terminal theme and the local terminal stream call.

## [0.15.0] - 2026-10-09

### Added

- Search fields now offer a clear button when they contain text. Clearing keeps keyboard focus in the field across the Work list, session rails, Connections, and the connection gallery. (#658)
- The iOS app offers Blade as an alternate app icon. (#661)

### Changed

- iOS Work and Overview attention cards share the web sidebar's harness logos, status dots, location details, and tappable ticket and PR badges. The feed preserves and deduplicates linked tickets and PRs, and Overview avoids listing a local task twice. (#660, #661)
- iOS session headers show the harness, title, location, status, usage, and cost together, with a full-width Chat/Terminal switch for local sessions. Link badges show two links initially and expand to at most eight; expanded header links scroll within a bounded area. (#661)

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Standalone Jobs and persistent agents now honor the existing `agent.nodeSelector` and `agent.tolerations` Helm settings, matching repository workloads. Invalid placement JSON fails provisioning with the variable name. (#659)
- The expired Claude OAuth token banner links to Settings → Integrations, identifies Deployment secrets as the place to replace `CLAUDE_CODE_OAUTH_TOKEN`, and recommends `claude setup-token` for a long-lived replacement. (#662)
- The Settings page gave two elements the `model-providers` id (the Access section wrapped the Model providers card, which already carries it, in a second one), which failed the Playwright model-providers spec.
- The session browser test locates a session row by id so a pin button with the same title cannot make its selector ambiguous. (#655)

## [0.14.0] - 2026-10-07

### Added

- **Pin a session.** A thumbtack appears at the top right of a session card in the sessions rail when you hover (the side-by-side button moves over to make room); click it and the session goes solid-pinned to the top of the list, where it stays until you unpin it. Pins are kept on the server (`POST` / `DELETE /api/local/terminals/:id/pin`, `pinnedAt` on the terminal), so every session list — the rail, the Work list's terminal rows, the iOS and Android apps — puts pinned sessions first.

- **Pick the sign-in an agent runs with.** The Who section's new "Signed in with" row lists every credential the work may use — the organization's stored sign-in secrets of the agent's known names (Anthropic API key, Claude OAuth token, OpenAI key, Codex app-server, Gemini key, GitHub token for Copilot, Cursor, Groq, OpenClaw), your own, and the Amazon Bedrock providers that serve the agent — with the one a run uses by default marked, and a `+` that stores a new one (checked with the service first where it can be) for the organization (admins) or just for you. The web, iOS and Android forms keep the pick as `agentOptions.credential`; Repo Tasks, Jobs and persistent agents then run with that value and the auth mode it implies, over the deployment's default. Work on a machine keeps the machine's own sign-in. `GET /api/agents/credentials`, `POST /api/agents/credentials`, `POST /api/agents/credentials/verify`.

### Changed

- **iOS: the New work form is at parity with the web's.** It creates through `POST /api/work` like the web, so the row and its trigger are written together and a rejected trigger leaves nothing behind; it checks an event trigger before submit (a kind must be picked; review requests, mentions and assignments need your username; a Slack channel id) and points at the gap in its sentence; recurring work can name each run with the trigger's `{{param}}`s; an automatic name ("Job 12") is bumped and retried on a clash; the Terminal example (a plain shell on your machine) and command runs (a terminal that runs and exits, in a pod or on a machine) are offered; a persistent agent can have a repo and a pod session needs Claude Code, as on the web; a Pylon / Alertmanager / Datadog trigger's URL and secret are shown once, with copy buttons, when it is created; and Cancel asks before discarding a filled-in form.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- **Clicking a session no longer moves it in the sessions list.** Lists order sessions by when you last typed into them, but the server counted every byte the browser's terminal sent as typing — including the focus report a click produces when a program such as Claude Code has focus reporting on, mouse reports, and the emulator's own answers to the program's queries — so opening or clicking a session jumped it to the top. Only keystrokes count now (`isTerminalTyping` in `@optio/shared`).
- **OpenCode runs again (#585).** `opencode run` waits for stdin to close before it starts, and the pod exec that launches an agent hands it a pipe that never closes, so every OpenCode Task hung before its first model call; every launch path (the Repo Task worker, the pooled Job / agent command, the image entrypoint) now closes stdin. OpenCode 1.x writes one JSON line per part (`text`, `tool_use`, `step_finish`, each with a `sessionID`), none of which the log parser knew, so a finished run had no session, no text or tool entries and no cost, and was recorded as having produced no output; the parser and the adapter read those shapes (captured from 1.14.20). A Job or persistent agent on OpenCode could not start at all: the pooled pod looked up the literal secret name "ANTHROPIC_API_KEY or OPENAI_API_KEY" and ignored `opencodeBaseUrl`; it now takes any one provider key, or none with a custom base URL, and forwards the base URL to the run.
- OAuth callback URLs on split-origin deployments: the API builds them from `PUBLIC_API_URL` (the browser-reachable API origin, which the chart's `web.publicApiUrl` sets and `values.yaml` now documents) before `PUBLIC_URL`, so a NodePort install or an API on its own host no longer registers a localhost or web-origin callback. The value is origin only; a trailing `/api` is tolerated. The chart passes it to the API only when set explicitly, keeping the web's NodePort fallback (`http://localhost:<nodePort>`) out of the API's callbacks, and no longer emits the unread `OPTIO_AGENT_PVC_STORAGE_CLASS` and `OPTIO_AGENT_PVC_SIZE` (the API reads `OPTIO_HOME_PVC_*`). Supersedes #539 and #581.
- Viewers no longer see "New work" on the web and iOS (Overview, the Work list and its empty state, the session rails, the dashboard panels, the Machines page); `/work/new` tells them the role is read-only instead of showing a form the server rejects on submit. Android already hid it. An unknown role, as on auth-disabled installs, still sees everything.
- Optio Local: a regression test pins that a terminal's "Last output" preview keeps the spaces of a TUI that places words with cursor moves (Claude Code). Previews stored before the daemon read them off the screen model (September 2026) can still read as "yetcoverapersistentagent"; a daemon from before then needs a restart.

### Security

- **Outbound URL guard.** Every URL a person typed that the API itself fetches — outbound webhooks, Slack notifications, ticket providers, and now connection health checks and the setup wizard's GitLab check — is vetted the same way (`@optio/shared/ssrf`, `apps/api/src/utils/outbound-url.ts`): http(s) only; the host name and every DNS answer classified; loopback, link-local (cloud metadata), multicast and reserved addresses and the metadata host names always blocked; private ranges and internal-looking names blocked by default. The API now connects to the vetted addresses only, so a DNS answer cannot change between the check and the connect, follows at most five redirects and vets each hop (credentials dropped when the origin changes), and reports a readable, secret-free reason: `blocked: host resolves to a private address (10.0.0.5); set OPTIO_OUTBOUND_ALLOW_PRIVATE=true or list it in OPTIO_OUTBOUND_ALLOWED_HOSTS`. `OPTIO_OUTBOUND_ALLOW_PRIVATE=true` (Helm `outbound.allowPrivate`) allows private ranges for in-cluster APIs; `OPTIO_OUTBOUND_ALLOWED_HOSTS` (Helm `outbound.allowedHosts`) lists host names, `*.suffix` names, IPs or CIDRs that are always allowed. `OPTIO_ALLOW_PRIVATE_URLS=1` still turns the guard off entirely (local dev only).

## [0.13.0] - 2026-10-07

### Added

- **Five new event triggers — GitLab, Jira, Sentry, Alertmanager (Prometheus / Grafana) and Datadog** — on every kind of work (a Job, a scheduled Task, a Local automation, a persistent agent), in the New work form, the Local automations editor, and the iOS and Android apps. GitLab (`/api/webhooks/gitlab`, `GITLAB_WEBHOOK_SECRET` as the webhook's secret token) mirrors GitHub: review requests, @-mentions, assignments, MRs opened and merged, issues opened, labels, pushes, releases, and pipelines passing or failing, filtered by project, branch and label. Jira Cloud (`/api/webhooks/jira`, `JIRA_WEBHOOK_SECRET`, `X-Hub-Signature`) fires on assignment, mentions (wiki markup and ADF), new issues, comments, transitions and labels, filtered by project, label, issue type and status, with the same `ticket*` params as a ticket trigger. Sentry (`/api/webhooks/sentry`, `SENTRY_WEBHOOK_SECRET` = the internal integration's client secret) fires on issues created, regressed, resolved, assigned or archived, on issue alert rules, and on metric alerts, filtered by project, environment and level. Alertmanager and Datadog can't sign, so — like Pylon — each such trigger gets its own URL (`/api/hooks/alertmanager/<id>`, `/api/hooks/datadog/<id>`) and shared secret, shown once on create and taken as `X-Optio-Secret`, a Bearer token, or a basic-auth password; an Alertmanager trigger fires once per alert group (firing / resolved, filtered by alert name, severity and receiver, every alert's labels and annotations as params), and a Datadog trigger on monitor transitions (triggered / warning / no data / recovered, filtered by priority, tag and monitor), with a payload template to paste into the Datadog webhook.
- **GitHub triggers now cover the repo, not only PRs and issues:** pushes (branches only, with `branches` globs like `release/*`), published releases, workflow runs passing or failing (and external check suites, counted once), PRs merged, and labels landing — plus `branches`, `workflows` and `labels` filters and the matching `{{params}}` (`commits`, `compareUrl`, `sha`, `tag`, `workflow`, `conclusion`, `labels`, …). "CI failed on main" and "a release was cut" can start work.
- Ticket triggers offer GitLab as a source in every picker (the sync itself already supported it, as it did Jira). Config-as-code manifests take every event trigger type under `when`.

### Changed

- Trigger validation, secret minting and the create response are shared by every self-secret type (Pylon, Alertmanager, Datadog): `WorkCreated.trigger.secret` is returned once for any of them, and the Pylon secret dialog is now the one secret dialog with per-provider instructions.
- Helm: `webhook.gitlabSecret`, `webhook.jiraSecret` and `webhook.sentrySecret` set the new receivers' secrets.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- The Redis Cluster pub/sub integration test and `pnpm --filter @optio/api redis:smoke` judge pub/sub by the message arriving. Both looped until `PUBLISH` counted a subscriber, but in a cluster that reply counts only the subscribers on the node that took the command, so it is 0 for a delivered message more often than not, and the test timed out in CI.

## [0.12.1] - 2026-10-06

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Tasks and scheduled Tasks created without an explicit branch start from the repo's configured default branch instead of `main`, so a repo whose default branch is `master` no longer crash-loops its pod on a missing `origin/main`. The New work form sends a blank branch as "the repo's default". A failed exec into a pod now reports why (for example `exec into pod "…" failed: Unexpected server response: 500`) instead of `[object Object]`, and every worker records a readable message for failures that are not Error objects. (#643)
- Settings → Code review lists the same live models as the agent and repo pickers, keeps a saved model the list does not offer selectable, and the API accepts a review model the live list offers, such as the newest Claude id, for the workspace default and for a repo. (#644)

## [0.12.0] - 2026-10-06

### Added

- **Redis Cluster and Amazon ElastiCache Serverless support.** `REDIS_MODE=cluster` (Helm `externalRedis.mode: cluster`) connects every queue, worker, pub/sub channel and the rate limiter through one `ioredis.Cluster` client with TLS and authentication, and places every BullMQ queue under a hash-tagged key prefix (`OPTIO_QUEUE_PREFIX`, default `{optio}`) so multi-key queue operations never fail with CROSSSLOT. Standalone mode and its `bull` prefix are unchanged, so existing installs keep their queued work. The chart rejects cluster mode with the bundled Redis or without a hash-tagged prefix.
- `pnpm --filter @optio/api redis:smoke` exercises a target Redis before a deployment is pointed at it: connectivity, eviction policy, queue processing, delayed and retried jobs, schedulers, pub/sub, and cross-slot scans. A new [Redis guide](docs/redis.md) covers ElastiCache Serverless setup, its command and eviction behavior, capacity alarms, and troubleshooting.
- Integration and pipeline e2e coverage against a real three-master Redis Cluster: enqueue, retries, delayed and scheduled work, cancellation, pub/sub, and recovery after every connection is killed.

### Changed

- The API logs the Redis mode, nodes and each node's eviction policy at boot, warns when queue keys could be evicted, and continues when no policy is reported (ElastiCache Serverless is fixed at `volatile-lru`, which never evicts queue keys). Shutdown closes the shared Redis clients.
- Task message publishing reuses the shared Redis connection instead of opening one per message, and agent-options cache invalidation deletes keys one at a time so it works on a cluster as well as a standalone server.

## [0.11.2] - 2026-10-06

### Changed

- README and product site now lead with a visual tour of Work, session panes, workflow triggers, native iOS and Android apps, and Apple glance surfaces. Production installation docs use existing Secrets and the supported single API/web replica.
- iOS Work widgets use a clearer count-and-session layout, real runtime logos, adaptive rows and quieter saved-work counts. The Start widget makes its confirmation and started states explicit. Lock Screen accessories distinguish waiting, running, offline and all-clear states.
- Live Activities use status symbols, readable action contrast and runtime marks, while retaining Reply, Later, Resume, Retry and PR links. Stale activities show their last update time.
- The web session’s “Terminal here” action is icon-only, with a descriptive tooltip.
- Session sidebar cards have equal left and right spacing, with a thin overlay scrollbar near the edge and a separate resize target on the divider.
- Web, iOS and Android status colors use purple for working, green for needs-you, grey for finished or dead sessions, and yellow for problems. Widgets, Live Activities and the Apple Watch Smart Stack share this palette. Web session harness logos are larger and sit directly in the sidebar without a surrounding tile.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- iOS session usage pills match the agent runtime. Codex sessions use their machine’s Codex limits, and shells and other agents no longer show Claude usage.
- The session sidebar's resize target stays inside the sidebar, so it no longer intercepts mouse input or text selection at the terminal's first character.

### Added

- An idempotent local example catalog with paused workflows for all nine trigger types, sample history, recorded sessions, and reproducible web/native screenshot tooling. Public captures use a separate fake-runtime demo instance.
- A dedicated Apple Watch Smart Stack layout for mirrored Live Activities (iOS 18 / watchOS 11 and later), with the priority session and one contextual action. iOS 17 retains its existing Live Activity support.

## [0.11.1] - 2026-10-06

### Changed

- **Local Sessions now follows the web redesign.** A clearer session list separates names, directories and machines; a slim session header brings controls beside the title while retaining usage and account limits. Headers and sidebar rows identify the agent harness or trigger with its own icon. Chat gains distinct message styling, an aligned composer and a jump-to-latest control that reaches the actual bottom. Resizing, thin native scrollbars, terminal shortcuts and view-local pane groups remain available.
- Session logos retain their brand colors, sidebar rows show the trigger separately, and Local sessions use one reconnect notice for host and browser connection issues.

### Added

- Codex Local sessions report tokens and estimated API-equivalent cost, including cached input, cache writes, model changes and known long-context/Fast rates. Repeated usage snapshots are counted once; unknown model prices stay unavailable. The updated Local daemon supplies live totals and usage when backfilling recorded conversations.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Local and pod terminals fill their panes without an extra black inset around the screen; shared-screen scaling uses the full available width.
- Equal-sized terminal viewers recognize the same grid when header and status-strip heights fall on fractional pixels, avoiding a false “Sized for another device” banner.

## [0.11.0] - 2026-10-06

### Added

- Open a terminal beside a session in the same local directory or pod workspace. Multiplexed sessions appear as nested sidebar rows; grouping belongs to the current view and leaves other devices independent.
- Expiring, revocable session collaboration links for signed-in organization members, including shared terminal/chat control.
- Session recovery status and durable chat request receipts; terminal reconnection through tmux.
- Existing Kubernetes Secret references for managed database, Redis, encryption and OAuth configuration, with an EKS deployment guide.

### Changed

- **A consistent web experience.** Refined headers, cards, forms and empty states extend the Overview and Work design language to detail screens, Reviews, Inbox, Library and Settings. Prompts and repositories gain search; long lists and filters fit narrow screens.
- **A more usable pod Sessions workspace.** Chat and terminal share a compact header and calmer controls. Narrow windows switch between the two without restarting connections; desktop splits support dragging, keyboard resizing and a saved width. Chat drafts survive a reconnect and the model selector now updates the actual chat model.
- **Settings with a place for everything.** Section navigation for deployment and workspace settings keeps unsaved forms mounted. Prompt, run and dependency dialogs use native modal focus handling, Escape dismissal and consistent surfaces.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Release service images report their release version instead of `dev`, so version checks work after deployment.

### Upgrade notes

- Deploy matching API, web and agent images; pod terminals now require `tmux`. Back up PostgreSQL, the existing encryption key and needed workspace volumes before upgrading.
- Legacy shared pods are not reused as isolated pools. Recreate old interactive sessions before sharing, and save any uncommitted work first. Legacy deployment-wide Git helper credentials are rejected by default.
- Production uses one combined API/web replica with Recreate upgrades. See [the EKS guide](docs/production-eks.md) and [security review](docs/security-review-2026-10.md) for recovery behavior, credential boundaries and retained storage.

### Security

- Partition agent pods, persistent homes and caches by workspace, owner and execution purpose/access profile; give interactive sessions dedicated pods.
- Replace deployment-wide Git credential helper keys with scoped keys and separate agent service accounts from API permissions.
- Preserve interrupted work and require inspection before replaying uncertain executions; enforce one combined API/web replica with Recreate upgrades.

## [0.10.2] - 2026-10-06

### Added

- **Resize the session sidebar.** Drag its edge between 200 and 440 pixels, with a smaller maximum on narrow windows. The width is remembered, double-click resets it, and arrow keys resize it when the handle is focused. The mobile drawer keeps its original width.

### Changed

- **Clearer iOS widgets and Live Activities.** Prominent needs-you and running counts, more breathing room, clearer status rows, and a refreshed Start widget retain the existing session links, reply, snooze, retry, resume, and PR actions.
- **A slimmer session scrollbar.** A thin native thumb keeps a generous grab area, separated from the sidebar resize handle. The session list scrolls independently with its search and header fixed.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- **The terminal no longer adds an unnecessary scrollbar.** Session pages stay within the available screen, and the terminal shows its scrollbar only when there is history to scroll. Chat and terminal history keep their own scrolling.
- **iOS chat reaches the actual bottom.** The down arrow scrolls through the trailing space and dismisses when the view reaches the end, including after expanding a turn's work steps.
- **iOS Overview counts have room to breathe.** Summary cards use consistent padding and continuous corners, with fewer columns for larger accessibility text.

## [0.10.1] - 2026-10-06

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- **New work starts with the trigger again.** The web, iOS, and Android forms return to When → Where → Who → What → Then → Name, so the prompt follows the trigger, location, and runtime. The web review summary follows the same order. The refreshed styling and optional examples are retained.

## [0.10.0] - 2026-10-06

### Changed

- **A refreshed iOS and Android experience.** Warmer light surfaces, clearer dark surfaces, refined status colors, and more readable work rows carry through dashboards, lists, detail screens, and account settings. Section tabs scroll instead of squeezing their labels, summary tiles adapt to the available space, and iOS work metadata accommodates larger accessibility text.
- **Work summaries become filters.** Select Needs you, Running, or Ready on mobile to narrow the Work list, and clear the selection to return to everything. The web has the same actionable summaries, with filters reflected in the URL, clearer empty and error states, and separate links for work, pull requests, and edits.
- **New work starts with the prompt.** Creation on web, iOS, and Android puts What first, followed by When, Where, Who, and Then. Examples stay behind an optional disclosure. The web adds a review summary that links back to each section, with a compact review on phones.
- **A calmer web sidebar.** Clearer workspace and account controls, softer selection states, an expanded Library by default, and keyboard focus handling in the mobile drawer make navigation easier. Saved navigation preferences and Overview usage-limit indicators are retained.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- **Apple Watch: a session appears once across paired servers.** When two servers report the same session on a machine, the Watch list now combines it into one entry (#642).

## [0.9.1] - 2026-10-05

### Changed

- **The New work form opens where you worked last.** It remembered the runtime and its model, but not Where: every new piece of work started in a pod, so machine work meant picking My machine, the machine and the directory again each time. The form now remembers all of it, and opens on your machine and directory when that is where the last work ran (and the machine is still paired). On an install with auth disabled the settings are kept too — before, they were silently dropped there, so nothing was ever remembered.
- The When pills divide into even rows: eight make two rows of four, not six and two, and the rows stay even as trigger types are added.
- The New work and Edit work forms fill the same centred column as every other page instead of a narrower, left-aligned measure.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- **iOS: a reply from Chat reaches Codex.** A message sent from the Chat view of a Codex session on your machine landed in Codex's composer with a newline instead of being sent, so you had to switch to Terminal and press Enter. The app now sends the text and its Enter a beat apart, as the server already does for the web.
- **iOS: the keyboard's Send key sends.** Return in the Chat reply box inserted a newline; the key now reads Send and sends the message.
- **iOS: the conversation opens at the end.** The Chat view opened at the top of the conversation and had to be scrolled down each time. It now opens at the latest message, and when you scroll up a floating arrow takes you back to the end. Task logs, job runs and agent turns get the same.

## [0.9.0] - 2026-10-05

### Added

- **Connections: one logo-picked list of everything work can be connected to.** A Connection is a named account at a service — "Jon's AWS", "Acme Linear" — made of parts: **credentials** (encrypted on the row, never returned; a boot-time heal seals any stored in plain text), **tools** (an MCP server in the pod), **shell env** (vars exported into the agent's own shell, so `aws s3 ls` and SDKs are signed in), and a **note** (a skill telling the agent how to use it). Bare secrets ("credentials only") and hand-written MCP servers ("tools only") are listed with them. New providers **AWS** (keys or the pod's IAM role; optional `awslabs` tools), **Pylon**, **PagerDuty**, and **HTTP API** (any REST API, through a small REST bridge baked into the agent images at `/opt/optio/mcp-bridge.js`); custom MCP servers and HTTP connections now reach pods, and **Test** runs a real health check. Library → **Connections** is the new page (search, kind and owner filters, Test, edit sheet, "Connect" gallery); `/secrets` redirects there, and deployment secrets moved to Settings → **Deployment secrets**. The work form's Environment section becomes one **Connected to** picker with logos and "whose · parts · provider" subtext; the repo page gets **Connected by default**; the agent page shows what it is connected to. `GET /api/connections/catalog` and `catalog` in `GET /api/work/environment` list all three kinds. See `docs/connections.md`.
- **Pylon and PagerDuty as triggers.** Any Job, scheduled Task, Local automation, or persistent agent can start on a Pylon event (per-trigger URL `/api/hooks/pylon/:triggerId` with a shared secret minted on creation and shown once; events matched by name) or a PagerDuty incident event (`/api/webhooks/pagerduty`, signed with `PAGERDUTY_WEBHOOK_SECRET`, filtered by event kind, service, and urgency; the run is ticket-linked to the incident). Trigger payload fields reach the prompt as `{{params}}` like the GitHub, Slack, and Linear events.

### Changed

- **An expired Claude login on a paired machine renews itself.** When the cluster's Claude OAuth token expires, Optio takes a fresh one from a machine running `optio local up`; but a machine where nobody had run `claude` for a while held the same expired token, and the banner asked you to open a terminal. The daemon now runs `claude` once itself, in a scratch directory, when its login is expired or about to be, and hands over the renewed token. Restart `optio local up`. Codex needs no such step: pods sign in with an OpenAI API key or the managed app-server, never a copy of a machine's login.
- **Kill asks right under the button.** Killing a session's process confirms in a small card under the Kill button, like the usage pills, instead of a browser dialog in the middle of the screen. Escape or a click elsewhere cancels; Enter confirms.
- Workspaces can no longer auto-join people by `private.icloud.com`, Apple's new Sign in with Apple relay domain, alongside `privaterelay.appleid.com` (#638).

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- A trigger's secret (webhook, Pylon) is never returned after creation: every trigger list and detail redacts `config.secret` and reports `hasSecret` instead. The Jobs page no longer prints raw trigger config.
- A connection's repo assignments picked in the form are saved (they were silently dropped).

### Changed

- **An expired Claude login on a paired machine renews itself.** When the cluster's Claude OAuth token expires, Optio takes a fresh one from a machine running `optio local up`; but a machine where nobody had run `claude` for a while held the same expired token, and the banner asked you to open a terminal. The daemon now runs `claude` once itself, in a scratch directory, when its login is expired or about to be, and hands over the renewed token. Restart `optio local up`. Codex needs no such step: pods sign in with an OpenAI API key or the managed app-server, never a copy of a machine's login.
- **Kill asks right under the button.** Killing a session's process confirms in a small card under the Kill button, like the usage pills, instead of a browser dialog in the middle of the screen. Escape or a click elsewhere cancels; Enter confirms.
- Workspaces can no longer auto-join people by `private.icloud.com`, Apple's new Sign in with Apple relay domain, alongside `privaterelay.appleid.com` (#638).

## [0.8.0] - 2026-10-04

### Added

- **Config as code.** Every Job, scheduled Task, persistent agent, prompt, repo, MCP server, skill and connection can be a YAML manifest (`apiVersion: optio/v1`, six kinds, names as references, secrets by name and never by value, `*File` fields for long prompts and skill directories). Mount a directory of them (`OPTIO_CONFIG_DIR`; Helm `configAsCode.*`) and the API keeps the workspace matching the files: create, adopt, update, replace, prune. A managed row edited in the UI is put back at the next sync and reported as reverted. **Settings → Config as code** shows the directory, the last sync with every error, **Sync now**, **Preview** and **Export YAML**; managed rows carry a **Managed** chip and a **Download YAML**; `GET /api/config/schema.json` is the JSON Schema for editors and CI. The CLI gains `optio export`, `optio apply -f`, `optio diff -f` and `optio schema` (a CLI apply is a plain upsert that manages nothing). See `docs/config-as-code.md`.
- **New look.** Optio has a mark, Peek, and app icons to match, across the web app, the site, iOS and Android.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- **Codex sessions on your machine have their conversation again.** Codex 0.160 moved its TUI behind a machine-wide app-server daemon that holds every session file open, and changed what it writes in them, so the daemon never found a Codex session: no thread id, an empty Chat view, nothing to resume or backfill. The daemon now matches a Codex to its session by where and when it started, and reads the new session format. Restart `optio local up`.
- **A finished Codex session no longer says "The agent is working".** Codex's TUI keeps repainting after it answers, so the quiet-terminal heuristic never fired and a done session stayed "working", with the Chat reply box warning that your message would queue. The session file marks every turn, and the daemon now takes those as the signal, the way it takes Claude Code's hooks: "needs you" within seconds of a reply, "working" when you send the next message.
- **Replies from Chat reach Codex.** A message sent from the Chat view was typed into Codex with a newline added instead of being sent: the text and its Enter arrived together and Codex read them as a paste. The server now sends the Enter a beat after the text. Web, iOS and Android.
- **Chat keeps a reply's line breaks.** A reply's lines were run together as one paragraph (a haiku on one line). They now break where the agent broke them.
- Helm renders an empty `OPTIO_CONFIG_DIR` when config as code is off.

## [0.7.0] - 2026-10-01

### Added

- **Work until merged.** The New work form's **Then** has a fourth answer for work that opens a PR: **Work until merged**. The agent opens the PR, then Optio brings it back to fix failing CI, merge conflicts, and review feedback, and squash-merges once it's green, whatever the repo's own auto-resume and auto-merge settings say. Untick **Merge it for me** to have the agent keep the PR green and leave the merge to you. Under Then, **What happens to the PR** lists each step (review, CI fixes, requested changes, merge) for any work that opens a PR, so **Exit when done** now shows what the repo's settings will do too. A repo in cautious mode (draft PRs) still never merges. Scheduled Tasks pass the setting to every run, the Work list shows "until merged", and a new **Assign to Optio** preset turns issues labeled `optio` into PRs worked until they merge.
- **Reply from Chat in the web app.** A running session's conversation now has a reply box at the bottom: type and press Enter (Shift+Enter for a new line) and your message goes to the agent as if you had typed it in the terminal. While the agent is mid-turn it says so, and your message waits for it. Until now the web's conversation view was read-only, and replying meant switching back to the terminal.
- **Model providers: run Claude Code and Codex on Amazon Bedrock.** **Settings → Model providers** saves a way for an agent to reach its models other than its usual sign-in. Today that's Amazon Bedrock, for Claude Code (Anthropic models) and Codex (OpenAI models on Bedrock). A provider has a region, the models it offers each agent (suggested Bedrock ids to start from), and how it signs in:
  - **On your machines:** the machine's own AWS credentials, optionally a named AWS profile. No credential ever leaves the server; the daemon reports which AWS profiles the machine has, by name.
  - **In pods:** an AWS access key, a Bedrock API key (both stored encrypted, never shown again), or the pod's own IAM role.

  Once a provider exists, the New work form's Who section gets a **Provider** switch (Default, or the provider) and the model list becomes the provider's. Picking nothing keeps everything as before. It's in the web, iOS and Android apps, for Tasks, scheduled Tasks, Jobs, persistent agents, automations and sessions on your machine. Restart `optio local up` to run providers on a machine; an older daemon refuses such a run rather than quietly using its usual sign-in.

- **Organization or Just me.** Model providers, secrets, connections and work now have an owner: the organization, or one person. Personal work runs with its owner's secrets, providers and connections; everyone still sees it ("Runs as Alice"), but only its owner can change it, run it by hand, message it or change its triggers (an admin can still delete it). Organization work can only use the organization's. Admins add the organization's providers and connections; anyone can add their own. Work on your machine is always yours.
- **Pick the secrets work gets.** Pod work has a **Secrets** row: the agent gets only the secrets you pick (the organization's, or your own for personal work), and you can add one on the spot. A new workspace setting, **Pods get only the secrets work picks**, also stops repo pods from receiving every organization secret for work that picks none.
- **Join a workspace by signing in.** Workspace settings take email domains (`acme.com`): anyone who signs in with a verified email at one of them joins with the role you choose. Public mail domains are refused. Works with Google, GitHub, GitLab and generic OIDC sign-in.
- **Logos.** Work rows, PR and issue links, Reviews and Inbox, trigger lists and the New work form's When section show the GitHub, Slack, Linear, Jira, GitLab and other marks, and pull requests show GitHub's glyph in their state's colour. Web, iOS and Android.

- **The New work form remembers your agent settings.** The runtime you picked last, and for each runtime its model, effort and other parameters (model provider included), are filled in next time you start new work, on any device. Saved when you create work; **Reset** goes back to the defaults.
- **Agent logos** for Claude Code, Codex, Copilot, Gemini, Cursor and OpenCode in the New work form's Who picker and on Work rows.
- **A task can open several PRs.** Every PR a task opens is tracked: the ones its agent's `gh pr create` / `glab mr create` / MCP `create_pull_request` calls created, and any open PR on a branch under the task's (`optio/task-<id>-<slug>`; the prompt now asks for that naming when the work needs more than one PR). The task page lists them once there's more than one, with **Stop tracking** and **Add PR** for one Optio missed. The first stays the PR Optio follows for CI, reviews and merge. `GET /api/tasks/:id` returns them as `prs`.

- **Text size and column width in Chat.** A session's Chat view has A− / A+ and Narrower / Wider controls (and ⌘/Ctrl + = / − / 0), remembered per browser for every chat.
- **Refresh Codex's usage.** The Codex usage pill has a refresh button like Claude's: the machine's daemon asks Codex for its current limits instead of waiting for the next Codex turn. Restart `optio local up` to get it.
- **Environment per piece of work.** The New work form's **Where** has an **Environment** section: pod work can switch the repo's connections, MCP servers and skills on or off, pick its secrets, run its own setup commands before the agent, and make its PR follow-through more careful than the repo's (ask for a review, open draft PRs, resume fewer times), never less. Jobs and persistent agents now get connections, MCP servers and skills like Tasks do.
- **Commands as work.** A Job can run a shell command instead of an agent, in a pod or on a machine, on any trigger: its `{{params}}` arrive as shell variables (never spliced into the command) and its exit status settles the run. A trigger on a machine can open a plain shell.
- **Persistent agents with a repo.** A persistent agent can work in one checkout of one of the workspace's repos, fetched each turn.

### Changed

- **Repo settings on iOS and Android use the live agent picker** (same models and per-model effort levels as New work); New work on mobile starts from the picked repo's defaults.
- **Repo settings pick the agent the way New work does.** The repo page's default agent and its model, effort and other parameters use the same picker as the New work form, with the same live model and effort options; the new-repo wizard offers every agent. Picking a repo in New work starts from the repo's defaults ("Repo defaults · Reset"); a repo's own defaults win over your remembered settings for pod work on it. The repo settings and new-repo pages are refreshed to the newer layout.
- **Every effort level Claude supports.** The Claude Code effort picker now offers Low, Medium, High, Extra high and Max, narrowed to what the chosen model takes, and it's hidden for models without an effort setting (Haiku 4.5, Sonnet 4.5). Optio reads each model's levels from Anthropic's Models API (`capabilities.effort`) along with the model list; on a machine, an effort the installed `claude` doesn't list is left out instead of stopping it from starting.
- **Logos are one colour.** Slack, Claude and Gemini follow the text colour like every other mark; only pull request and issue glyphs keep their state colours.
- **Transcript ⇄ Screen is now Chat ⇄ Terminal**, on the web, iOS and Android, matching the Chat · Terminal tabs of pod sessions. The toggle now shows up as soon as a Claude Code or Codex session starts, before the agent has said anything, with "Nothing yet" until the first message lands. On a phone-width browser, a session with a conversation opens on Chat, as it does in the iOS and Android apps.
- **One pod for the API and the web UI.** The Helm chart runs the web UI as a second container in the API's pod instead of its own Deployment, so there is one rollout and one pod to schedule, and the web server reaches the API over localhost. The web UI follows the API's replicas, autoscaling, disruption budget, anti-affinity and node selector; `web.replicas`, `web.autoscaling`, `web.pdb`, `web.antiAffinity` and `web.nodeSelector` are gone. The `optio-web` Service still exists. To restart both, restart `deployment/optio-api`.
- **The operations assistant pod is off by default** (`optio.enabled: false`). Nothing in Optio needs it; set it to `true` to keep running it. The local setup and update scripts no longer build its image.
- **Sessions stay put in the Machines list.** Sessions used to be grouped by Needs you / Working / Idle, so with many of them flipping between states the list kept moving under your cursor. It is now ordered by when you last typed into a session, then by when it started, with finished sessions below; a session that needs you is marked on its row, and the count in the header jumps to the next one. Same on iOS and Android.
- **Personal secrets follow the work's owner, not its creator.** A run used to look up the creator's own secrets first. It now does that only for work that belongs to someone ("Just me"), and organization work never sees anyone's personal secrets, agent sign-in included. Set work you rely on personal secrets for to **Just me**.
- Members can now add their own (personal) secrets and connections; the organization's still need an admin.
- **One backend for Work.** Scheduled Tasks, Jobs and Local automations are now one `work_definitions` table, and Job runs are rows in `tasks` (`kind = 'standalone'`), with one log table and one pod table under them. `/api/work` lists, creates, saves and deletes every kind (create and save write the trigger in the same transaction). Every legacy endpoint keeps its response shape. Five migrations move the data on first boot; back up the database before upgrading.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- **Max effort now reaches pod runs.** Optio passed effort to pods through Claude Code's `effortLevel` setting, which only persists up to Extra high, so Max was silently dropped. Pods now also get `CLAUDE_CODE_EFFORT_LEVEL`, which takes every level.
- **No more "Extended thinking" toggle.** Claude Code always thinks (its default; adaptive thinking on current models, steered by effort), and turning it off made any run with an effort level fail. The toggle is gone from the New work form, repo settings, and the iOS and Android apps; a saved value is ignored.
- **PRs an agent only mentions are no longer adopted.** A task used to take the last PR link in its agent's output for its own repo, so `gh pr view 812` or "like #812" could make an unrelated PR the task's, and on your machine the first PR link the session printed won. Optio now adopts a PR only from the result of the agent's own PR-creating call (or a PR on the task's branch), checks it with GitHub / GitLab / CodeCommit (right repo, open or merged, new or on the task's branch), and still shows other links as links.

## [0.6.5] - 2026-09-28

### Added

- **Codex sessions have a Transcript too.** Opening a Codex session now offers the same **Transcript ⇄ Screen** toggle as Claude Code: your prompts, Codex's replies, its reasoning summaries, and every command or patch with its output, readable at any width. It works for Codex started by Optio and for `codex` typed into a shell on your machine. The daemon reads Codex's own session file (the one the running `codex` process holds open), so nothing needs configuring. Codex runs now report their session id too, so **Resume chat** works for them, a headless Codex task that gets review feedback resumes one-shot (`codex exec resume`), and a finished Codex session's conversation can be read back off the machine like a Claude Code one's. Restart `optio local up` to pick this up.
- **Linear triggers can skip your own tickets.** A Linear trigger's new **Only tickets from someone else** option ignores issues you created and changes you made yourself, like filing a ticket assigned to you or assigning one to yourself. A ticket someone else creates for you, or assigns to you, still starts the work. It's in the New work form, the Machines automations editor, and the iOS and Android forms, and needs your Linear name, handle or user id.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- **Scrolling back in a session.** Opening a long-running Claude Code session (after a reload, switching sessions, another device, or a reconnect) could leave the wheel, a trackpad or a finger drag scrolling nothing. A viewer got only the last 512 KB of the session's output, and Claude Code turns on its fullscreen mode and mouse reporting once, at startup. A viewer now gets the terminal as it stands, rebuilt from the daemon's model of the screen, with the program's modes. Restart `optio local up` to pick this up. Also:
  - On a phone or tablet in the web app, a finger drag now scrolls Claude Code.
  - The iOS Transcript no longer jumps back to the bottom every few seconds while you read back through a running session.
  - The iOS Screen view no longer comes back blank and unscrollable after you switch to the Transcript and back.
  - Android's Transcript no longer pulls you down while you read up through a long last message.
- **Codex's lines around the prompt.** The tinted band Codex draws around where you type, and the `────` rules between turns, could look broken in the web terminal: part of the band was left untinted after you opened a session in the middle of a turn, rows landed at the wrong width when the session had been sized for another screen, and xterm's HTML renderer left seams between the band's rows and ticks along the rules at some zoom levels. Sessions now open exactly as they were drawn, and the web terminal draws with WebGL where the browser supports it, falling back to the HTML renderer otherwise.
- **Messages you didn't send no longer show as yours** in a session's Transcript. Claude Code files some messages as your turns: a background task or agent reporting back, a message from another agent session, the summary that replaces a compacted conversation, an interruption. These now show as notes saying what they are, and a session's launch prompt (from the New work form or an automation) shows as **Prompt**. Conversations recorded before this read correctly too.

## [0.6.4] - 2026-09-26

### Added

- **Slack bots can start work.** A Slack trigger's new **Posted by** setting takes bots (apps, integrations, incoming webhooks: an alerting tool, say) or anyone, not just people, and **Bot** narrows it to one bot by the name on its posts or its id. So "when the alert bot posts in #alerts, start a Codex session to debug it" is a Slack trigger with the channel, **Posted by: Bots** and the bot's name. A bot's `{{text}}` includes what its attachments and blocks say, where alerting tools put the details, and `{{botName}}` names the bot. Posts by Optio's own Slack app never start anything. Triggers keep firing only for people unless you change the setting.
- **Codex can skip every check on your machine.** For a Codex run on a machine, the New work form's **Permissions** has **Skip all checks**, which starts Codex with `--yolo` (`--dangerously-bypass-approvals-and-sandbox`: no approval prompts, no sandbox), for new, one-shot and resumed sessions alike. Left at **Default**, Codex keeps the machine's own settings. Claude Code's **Skip all checks** (`--dangerously-skip-permissions`) was already there. The iOS and Android forms now show **Permissions** and **Reasoning effort** for runs on a machine too, where they showed only the model. Restart `optio local up` to pick this up.

### Changed

- **A session fits the screen you open it on.** Opening a session, bringing its tab to the front, or coming back to it after a minute away resizes the terminal to that screen, with no need to click **Use this screen**. A screen that is showing the session and was used in the last minute keeps its size, so glancing from your phone at a laptop you're working at doesn't squeeze the laptop down to phone width. The newcomer then shows the laptop's layout scaled down, with **Use this screen**, and typing or clicking there still takes it. The server decides which screen that is (it knows every screen viewing a session), and a laptop that went to sleep with the session open stops counting within seconds. Same in the iOS and Android apps, on the Screen face.
- **The iOS Live Activity looks like the Work widget.** Its top row is the widget's counts: Need you and Running, plus Waiting, Recurring, and Agents. When more than one session needs you, it lists them instead of showing only the oldest: each row has its status (**Allow?**, **Reply**, **Conflict**…), how long it has waited, and a **Later** button, and tapping a row opens that session. Up to three are listed, else the oldest two and "+N more". A single waiting session is still shown in full with **Reply…** and **Later**. When nothing needs you, it lists what's running the same way, newest first. The Dynamic Island shows how many need you and how many are running, and lists the same sessions when expanded.
- **iOS Live Activity and widgets** read cleanly at any width and text size. Status words, timers, counts, and chip values always show in full; only titles and reasons shorten. A widget lists as many sessions as fit.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- **Copying from a session in the web UI.** With Claude Code in fullscreen mode, a drag selects in Claude Code rather than in the terminal, and Claude Code copies the selection with an escape sequence (OSC 52) that the web terminal ignored. Now a drag followed by ⌘C copies it (in Chrome it's on the clipboard as soon as you let go), and ⌥-drag selects in the terminal itself. The same goes for `/copy` and for tmux and vim copying. Pod sessions get the same fix.
- The iOS app no longer puts text back on the clipboard when you open a session that copied something earlier, and a program in a session can no longer read your phone's clipboard.
- On Android, editing a Local automation shows its model and permission settings, and saving applies changes to them; the edit form used to leave them out.
- A screen whose size already matched the session's no longer showed **Sized for another device**, and **Use this screen** no longer resized the session twice.
- A web terminal no longer answered queries replayed from a session's history (a cursor-position or terminal-identity request from when the program started). The stray answers reached the program as input, and opening a second window could take the session's size.
- **Later** on the iOS Live Activity takes effect at once: the activity moves on to the next session waiting, or shows the session as running when it was the only one. It used to look like nothing happened until the app refreshed, and a lone waiting session stayed put even then. **Resume** and **Retry** update it right away too, and **Later** from a notification does the same. On Android, **Later** on the only waiting session now moves the Watch on as well.

## [0.6.3] - 2026-09-24

### Changed

- Links in a session open on **⌘-click** (Ctrl-click off a Mac), straight into a new tab. Clicking a link no longer asks "Do you want to navigate to…?" every time, and a plain click stays a click in the terminal. On a touch screen a tap still opens it.

## [0.6.2] - 2026-09-24

### Added

- **Codex's own models and effort levels** — each machine's daemon asks its Codex which models it offers (`codex debug models`) and reports them with their reasoning efforts, so the New work form lists the latest Codex models (GPT-5.6-Sol, -Terra, -Luna, …) as Codex does, and a **Reasoning effort** picker shows only the levels the chosen model takes. A run on a machine uses that machine's list. Codex runs in pods now get the model and effort too; they used to run Codex's default model. Restart `optio local up` to pick this up.
- **Codex limits in sessions** — a Codex session's header shows Codex's 5-hour and weekly limits (from its session log, updated after each turn). A plain terminal on a machine where Codex ran recently shows them next to Claude's.
- Runs on a machine can set the **effort** (Claude Code and Codex) and, for Claude Code, the **permission mode**.
- A **Sessions** button on the Work list opens the session screen at the session that has waited on you longest, else the most recently active one.

### Changed

- Claude Code agents on your machine start in **auto** permission mode (`--permission-mode auto`): Claude's classifier approves routine edits and commands and blocks risky ones, so an agent no longer stalls on permission prompts. A headless run could previously do nothing that needed approval. Choose **Skip all checks** (`--dangerously-skip-permissions`) or **Ask first** per run in the New work form. A Claude Code too old for auto mode starts in its own default. Restart `optio local up` to pick this up.
- A session started by a trigger names its source on its badge (GitHub, Slack, Linear, schedule, webhook) instead of "trigger".
- PR and ticket badges are a size larger.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- **Killing a session** leaves it in Finished. Its last hook or shutdown output used to put it back under Working, and an automation's session landed in Needs you on exit. The run behind a killed session now ends cleanly: an interactive run completes (closing it is how it ends), and a headless run stops without a retry. Before, the kill's non-zero exit failed the run, which could retry.
- The same PR no longer shows as two badges (a bare `#607` and its URL, or the PR a review-request automation started for), and a PR URL ending a line no longer picks up digits from the next one (`#612` showing up again as `#61219`).
- Codex runs no longer pick up the repo's Copilot model and effort, which share its settings columns.
- **⌥↑ / ⌥↓ in the web terminal on a Mac** reached the program as Ctrl+↑ / Ctrl+↓, so Codex's "answer the question" key (⌥↑) did nothing. xterm.js mistook the web bundle for Node and dropped all its Mac key handling, which also sent Option-typed characters as Esc+letter.

## [0.6.1] - 2026-09-24

### Added

- **Add machine** on the Machines page walks through pairing a computer with Optio Local: the commands come with this server's URL filled in (sign-in is skipped when auth is off), and the page says when the machine connects. `@optio/cli` isn't on npm yet, so the steps — and the READMEs — build it from a checkout.
- **Directories from the UI** — add and remove a machine's directories from its card on the Machines page, or with **+ Add a directory…** in the New work form. The machine's daemon makes the change, as `optio local add` would there (it expands `~`, checks the directory exists, and detects its git remote); `optio local up --no-remote-dirs` keeps a machine's list local-only. Restart `optio local up` on each machine to pick this up.
- **"Always the latest" models** — the Optio agent's model picker reads the live model list and offers each family's alias ("Opus · now Opus 5.5") above the specific versions.

### Changed

- The Optio agent defaults to **Opus** — the newest one — instead of Sonnet. Settings you've already saved keep their model.
- Model aliases follow the live model list: "opus", "sonnet", and "fable" mean the newest model of that family the configured key can see, and each family lists newest first, so "(latest)" is right in every model picker.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- "My machine" in the New work form dead-ended in an empty Machine list and a "Pick a directory…" placeholder when no machine was paired (the Interactive chat and Terminal examples picked it anyway); it now shows how to pair one and picks the machine up when it connects.
- The Optio agent's model could only be saved as opus, sonnet, or haiku — picking Fable failed to save; any Claude model id is accepted now.
- A provider's list-models probe times out instead of holding a request open when the provider doesn't answer.

## [0.6.0] - 2026-09-23

### Added

- **Optio for iOS** — a native SwiftUI app (`apps/ios`): the Overview board, the Work feed and a native New work form with every option the web form has, Optio Local terminals with Transcript and Screen faces, Insights, persistent agents, and pod sessions. Sign-in pairs the device with a personal access token. Widgets, Controls, App Intents, a Live Activity and Dynamic Island, notifications over APNs, alternate app icons, and two windows on iPad. Its models are generated from the shared TypeScript types (`pnpm gen:swift`, checked in CI) (#597, #598, #600, #603, #606, #613).
- **Optio for Android** — a native Kotlin + Jetpack Compose app at parity with iOS (`apps/android`), with notifications you can reply to, widgets, Quick Settings tiles, multiple servers, and `optio://` links. The API sends push over **FCM** alongside APNs (optional; see `docs/android-push.md`), and `pnpm gen:kotlin` generates the app's models (#618).
- **Run Tasks and Jobs on your own machine** — every Task, Job, and scheduled Task has a run location (`cluster`, or `local` with a host, directory, and session mode). Local runs go to the Optio Local daemon as agent terminals, and the terminal drives the run's state (#590).
- **Local automations on events** — GitHub, Slack, and Linear event triggers with signed ingress, interactive or headless session modes, saved prompts as the command, and resume of an exited agent session.
- **Personal access tokens** are created and revoked in Settings.
- **Full agent parameters for every pod run** — Jobs and persistent agents keep `agent_options` (effort, thinking, context window, approval mode, …) the way Tasks do (#599).
- **Run names from trigger params** — recurring work can name each run from its trigger's `{{params}}`, e.g. `Triage: {{ticketTitle}}` (#617).
- **Optio Local** (restart `optio local up` on each machine to pick these up):
  - A finished agent session reads back as its full conversation. Sessions recorded before transcripts existed are backfilled from Claude Code's own log by the machine's daemon (#591, #619).
  - An exited terminal replays its final screen at its recorded size (#587).
  - The terminal follows whoever is typing; other viewers see it scaled to fit.
  - A machine keeps its identity when its hostname changes, and Machines can merge an offline duplicate into the machine it became (#619).
  - The Claude OAuth token can be refreshed from a paired machine's daemon (#593).
- **Per-model 7-day usage limits** (Claude Fable) in the usage widgets (#592).
- The pod session chat is one Claude conversation across turns and reconnects (#602).

### Changed

- **One noun: Work.** Tasks, Jobs, scheduled Tasks, Local automations, terminals, and persistent agents are all presented as **work** with five attributes: **When** (now, a schedule, a webhook, a ticket, a GitHub / Slack / Linear event, or messages), **Where** (an Optio pod, with or without a repo, or a directory on your own machine), **Who** (a terminal or an agent runtime and its parameters), **What** (the prompt), and **Then** (exits when done, waits for me, or a persistent agent). `/work` is the one feed (Active · Recurring · Agents · History) and `/work/new` the one form; recurring work is edited in the same form at `/work/:id/edit`. The sidebar is **Overview · Work · Reviews · Inbox**, then **Library** (Prompts · Repos · Machines · Connections). The per-kind list and creation pages, and the interim `/sessions` pages, redirect; detail pages stay (#594, #599, #601, #615).
- **One trigger layer.** Every trigger type attaches to every kind of work — a GitHub event can start a Job or a scheduled Task in a pod as well as an automation on your machine — through one CRUD and one dispatcher, and a definition can carry several triggers of one type (#615, #616).
- **Overview** opens with a board built from the Work feed (needs you, live, recurring, agents), then usage limits, recent runs, and activity (#594).
- **Machines** is a Library page for paired computers and their automations (#594).
- A denser sidebar with collapsible groups; admin pages moved to the user menu.
- The README, docs, examples, and marketing site are rewritten around the work model (#604, #610, #614).

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Opening a Local session from Work (or any other list page) stuck on "connecting…" until a reload: those pages carried the build-time API URL (#612).
- **Issues** names the repos and ticket providers it couldn't read, such as a stale `GITHUB_TOKEN`, instead of showing an empty list (#611).
- GitHub, Slack, and Linear webhooks were rejected with 401 when auth was enabled (#618).
- WebSocket messages sent before authentication finished were dropped, which kept `optio local up` from connecting to an auth-enabled API (#618).
- Pod session chat dropped a message sent right after connecting, replayed events out of order, and reset its cost on reconnect (#618).
- `GET /api/activity`, cost filtering by repo, and deleting a trigger that had started runs returned 500; raw database timestamps reached JSON, which kept iOS from loading an agent with a pending message (#618).
- **Resume chat** on a finished Local session opens the resume already in progress instead of starting another, and says when the machine is offline (#619).
- The New work form's answers reach the API intact: pod kinds were rejected, a pod session lost its name, a new branch on a machine was dropped, ticket triggers on Jobs and agents never fired, and unnamed work was always "Session 2" (#599, #601).
- A revoked Claude token is detected, so the automatic refresh from a paired machine fires (#617).
- Local terminals: a stale echo of our own resize no longer hides the bottom rows (#588); previews and PR links are read off a screen model, so full-screen agents no longer produce bogus PR badges (#608); the session title no longer runs into the status dot (#589); the usage pill stays visible when the usage read fails (#605).
- Local session and Job run spend count in Insights costs (#595).
- The per-IP API rate limit is configurable (`OPTIO_RATE_LIMIT_MAX`, default 600/min), so the mobile apps' polling no longer trips 429s (#596).

### Security

- `/api/webhooks/slack/actions` now verifies Slack's signature. **Deployments that use the Slack action buttons must set `SLACK_SIGNING_SECRET`** (#618).

## [0.5.0] - 2026-09-18

### Added

- **Optio Local** — terminals on your own machine, managed from the web UI at `/local`. The CLI daemon (`optio local up`) makes one outbound WebSocket to the server, advertises a directory allowlist, and runs PTYs; the browser attaches over a relay. Attention detection is layered (Claude Code hooks → bell → silence) and drives a "needs you" queue. Local Blueprints spawn terminals from webhook/schedule/ticket triggers with shell-quoted params. See [docs/optio-local.md](docs/optio-local.md).
- **Local cockpit UX** — split view (up to three terminals side by side or stacked), a session rail with PR/ticket badges and link-aware search, Shift+Enter for newlines in agent REPLs, a collapsible rail (`⌃⇧B`), inline session rename, a single status dot per header that folds lifecycle and attention into one color, and headers that collapse by pane width so the title always keeps its text.
- **Attention from another tab** — the favicon shows the focused session's status (yellow needs you / green working / grey quiet), the tab title carries a `(N)` needs-you count, and a per-session bell arms a browser notification for when that session needs input.
- **Usage in the terminal header** — Claude's 5-hour / 7-day account limits as a gauge pill with a hover card and a manual refresh (`GET /api/auth/usage?fresh=1` bypasses the 5-minute cache), and a per-session tokens/cost chip summed by the daemon from the Claude Code transcript. A `claude` shim on every spawned terminal's PATH gives a hand-launched Claude Code the same hooks as an agent spawn.
- **Overview redesign** — the dashboard now opens with a cross-concept **Needs you** strip, then a **Usage limits** panel showing Claude next to **Codex** (the daemon reads Codex's newest rate-limit snapshot from its session logs, no token leaves the laptop), a **Live** panel of every open terminal, session, and awake agent, per-concept stats strips with **Local** as a peer, quiet concepts folded into one line, and a **Recent** feed mixing repo tasks, job runs, and persistent-agent turns via `GET /api/runs/recent`.
- **Cursor (`cursor-agent`)** as a supported agent type.
- **Workspace RBAC** enforced across the API and WebSockets: viewers are read-only on all mutating routes, member/admin gates on the rest, and workspace scoping on activity, log streams, persistent agents, jobs, connections, and webhooks (#574, #575, #576).
- **Deterministic test tiers** — integration tests against real Postgres + Redis, a full-pipeline e2e tier with a fake agent runtime, Playwright web e2e, and a live smoke harness.
- **Opt-in rootless mode** for agent StatefulSet pods; a storage class setting for the built-in Postgres PVC (#577); `--check` mode for `update-claude-auth.sh`.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Agent prompt arguments are shell-quoted everywhere they reach a shell; PR-open task state is cleaned safely (#555, #558).
- Scraped PR URLs are verified against the git platform before a task enters `pr_opened` (#561); in-pod agents are terminated on cancel and post-cancel PR adoption is guarded (#564).
- Runs fail on terminal Claude API errors instead of being marked Done (#563); cost accumulates across resumes and survives bare retries (#573).
- Tasks created by webhooks, tickets, and subtasks get a `workspace_id` (#560); missing secrets fail provisioning permanently instead of retrying forever (#569).
- Schedule triggers compute `nextFireAt` again (#568); cancelled standalone runs are no longer auto-retried (#567).
- Setup re-runs no longer rotate the encryption key, and decrypt failures are actionable (#562); built-in connection providers stop duplicating on restart.
- GitHub rate limiting is respected (#546); the enterprise security posture is hardened (#545); Gemini/Vertex credentials count as setup-complete signals.
- Agent images pin CLIs to work around a Bun exec crash (#566) and install the Codex CLI (#559); the web production build excludes e2e files (#578); log catch-up replay frames are ignored in the web log view (#535).

## [0.4.1] - 2026-06-11

### Added

- **AWS CodeCommit** as a third supported git platform alongside GitHub and GitLab. Auths via AWS access keys or IRSA/instance profile on EKS; PR ops go through `@aws-sdk/client-codecommit`. CI checks return `[]` (auto-merge fires on `checksStatus="none"`); `reviewTrigger="on_pr"` is recommended over the default `on_ci_pass` (#529).
- **Ruby and Dart agent image presets** — new language-specific base images available in the agent image picker (#470).
- **Live model discovery** — agent model lists are now fetched directly from provider APIs at runtime rather than being hard-coded, so newly released models appear automatically (#543).
- **Claude Fable 5 and GitHub Copilot** added as supported agent vendors (#542).

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Git token resolution in repo pods is now more resilient against transient credential lookup failures (#525).
- `scope='global'` secrets now correctly enforce `workspace_id IS NULL` in the database, preventing a constraint mismatch that could cause secret lookups to fail (#509).
- Missing `auth.oidc` block validation added to the Helm chart, preventing silent misconfiguration when using generic OIDC login (#528).

## [0.4.0] - 2026-04-27

### Added

- **Persistent Agents** — a third Task tier alongside Repo Tasks and Standalone Tasks. Long-lived, named, message-driven agents that wake on user messages, agent messages, webhooks, cron ticks, or ticket events. Each agent has a stable slug, addressable by other agents in the same workspace via an inter-agent HTTP API. Three configurable pod lifecycle modes: `always-on`, `sticky` (default, with idle warm window), and `on-demand`. Cyclic state machine reconciled by the existing K8s-style control plane (now a fourth `RunKind`: `persistent-agent`). New `/agents` UI with chat, turn history, live activity stream, and pause/resume/restart/archive controls (#510). See [docs/persistent-agents.md](docs/persistent-agents.md) and the four-agent demo in [demos/the-forge](demos/the-forge/README.md).
- **Issues** as a top-level nav item — the GitHub Issues queue is now its own page at `/issues`, fanning out across multiple configured ticket providers.
- **Reviews** as a top-level nav item — code-review subtasks plus external PR reviews now live at `/reviews` (and `/reviews/:id`), with their own reconciler `RunKind` (`pr-review`).
- **Workspace member management UI** — invite, list, and remove workspace members by email with a server-side duplicate-member 409 guard (#496, #499).
- **Agent-aware review configuration** — pick the review agent type per repo so reviews can run on a different vendor than the authoring agent (#504).
- **Skills marketplace** — install skills from any git URL, with agent-typed scoping and a multi-file skill-directory layout so a single skill can target one or many agent types.
- **Persistent Agents and Sessions stats bars** on the overview page (#521).
- **Persisted session chat history** — re-opening a session now shows the prior conversation (#517).
- **Rich rendering in the agent log viewer** — markdown tables and rich blocks render in agent text output (#520).
- **Examples directory** — runnable, self-contained agent configurations under [`examples/`](examples/README.md), starting with two Persistent Agent setups (Forge and Mars Mission Control). Each example is idempotent — re-running `setup.sh` is safe.

### Changed

- **Sidebar nav reorganized.** The hub-and-tabs `/tasks` page is gone. Each tier has its own dedicated route, grouped into **Run** (Tasks · Jobs · Reviews · Issues · Scheduled) and **Live** (Agents · Sessions). The Library group renamed "Templates" to **Prompts** to free that label. Legacy `/tasks?tab=…` URLs redirect to the dedicated pages.
- **User-facing names finalised.** Repo Tasks → **Tasks**; Standalone Tasks → **Jobs** (matching the existing `/api/jobs` URL); PR Reviews → **Reviews**; Persistent Agents → **Agents**; Templates (in the Library) → **Prompts**. Backend table names (`tasks`, `task_configs`, `workflows`, `prompt_templates`) are unchanged.
- **Setup wizard defaults agent secrets to global scope** with an explicit scope toggle, reducing per-user secret sprawl for the common case (#503).
- **README leads with differentiation** — self-hosted, BYO-K8s, multi-vendor — to better orient first-time readers (#519).

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Sessions: stop echoing the agent's final line in the chat view (#516).
- Auth: `/me` now returns the enriched user object with the caller's workspace role attached (#508).

### Migration notes

> Upgrading from 0.3.x — there are no required user actions. URL/nav changes:
>
> - `/tasks?tab=standalone` → `/jobs` (auto-redirected)
> - `/tasks?tab=issues` → `/issues` (auto-redirected)
> - `/tasks?tab=prs` → `/reviews` (auto-redirected)
> - The "Templates" sidebar item is now labeled **Prompts** but still points to `/templates`.
> - The new `/agents` route requires the v0.4 schema migration (`1777200001_persistent_agents.sql`) — applied automatically on API startup.
>
> No data migration is needed. Existing tasks, workflows, triggers, and templates continue to work unchanged.

## [0.3.2] - 2026-04-24

### Added

- **External PR auto-review** — review agent for PRs on external repos with chat + one-click merge, lifted into its own primitive alongside task-generated reviews.
- **Google Vertex AI authentication mode for Claude Code** — route Claude through GCP Vertex AI using `CLAUDE_VERTEX_PROJECT_ID` / `CLAUDE_VERTEX_REGION` and an optional (encrypted, global-scope) service account key, with workload-identity fallback (#478).
- **Workload identity support** for agent pods, plus fixes to repo pod lifecycle (#486).
- **User-scoped secrets** — keep identity tokens out of the pod env and scope them per user (#474).
- **Secrets injected into pod env for setup commands** (#471), and an OAuth refresh widget on `/secrets` that hides the banner when visible.
- **Resume stopped agents on chat message** — sending a chat message to a stopped task resumes the agent (#488).
- **Multi-repo + multi-tracker ticket integration** — redesigned setup flow (#489).
- **Dynamic per-provider model & options picker** with a refresh button for agent settings (#493).
- **Gemini model options** updated with new preview models (#490).
- **GKE & Gateway deployment enhancements** in the Helm chart (#461).
- **Diagnostic logging for raw error detection** in agent adapters (#467).

### Changed

- **PR reviews folded into the Tasks page** — removed the sidebar duplicate; task and PR-review detail views now share primitives (#494, #485, f1a6da4).
- **Repo settings page** — split external PR review out and tabified agent settings (#487).
- **Standalone Tasks pipeline stats bar** restored on the overview page.
- **Opus model option bumped from 4.6 to 4.7** (#491).

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Reconciler: guard PR-reactive actions (auto-merge, complete-on-merge, review launch) to coding tasks only so external PR reviews don't trip them (#480).
- Reviews: stop writing external PR URLs to `pr_review` task rows (#481).
- Secrets: downgrade `scope='user'` to `'global'` when auth is disabled.
- API: derive Claude/Codex/Gemini mode from secret names on public `/setup/status` (#477).
- Auth: add OIDC routes to public auth routes so login works before a session exists (#479).
- Helm: restore `chown` capabilities in postgres init containers (#482); fix postgres volume permissions and decouple `isSetUp` from runtime health (#472).
- Images: change agent user UID from 1000 to 1001 to avoid conflicts on managed node images (#466).
- Gemini agent: settings validation, parser crash, and exit-code inference (#463).
- Correct sub-hour timezone drift in `getETDate` (#462).

## [0.3.1] - 2026-04-20

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Ticket sync: fall back to the configured GitHub App (or `GITHUB_TOKEN` PAT) when a GitHub ticket provider has no inline token or provider-specific secret. Previously sync hard-failed with `"GitHub provider requires token, owner, and repo in config"` even when a GitHub App was fully configured (#458).

## [0.3.0] - 2026-04-20

### Added

- **Pooled standalone-task pods** — runs within a workflow now share pods, scaling out to `workflows.maxPodInstances` replicas each hosting up to `workflows.maxAgentsPerPod` concurrent runs (mirrors repo pod scaling). Runs track assigned pods via `workflow_runs.pod_id` with `last_pod_id` for retry affinity, and pool selection follows preferred → least-loaded → scale-up → overflow. Fixes a leak where a burst of triggers would spawn one pod per run even though only a few ran at once.

### Changed

- **Reconciliation control plane is now authoritative** — the K8s-style reconciler (shadow mode in 0.2.0) now owns PR-driven transitions, auto-merge, complete-on-merge, fail-on-close, auto-resume, review launch, stall detection, pod-death detection, and control intent (cancel/retry/resume/restart) for both Repo Tasks and Standalone Tasks.
- **Shared auth banner, state badge, and metadata card** across task pages for a consistent UX.

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Reconciler: clear stale `finishedAt` when retrying a standalone run.
- Reconciler: use unique jobIds for executor enqueues to prevent BullMQ dedup collisions.
- Agent adapters: include `cache_read` and `cache_creation` tokens in input totals (#457).
- API: trigger auth banner when the usage endpoint detects an expired OAuth token (#455).
- API: detect Claude auth failures mid-run in standalone task runs and override nominally-successful exit codes.

### Docs

- Document the unified reconciler and the Repo vs Standalone Task model.

## [0.2.0] - 2026-04-17

### Added

- **Unified Task model** — single polymorphic `/api/tasks` HTTP resource covering Repo Tasks, Repo Task blueprints, and Standalone Tasks; unified resolver across `tasks`, `task_configs`, and `workflows`
- **Standalone Tasks (Agent Workflows)** — agent runs with no repo checkout, `{{PARAM}}` prompt templates, four trigger types (manual / schedule / webhook / ticket), isolated pod execution, WebSocket log streaming, auto-retry with exponential backoff, clone, visual editors, search and filters
- **Connections** — external service integrations via MCP with built-in providers (Notion, GitHub, Slack, Linear, PostgreSQL, Sentry, Filesystem) plus custom MCP servers and HTTP APIs; three-layer model of providers → connections → per-repo/agent-type assignments
- **Reconciliation control plane (shadow mode)** — K8s-style reconciler for task and pod state, running in observe-only mode
- **StatefulSets for repo pods, Jobs for workflow pods** — native K8s controllers replace ad-hoc pod management
- **Generic OIDC OAuth provider** — self-hosted SSO via `OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET`
- **OpenTelemetry instrumentation** — Fastify HTTP metrics plugin and wired-up callsites
- **OpenAPI + Swagger UI at `/docs`** — Zod type-provider migration across all routes (10-phase rollout covering tasks, workflows, repos, sessions, PR reviews, issues, workspaces, notifications, analytics, setup, secrets, optio, cluster, auth, GitHub)
- **Workspace-level audit log and activity feed**
- **Outbound webhooks** — fire on workflow run events with UI management
- **Expanded dashboard analytics** — performance, agents, and failure insights
- **Planning mode** and message bar improvements for agent interaction
- **OpenClaw agent runtime** adapter
- **OpenCode custom OpenAI-compatible endpoints**
- **Multi-arch image publishing** — amd64 + arm64 for all service and agent images
- **Ticket trigger UI** in TriggerSelector and task forms
- **Ticket-provider auth failure handling** — surfaced in UI with auto-disable
- **Stale Claude OAuth token detection** — surface before 401s
- **nodeSelector and tolerations** for api, web, optio, postgres, redis, and agent pods
- **`OPTIO_ALLOW_PRIVATE_URLS`** — SSRF-check bypass for private network integrations

### Changed

- **Overview panel redesign** — reordered sections, side-by-side recent tasks and pods, responsive multi-column / masonry grid with auto-fit minmax
- **Replaced connections modal with inline form**
- **Renamed "Workflows" to "Agent Workflows"** in UI; docs consolidate Schedules + Workflows into a unified Tasks section
- **Removed redundant templates and schedules** — superseded by agent workflows
- **Workflow tables replaced** with new Workflows data model

### Removed

- Top Failures and Performance dashboard panels
- "N tasks failed today" dashboard banner

### Fixed

- Ask Optio's `list_repos` controller tool returned nothing on a deployment with auth disabled: the assistant's session carries no workspace while every repo row does. A principal without a workspace now sees every repo, as `GET /api/repos` does.
- Ask Optio turns in the API pod had no controller MCP tools: the `.mcp.json` named `/opt/optio/controller-mcp.js`, which only the agent images carried. The API image now bakes in the same MCP bridge bundle.

- Classify agent auth failures as run failures rather than global failures
- Escalate repo tasks to `needs_attention` when the agent completes without opening a PR
- Prevent false task failures when agent creates a PR but exits non-zero
- Detect and clean up zombie `workflow_runs` with terminated pods
- Six K8s infra bugs blocking standalone/scheduled runs and repo pods
- Pod `securityContext` and explicit UID for PVC permissions on GKE
- Re-read task state before orphan reconciliation transitions
- Use `KubernetesObjectApi` for merge-patch annotations; fix scale API
- Persist workflow run logs and publish to per-run channel
- Allow access to workflows with null `workspaceId`
- Treat empty-string env vars as missing in `parseInt` parsing
- JSON.parse error handling for agent scheduling env vars
- Health check passes when ClusterRole is not deployed
- Record GitHub 401s to `auth_events` for banner detection
- Dismiss GitHub/Claude token banners immediately after save
- Clear stale auth-failure banner when token is updated
- Scope auth failure detection to distinguish provider vs global token failures
- Replace Drizzle `migrate()` with hash-based runner; add missing 0046 migration entry to Drizzle journal
- Merge new chart defaults on `update-local` upgrade
- Rename `/docs/guides/workflows` route to `/docs/guides/standalone-tasks`

## [0.1.0] - 2026-03-24

### Added

- **Pod-per-repo architecture** — long-lived Kubernetes pods with git worktrees for concurrent task execution per repository
- **Task orchestration** — full task lifecycle with state machine (pending, queued, provisioning, running, pr_opened, completed, failed, cancelled, needs_attention)
- **Priority queue with concurrency limits** — global and per-repo concurrency controls, priority-based scheduling, and task reordering
- **Subtask system** — child, step, and review subtask types with parent blocking and completion tracking
- **Code review agent** — automatic PR review as a blocking subtask, configurable triggers (on CI pass or PR open), and dedicated review prompts
- **PR watcher** — polls GitHub PRs for CI status, review status, merge/close events; auto-completes on merge, auto-fails on close
- **Auto-resume on review** — re-queues tasks with reviewer comments when changes are requested
- **Auto-resume on CI failure and merge conflicts** — detects failures and re-queues the agent to fix them
- **Auto-merge** — merges PRs automatically when CI passes and reviews are approved
- **Auto-close linked GitHub issues** — closes the originating GitHub issue when a task completes
- **GitHub Issues integration** — browse issues across repos, one-click assign to create tasks, bulk assign all
- **Linear ticket provider** — sync tasks from Linear projects
- **Structured log streaming** — real-time NDJSON parsing of Claude Code output with typed log entries (text, tool_use, tool_result, thinking, system, error, info)
- **WebSocket event streaming** — live task state and log updates pushed to the web UI via Redis pub/sub
- **Web UI** — Next.js 15 app with task list, task detail with log viewer, repo management, cluster health, secrets management, and setup wizard
- **Cluster health dashboard** — expandable resource usage graphs, pod health monitoring, and stale task detection
- **Pod health monitoring** — automatic detection of crashed/OOM-killed pods, auto-restart, orphan worktree cleanup, and idle pod cleanup
- **Secrets management** — AES-256-GCM encrypted secrets with global and repo-scoped support
- **Prompt templates** — configurable system prompts with template variables and conditional blocks; per-repo overrides
- **Per-repo agent settings** — configurable Claude model, context window, thinking mode, effort level, and max turns
- **Auto-detect image preset** — detects project language (Node, Python, Go, Rust) from repo files and selects the appropriate container image
- **Agent adapters** — pluggable adapter interface with Claude Code and OpenAI Codex implementations
- **Container runtimes** — Docker and Kubernetes runtime backends
- **Authentication** — API key and Max Subscription (OAuth) modes for Claude Code
- **Error classification** — pattern-matching error classifier with human-readable titles, descriptions, and remediation suggestions
- **Helm chart** — full Kubernetes deployment with configurable Postgres, Redis, ingress, RBAC, and secrets
- **Pre-commit hooks** — Husky with lint-staged, Prettier formatting, ESLint, typecheck, and conventional commit enforcement
- **CI pipeline** — GitHub Actions for format checking, typechecking, testing, web build, and Docker image build
