# CLAUDE.md

Context and conventions for AI assistants working on the Optio codebase.

Detailed reference docs are in `.claude/rules/`: `architecture-deep-dive.md`, `auth.md`, `database.md`, `api-routes.md`, `deployment.md`.

## What is Optio?

Optio is a workflow orchestration system for AI coding agents. Think of it as "CI/CD where the build step is an AI agent." Users submit tasks (manually or from GitHub Issues), and Optio:

1. Spins up an isolated Kubernetes pod for the repository (pod-per-repo)
2. Creates a git worktree for the task (multiple tasks can run concurrently per repo)
3. Runs Claude Code or OpenAI Codex with a configurable prompt
4. Streams structured logs back to a web UI in real time
5. Agent stops after opening a PR (no CI blocking)
6. PR watcher tracks CI checks, review status, and merge state
7. Auto-triggers code review agent on CI pass or PR open (if enabled)
8. Auto-resumes agent when reviewer requests changes (if enabled)
9. Auto-completes on merge, auto-fails on close

## Architecture

```text
+---------------+     +----------------+     +-----------------------+
|   Web UI      |---->|  API Server    |---->|   K8s Pods            |
|  Next.js      |     |   Fastify      |     |                       |
|  :30310       |     |   :30400       |     |  +-- Repo Pod A --+   |
|               |<ws--|                |     |  | clone + sleep   |   |
|               |     | - BullMQ       |     |  | +- worktree 1   |   |
|               |     | - Drizzle      |     |  | +- worktree 2   |   |
|               |     | - WebSocket    |     |  | +- worktree N   |   |
|               |     | - PR Watcher   |     |  +----------------+   |
|               |     | - Health Mon   |     |                       |
+---------------+     +--------+-------+     +-----------------------+
                               |
                        +------+-------+
                        |  Postgres    |  State, logs, secrets, config
                        |  Redis       |  Job queue, pub/sub
                        +------+-------+
```

All services run in Kubernetes (including API and web). Local dev uses Docker Desktop K8s with Helm. See `setup-local.sh`.

### Pod-per-repo with worktrees

This is the central optimization. Instead of one pod per task (slow, wasteful), we run one long-lived pod per repository:

- The pod clones the repo once on creation, then runs `sleep infinity`
- When a task arrives, we `exec` into the pod: `git worktree add` -> run agent -> cleanup worktree
- Multiple tasks can run concurrently in the same pod (one per worktree), controlled by per-repo `maxConcurrentTasks`
- Pods use persistent volumes so installed tools survive pod restarts
- Pods idle for 10 minutes (`OPTIO_REPO_POD_IDLE_MS`, configurable) before being cleaned up

The entrypoint scripts are in `scripts/`: `repo-init.sh` (pod entrypoint) and `agent-entrypoint.sh` (legacy).

### Task lifecycle (state machine)

```text
pending -> queued -> provisioning -> running -> pr_opened -> completed
                                      |  ^        |  ^
                                 needs_attention   needs_attention
                                      |                |
                                   cancelled         cancelled
                                 running -> failed -> queued (retry)
```

The state machine is in `packages/shared/src/utils/state-machine.ts`. All transitions are validated -- invalid transitions throw `InvalidTransitionError`.

## Tech Stack

| Layer      | Technology                       | Notes                                                    |
| ---------- | -------------------------------- | -------------------------------------------------------- |
| Monorepo   | Turborepo + pnpm 10              | 6 packages, workspace protocol                           |
| API        | Fastify 5                        | Plugins, schema validation, WebSocket                    |
| ORM        | Drizzle                          | PostgreSQL, migrations in `apps/api/src/db/migrations/`  |
| Queue      | BullMQ + Redis                   | Also used for pub/sub (log streaming to WebSocket)       |
| Web        | Next.js 15 App Router            | Tailwind CSS v4, Zustand, Lucide icons, sonner, Recharts |
| K8s client | @kubernetes/client-node          | Pod lifecycle, exec, log streaming, metrics              |
| Validation | Zod                              | API request schemas                                      |
| Testing    | Vitest                           | Test files across shared + api                           |
| CI         | GitHub Actions                   | Format, typecheck, test, build-web, build-image          |
| Deploy     | Helm                             | Chart at `helm/optio/`, local dev via `setup-local.sh`   |
| Hooks      | Husky + lint-staged + commitlint | Pre-commit: format + typecheck. Commit-msg: conventional |

## Directory Layout

```text
apps/
  api/src/
    routes/         health, tasks, subtasks, bulk, secrets, repos, issues, tickets, setup,
                    auth, cluster, resume, prompt-templates, analytics, webhooks, comments,
                    schedules, slack, task-templates, workspaces, dependencies, workflows,
                    mcp-servers, sessions, skills
    services/       task-service, repo-pool-service, secret-service, auth-service,
                    container-service, prompt-template-service, repo-service,
                    repo-detect-service, review-service, subtask-service,
                    ticket-sync-service, event-bus, agent-event-parser,
                    session-service, interactive-session-service, workspace-service,
                    webhook-service, comment-service, schedule-service, slack-service,
                    task-template-service, workflow-service, dependency-service,
                    mcp-server-service, skill-service, oauth/ (github, google, gitlab)
    plugins/        auth (session validation middleware)
    workers/        task-worker, pr-watcher-worker, repo-cleanup-worker,
                    ticket-sync-worker, webhook-worker, schedule-worker
    ws/             log-stream, events, session-terminal, session-chat, ws-auth
    db/             schema.ts (~26 tables), client.ts, migrations/ (~28 migrations)
  web/src/
    app/            Pages: /, /tasks, /tasks/new, /tasks/[id], /repos, /repos/[id],
                    /cluster, /cluster/[id], /secrets, /settings, /setup, /costs,
                    /login, /sessions, /sessions/[id], /templates,
                    /workspace-settings, /schedules, /workflows
    components/     task-card, task-list, log-viewer, web-terminal, event-timeline,
                    state-badge, skeleton, session-terminal, session-chat, split-pane,
                    activity-feed, pipeline-timeline,
                    layout/ (sidebar, layout-shell, setup-check, ws-provider,
                    user-menu, theme-provider, themed-toaster, workspace-switcher)
    hooks/          use-store (Zustand), use-websocket, use-task, use-logs
    lib/            api-client, ws-client, ws-auth, utils

packages/
  shared/             Types, state machine, prompt template renderer, error classifier,
                      constants, normalize-repo-url
  container-runtime/  ContainerRuntime interface, Docker + Kubernetes implementations
  agent-adapters/     AgentAdapter interface, ClaudeCode + Codex adapters
  ticket-providers/   TicketProvider interface, GitHub + Linear providers

Dockerfile.api        API server Docker image (tsx-based)
Dockerfile.web        Web UI Docker image (Next.js production build)
images/               Agent preset Dockerfiles: base, node, python, go, rust, full
helm/optio/           Helm chart: api, web, postgres, redis, ingress, rbac, secrets
scripts/              setup-local.sh, update-local.sh, repo-init.sh, agent-entrypoint.sh
```

## Commands

```bash
# Setup (first time -- builds everything, deploys to local k8s via Helm)
./scripts/setup-local.sh

# Update (pull + rebuild + redeploy)
./scripts/update-local.sh

# Manual rebuild + redeploy
docker build -t optio-api:latest -f Dockerfile.api .
docker build -t optio-web:latest -f Dockerfile.web .
kubectl rollout restart deployment/optio-api deployment/optio-web -n optio

# Quality (these are what CI runs, and pre-commit hooks mirror them)
pnpm format:check                     # Check formatting (Prettier)
pnpm turbo typecheck                  # Typecheck all 6 packages
pnpm turbo test                       # Run tests (Vitest)
cd apps/web && npx next build         # Verify production build

# Database (migrations auto-run on API startup, but manual generation needed)
cd apps/api && npx drizzle-kit generate  # Generate migration after schema change

# Agent images
./images/build.sh                     # Build all image presets

# Helm
helm lint helm/optio --set encryption.key=test
helm upgrade optio helm/optio -n optio --reuse-values

# Teardown
helm uninstall optio -n optio
```

## Conventions

- **ESM everywhere**: all packages use `"type": "module"` with `.js` extensions in imports (TypeScript resolves them to `.ts`)
- **Conventional commits**: enforced by commitlint via husky commit-msg hook (e.g., `feat:`, `fix:`, `refactor:`)
- **Pre-commit hooks**: lint-staged (eslint + prettier on staged files), then `pnpm format:check` and `pnpm turbo typecheck` -- mirrors CI
- **Tailwind CSS v4**: `@import "tailwindcss"` + `@theme` block in CSS, no `tailwind.config` file
- **Drizzle ORM**: schema in `apps/api/src/db/schema.ts`, run `drizzle-kit generate` after changes
- **Zod**: API request validation in route handlers
- **Zustand**: use `useStore.getState()` in callbacks/effects, not hook selectors (avoids infinite re-renders)
- **WebSocket events**: published to Redis pub/sub channels, relayed to browser clients
- **Next.js webpack config**: `extensionAlias` in `next.config.ts` resolves `.js` -> `.ts` for workspace packages
- **Error handling**: use the error classifier for user-facing error messages, raw errors in logs
- **State transitions**: always go through `taskService.transitionTask()` which validates, updates DB, records event, and publishes to WebSocket
- **Secrets**: never log or return secret values, only names/scopes. Encrypted at rest with AES-256-GCM
- **Cost tracking**: stored as string (`costUsd`) to avoid float precision issues

## Security Model

- **Web UI / API auth**: Multi-provider OAuth (GitHub, Google, GitLab). Sessions use SHA256-hashed tokens with 30-day TTL. Disable with `OPTIO_AUTH_DISABLED=true` for local dev. Details in `.claude/rules/auth.md`.
- **Secrets at rest**: AES-256-GCM encryption. Secret values are never logged or returned via API.
- **Claude Code auth**: Three modes -- API key, OAuth token (recommended for k8s), or host Keychain (legacy local dev).
- **K8s RBAC**: ServiceAccount with namespace-scoped Role (pods, exec, secrets, PVCs) + ClusterRole (nodes, namespaces, metrics).
- **Multi-tenancy**: Workspace-scoped resources with role-based access (admin/member/viewer). Enforcement is partial.

## Known Issues

- Agent images are built locally -- CI push to a registry is not yet configured
- Workspace RBAC roles are in the schema but not fully enforced in all routes
- Notion ticket provider is a stub (GitHub Issues and Linear are implemented)
- Some duplicate-numbered migration files exist from concurrent agent branches -- the drizzle journal (`meta/_journal.json`) is authoritative
- OAuth tokens from `claude setup-token` have limited scopes and may not support usage tracking
- The API container runs via `tsx` rather than compiled JS, since workspace packages export `./src/index.ts`
