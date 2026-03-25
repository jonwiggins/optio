# Optio

AI Agent Workflow Orchestration — run coding agents (Claude Code, OpenAI Codex) on tasks from your repositories.

Optio manages the full lifecycle: task intake → container provisioning → agent execution → PR creation → CI monitoring → merge. Agents run in isolated Kubernetes pods with git worktrees for efficient multi-task concurrency.

## Demo

<p align="center">
  <img src="docs/screenshots/dashboard-overview.svg" alt="Optio dashboard showing task overview with running, queued, and completed tasks across repositories" width="100%"/>
</p>
<p align="center"><em>Dashboard overview — monitor all tasks at a glance with real-time status updates</em></p>

<p align="center">
  <img src="docs/screenshots/task-detail-logs.svg" alt="Task detail view with live streaming logs showing agent reading files, writing code, and running type checks" width="100%"/>
</p>
<p align="center"><em>Task detail — live-streamed agent logs with tool calls, pipeline progress, and cost tracking</em></p>

<p align="center">
  <img src="docs/screenshots/repo-management.svg" alt="Repository management view showing configured repos with image presets, review settings, and active pod status" width="100%"/>
</p>
<p align="center"><em>Repository management — per-repo agent settings, image presets, and active pod monitoring</em></p>

## Features

- **Pod-per-repo architecture** — one long-lived pod per repository, tasks run in git worktrees for efficient multi-task concurrency
- **Priority queue** — per-repo and global concurrency limits, task reordering, bulk operations (retry all failed, cancel all active)
- **Subtask system** — child tasks, sequential steps, and code reviews as blocking subtasks
- **Code review agent** — auto-triggered on CI pass, PR open, or manual; scoped to the assigned PR; configurable review model and prompt
- **PR lifecycle tracking** — polls GitHub every 30s for CI checks, review status, merge state; auto-completes on merge, auto-fails on close, auto-resumes agent on "changes requested"
- **Multi-agent support** — Claude Code and OpenAI Codex, with Max subscription (`CLAUDE_CODE_OAUTH_TOKEN`) or API key auth
- **Per-repo agent tuning** — Claude model, context window (200k/1M), thinking budget, effort level, prompt template overrides
- **Configurable prompts** — Handlebars-style templates with `{{variables}}` and `{{#if}}` conditionals, per-repo or global
- **Auto-detect image preset** — inspects repo contents (Cargo.toml -> rust, package.json -> node, etc.) and selects the right container image
- **Container image presets** — base, node, python, go, rust, full — or bring your own Dockerfile
- **GitHub Issues integration** — browse issues in the UI, one-click assign to Optio, auto-label and comment back with PR links
- **Linear ticket provider** — fetch actionable tickets, add comments, update state
- **Real-time UI** — live log streaming, structured event viewer, task state timeline, cost tracking per task
- **Pod health monitoring** — auto-restart crashed/OOM-killed pods, orphaned worktree cleanup, persistent volumes per repo
- **Session resume** — capture Claude session IDs, resume interrupted work with follow-up prompts
- **Setup wizard** — guided onboarding with credential validation and repo auto-detection
- **Helm charts** — production-ready Kubernetes deployment with RBAC, health probes, and ingress

## Quick Start

### Prerequisites

- **Docker Desktop** with Kubernetes enabled (Settings → Kubernetes → Enable)
- **Node.js 22+** and **pnpm 10+**

### Setup

```bash
# Clone and install
git clone https://github.com/jonwiggins/optio.git && cd optio
pnpm install

# Bootstrap infrastructure (Postgres + Redis in K8s, migrations, .env)
./scripts/setup-local.sh

# Start dev servers
pnpm dev
# API → http://localhost:4000
# Web → http://localhost:3000
```

The setup wizard will guide you through configuring GitHub access, agent credentials, and repositories.

### Build the Agent Image

```bash
docker build -t optio-agent:latest -f Dockerfile.agent .
```

## Architecture

### System Components

```
┌──────────────┐     ┌────────────────────┐     ┌──────────────────────────┐
│   Web UI     │────→│    API Server      │────→│      Kubernetes          │
│   Next.js    │     │    Fastify         │     │                          │
│   :3000      │     │                    │     │  ┌── Repo Pod A ──────┐  │
│              │←ws──│  Workers:          │     │  │ clone + sleep      │  │
│  - Dashboard │     │  ├─ Task Queue     │     │  │ ├─ worktree 1  ⚡  │  │
│  - Tasks     │     │  ├─ PR Watcher     │     │  │ ├─ worktree 2  ⚡  │  │
│  - Repos     │     │  ├─ Health Mon     │     │  │ └─ worktree N  ⚡  │  │
│  - Cluster   │     │  └─ Ticket Sync    │     │  └────────────────────┘  │
│  - Issues    │     │                    │     │  ┌── Repo Pod B ──────┐  │
│  - Settings  │     │  Services:         │     │  │ clone + sleep      │  │
│              │     │  ├─ Repo Pool      │     │  │ └─ worktree 1  ⚡  │  │
│              │     │  ├─ Review Agent   │     │  └────────────────────┘  │
│              │     │  └─ Auth/Secrets   │     │                          │
└──────────────┘     └─────────┬──────────┘     └──────────────────────────┘
                               │                  ⚡ = Claude Code / Codex
                        ┌──────┴──────┐
                        │  Postgres   │  Tasks, logs, events, secrets, repos
                        │  Redis      │  Job queue, pub/sub, live streaming
                        └─────────────┘
```

One pod runs per repository. The pod clones the repo once, then stays alive. Each task gets its own git worktree inside the pod, so multiple tasks can run concurrently against the same repo without interference. Pods idle for 10 minutes (configurable), then get cleaned up. A health monitor watches for crashed/OOM-killed pods and auto-restarts them.

### Task Lifecycle

Every task follows a loop: the agent writes code, opens a PR, and then the system monitors, reviews, and self-heals until the PR merges.

```
  ┌─────────────────────────────────────────────────┐
  │                    INTAKE                        │
  │                                                  │
  │   GitHub Issue ───→ ┌──────────┐                 │
  │   Manual Task ───→  │  QUEUED  │                 │
  │   Ticket Sync ───→  └────┬─────┘                 │
  └───────────────────────────┼──────────────────────┘
                              │
  ┌───────────────────────────┼──────────────────────┐
  │                 EXECUTION ▼                       │
  │                                                   │
  │   ┌──────────────┐    ┌─────────────────┐         │
  │   │ PROVISIONING │───→│     RUNNING     │         │
  │   │ get/create   │    │  agent writes   │         │
  │   │ repo pod     │    │  code in        │         │
  │   └──────────────┘    │  worktree       │         │
  │                        └───────┬─────────┘         │
  └────────────────────────────────┼──────────────────┘
                                   │
                 ┌─────────────┐   │   ┌─────────────────┐
                 │   FAILED    │←──┴──→│   PR OPENED     │
                 │             │       │                  │
                 │ (auto-retry │       │  PR watcher      │
                 │  if stale)  │       │  polls every 30s │
                 └─────────────┘       └────────┬─────────┘
                                                │
  ┌─────────────────────────────────────────────┼────────┐
  │                 FEEDBACK LOOP                │        │
  │                                              │        │
  │   CI fails?  ────────→  Resume agent  ←──────┤        │
  │                          to fix build         │        │
  │                                              │        │
  │   Merge conflicts? ──→  Resume agent  ←──────┤        │
  │                          to rebase            │        │
  │                                              │        │
  │   Review requests ───→  Resume agent  ←──────┤        │
  │   changes?               with feedback        │        │
  │                                              │        │
  │   CI passes + ───────→  Auto-merge    ───────┘        │
  │   review done?           & close issue                │
  │                                                       │
  │         ┌───────────────────────┐                     │
  │         │  agent pushes fix,    │                     │
  │         │  returns to PR OPENED │                     │
  │         └───────────────────────┘                     │
  │                                                       │
  │                          ┌─────────────┐              │
  │                          │  COMPLETED  │              │
  │                          │  PR merged  │              │
  │                          │  Issue closed│              │
  │                          └─────────────┘              │
  └───────────────────────────────────────────────────────┘
```

**Key behaviors:**

- **Auto-resume on CI failure** — the agent is re-queued with the names of failed checks
- **Auto-resume on merge conflicts** — the agent is told to rebase and force-push
- **Auto-resume on review feedback** — review comments are passed as the resume prompt
- **Auto-merge** — when CI passes and blocking subtasks complete, the PR is squash-merged
- **Auto-close issues** — linked GitHub issues are closed with a comment when the task completes
- **Stale detection** — tasks stuck in `running` for 10+ minutes are automatically retried
- **Startup reconciliation** — orphaned tasks from Redis restarts are re-queued on server boot

## Project Structure

```
apps/
  api/          Fastify API, BullMQ workers (task, PR watcher, health, ticket sync),
                WebSocket endpoints, review service, subtask system
  web/          Next.js dashboard with real-time streaming

packages/
  shared/             Types, task state machine, prompt templates, error classifier
  container-runtime/  Kubernetes pod lifecycle, exec, log streaming
  agent-adapters/     Claude Code + Codex prompt/auth adapters
  ticket-providers/   GitHub Issues, Linear

images/               Dockerfiles: base, node, python, go, rust, full
helm/optio/           Helm chart for production K8s deployment
k8s/                  Local dev manifests (namespace, infrastructure)
scripts/              Setup, init, and entrypoint scripts
```

## Configuration

### Per-Repo Settings

Each repository can be configured with:

- **Container image** — auto-detected from repo contents, or manually set to a preset (base/node/python/go/rust/full) or custom Dockerfile
- **Extra packages** — apt packages installed at pod startup
- **Setup commands** — shell commands run after clone
- **Prompt template override** — custom agent instructions for this repo
- **Auto-merge** — whether agents should merge PRs after CI passes
- **Claude model settings** — model (opus/sonnet), context window (200k/1M), thinking on/off, effort level (low/medium/high)
- **Concurrency limit** — max concurrent tasks per repo
- **Code review** — enable/disable, trigger (on CI pass, on PR open, or manual), review model, review prompt template
- **Auto-resume on review** — automatically re-queue the agent when a reviewer requests changes
- **Setup script** — `.optio/setup.sh` in the repo runs after clone

### Prompt Templates

Agents receive a system prompt rendered with these variables:

- `{{TASK_FILE}}` — path to the task description file
- `{{BRANCH_NAME}}` — the working branch
- `{{TASK_ID}}` — unique task identifier
- `{{TASK_TITLE}}` — task title
- `{{REPO_NAME}}` — repository name (owner/repo)
- `{{AUTO_MERGE}}` — for conditional merge instructions
- `{{#if VAR}}...{{else}}...{{/if}}` — conditional blocks

Review tasks use a separate prompt template with `{{PR_NUMBER}}`, `{{TEST_COMMAND}}`, and other review-specific variables.

### Authentication

Claude Code supports two auth modes:

- **API Key** — `ANTHROPIC_API_KEY` injected into the container
- **Max Subscription** — `CLAUDE_CODE_OAUTH_TOKEN` read from the host's macOS Keychain or `~/.claude/.credentials.json`, cached for 30s with auto-refresh

## Development

```bash
pnpm dev                              # Start API (:4000) + Web (:3000) via Turborepo
pnpm turbo typecheck                  # Typecheck all packages
pnpm turbo test                       # Run tests (Vitest)
pnpm format:check                     # Check formatting (Prettier)
```

Pre-commit hooks run lint-staged, format checks, and typecheck (mirroring CI). Commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/) spec via commitlint.

## Teardown

```bash
pkill -f 'kubectl port-forward.*optio'
kubectl delete namespace optio
```

## Tech Stack

| Layer    | Technology                                                       |
| -------- | ---------------------------------------------------------------- |
| Monorepo | Turborepo + pnpm                                                 |
| API      | Fastify 5, Drizzle ORM, BullMQ                                   |
| Web      | Next.js 15, Tailwind CSS 4, Zustand                              |
| Database | PostgreSQL 16                                                    |
| Queue    | Redis 7 + BullMQ                                                 |
| Runtime  | Kubernetes (Docker Desktop for local)                            |
| Deploy   | Helm chart (`helm/optio/`)                                       |
| CI       | GitHub Actions (format, typecheck, test, build-web, build-image) |
| Agents   | Claude Code, OpenAI Codex                                        |
