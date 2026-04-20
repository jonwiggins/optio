# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Helm (Chart 0.1.1): PostgreSQL PGDATA subdirectory pattern** — new `postgresql.usePgdataSubdirectory` value (default `false`) enables PGDATA subdirectory to avoid PVC metadata conflicts. Required for PostgreSQL 18+. **BREAKING if enabled on existing deployments** — see chart NOTES.txt for manual migration steps.

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
