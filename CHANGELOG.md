# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- Ticket sync: fall back to the configured GitHub App (or `GITHUB_TOKEN` PAT) when a GitHub ticket provider has no inline token or provider-specific secret. Previously sync hard-failed with `"GitHub provider requires token, owner, and repo in config"` even when a GitHub App was fully configured (#458).

## [0.3.0] - 2026-04-20

### Added

- **Pooled standalone-task pods** — runs within a workflow now share pods, scaling out to `workflows.maxPodInstances` replicas each hosting up to `workflows.maxAgentsPerPod` concurrent runs (mirrors repo pod scaling). Runs track assigned pods via `workflow_runs.pod_id` with `last_pod_id` for retry affinity, and pool selection follows preferred → least-loaded → scale-up → overflow. Fixes a leak where a burst of triggers would spawn one pod per run even though only a few ran at once.

### Changed

- **Reconciliation control plane is now authoritative** — the K8s-style reconciler (shadow mode in 0.2.0) now owns PR-driven transitions, auto-merge, complete-on-merge, fail-on-close, auto-resume, review launch, stall detection, pod-death detection, and control intent (cancel/retry/resume/restart) for both Repo Tasks and Standalone Tasks.
- **Shared auth banner, state badge, and metadata card** across task pages for a consistent UX.

### Fixed

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
