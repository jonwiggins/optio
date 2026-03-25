# CLAUDE.md

Context and conventions for AI assistants working on the Optio codebase.

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

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────────┐
│   Web UI    │────→│  API Server  │────→│   K8s Pods          │
│  Next.js    │     │   Fastify    │     │                     │
│  :3100      │     │   :4000      │     │  ┌─ Repo Pod A ──┐  │
│             │←ws──│              │     │  │ clone + sleep  │  │
│             │     │ - BullMQ     │     │  │ ├─ worktree 1  │  │
│             │     │ - Drizzle    │     │  │ ├─ worktree 2  │  │
│             │     │ - WebSocket  │     │  │ └─ worktree N  │  │
│             │     │ - PR Watcher │     │  └────────────────┘  │
│             │     │ - Health Mon │     │                       │
└─────────────┘     └──────┬───────┘     └───────────────────────┘
                           │
                    ┌──────┴───────┐
                    │  Postgres    │  State, logs, secrets, config, health events
                    │  Redis       │  Job queue, pub/sub
                    └──────────────┘
```

### Pod-per-repo with worktrees

This is the central optimization. Instead of one pod per task (slow, wasteful), we run one long-lived pod per repository:

- The pod clones the repo once on creation, then runs `sleep infinity`
- When a task arrives, we `exec` into the pod: `git worktree add` → run agent → cleanup worktree
- Multiple tasks can run concurrently in the same pod (one per worktree), controlled by per-repo `maxConcurrentTasks`
- Pods use persistent volumes so installed tools survive pod restarts
- Pods idle for 10 minutes (`OPTIO_REPO_POD_IDLE_MS`, configurable) before being cleaned up
- On the next task for that repo, a new pod is created automatically

The entrypoint scripts are in `scripts/`:

- `repo-init.sh` — pod entrypoint: clone repo, run `.optio/setup.sh` if present, sleep forever
- `agent-entrypoint.sh` — legacy per-task entrypoint (kept for compatibility)

### Multi-pod scaling

Repos can scale beyond a single pod to handle higher task throughput. Two per-repo settings control this:

- **`maxPodInstances`** (default 1) — maximum pod replicas per repository (1–20)
- **`maxAgentsPerPod`** (default 2) — maximum concurrent agents (worktrees) per pod instance (1–50)

Total capacity = `maxPodInstances × maxAgentsPerPod`. The task worker computes `effectiveRepoConcurrency` and uses `max(maxConcurrentTasks, effectiveRepoConcurrency)` as the per-repo limit.

Pod scheduling in `repo-pool-service.ts`:

1. **Same-pod retry affinity**: if this is a retry, prefer the pod the task last ran on (via `tasks.lastPodId`)
2. **Least-loaded selection**: pick the ready pod with the lowest `activeTaskCount`
3. **Dynamic scale-up**: if all pods are at capacity and under the instance limit, create a new pod with the next `instanceIndex`
4. **Queue overflow**: if at the instance limit and all pods are full, queue the task on the least-loaded pod

Each pod instance gets its own PVC (e.g., `optio-home-repo-0`, `optio-home-repo-1`) and is labeled with `optio.instance-index`. On idle cleanup, higher-index pods are removed first (LIFO scaling).

### Worktree lifecycle management

Tasks track their worktree state via `tasks.worktreeState`:

| State       | Meaning                                        |
| ----------- | ---------------------------------------------- |
| `active`    | Worktree is in use by a running agent          |
| `dirty`     | Agent finished but worktree not yet cleaned up |
| `reset`     | Worktree was reset for a retry on the same pod |
| `preserved` | Worktree kept for manual inspection or resume  |
| `removed`   | Worktree has been cleaned up                   |

`tasks.lastPodId` records which pod the task ran on, enabling same-pod retry affinity — retries reuse the existing worktree (reset instead of recreate) for faster restarts.

The `repo-cleanup-worker` uses worktree state to make cleanup decisions:

- **active / preserved**: leave alone
- **dirty + retries remaining**: leave for same-pod retry
- **dirty + no retries**: remove after 2-minute grace period
- **orphaned** (no matching task): remove immediately
- **terminal states** (completed/cancelled): remove after grace period

### Pod health monitoring

The `repo-cleanup-worker` runs every 60s (`OPTIO_HEALTH_CHECK_INTERVAL`) and:

1. Checks each repo pod's status via K8s API
2. Detects crashed or OOM-killed pods, records events in `pod_health_events`
3. Fails any tasks that were running on a dead pod
4. Auto-restarts: deletes the dead pod record so the next task recreates it
5. Cleans up orphaned worktrees (worktrees for completed/failed/cancelled tasks)
6. Cleans up idle pods past the timeout

### Task lifecycle (state machine)

```
pending → queued → provisioning → running → pr_opened → completed
                                    ↓  ↑        ↓  ↑
                               needs_attention   needs_attention
                                    ↓                ↓
                                 cancelled         cancelled
                               running → failed → queued (retry)
```

The state machine is in `packages/shared/src/utils/state-machine.ts`. All transitions are validated — invalid transitions throw `InvalidTransitionError`. The retry path is `failed → queued` (or `cancelled → queued`), which resets error fields.

### Priority queue and concurrency

Tasks have an integer `priority` field (lower = higher priority). The task worker enforces two concurrency limits:

1. **Global**: `OPTIO_MAX_CONCURRENT` (default 5) — total running/provisioning tasks across all repos
2. **Per-repo**: `repos.maxConcurrentTasks` (default 2) — tasks running in the same repo pod

When a limit is hit, the task is re-queued with a 10-second delay. Task reordering is supported via `POST /api/tasks/reorder` which reassigns priority values based on position.

Bulk operations: `POST /api/tasks/bulk/retry-failed` (retries all failed tasks) and `POST /api/tasks/bulk/cancel-active` (cancels all running + queued tasks).

### Subtask system

Tasks can have child tasks (`parentTaskId`). Three subtask types:

- **child** — independent subtask
- **step** — sequential step in a pipeline
- **review** — code review subtask (see below)

Subtasks have `subtaskOrder` for ordering and `blocksParent` to indicate whether the parent should wait for this subtask to complete. When a blocking subtask completes, `onSubtaskComplete()` checks if all blocking subtasks are done and can advance the parent.

Routes: `GET /api/tasks/:id/subtasks`, `POST /api/tasks/:id/subtasks`, `GET /api/tasks/:id/subtasks/status`.

### Code review agent

The review system (`review-service.ts`) launches a review agent as a blocking subtask of the original coding task:

1. Triggered automatically by the PR watcher (on CI pass or PR open, per `repos.reviewTrigger`) or manually via `POST /api/tasks/:id/review`
2. Creates a review subtask with `taskType: "review"`, `blocksParent: true`
3. Builds a review-specific prompt using `repos.reviewPromptTemplate` (or default) with variables: `{{PR_NUMBER}}`, `{{TASK_FILE}}`, `{{REPO_NAME}}`, `{{TASK_TITLE}}`, `{{TEST_COMMAND}}`
4. Uses `repos.reviewModel` (defaults to "sonnet") — allows using a cheaper model for reviews
5. The review task runs in the same repo pod, scoped to the PR branch
6. Parent task waits for the review to complete before advancing

### PR watcher

`pr-watcher-worker.ts` runs as a BullMQ repeating job every 30s (`OPTIO_PR_WATCH_INTERVAL`). For each task in `pr_opened` state:

1. Fetches PR data, check runs, and reviews from the GitHub API
2. Updates task fields: `prNumber`, `prState`, `prChecksStatus`, `prReviewStatus`, `prReviewComments`
3. Triggers review agent if CI just passed and `repos.reviewEnabled` + `repos.reviewTrigger === "on_ci_pass"`
4. Triggers review agent on first PR detection if `repos.reviewTrigger === "on_pr"`
5. On PR merge: transitions task to `completed`
6. On PR close without merge: transitions task to `failed`
7. On "changes requested" review with `repos.autoResumeOnReview`: transitions to `needs_attention` then re-queues with the review comments as a resume prompt

### How a task runs (detailed flow)

1. User creates task via UI, ticket sync, or GitHub Issue assignment
2. `POST /api/tasks` → inserts row, transitions `pending → queued`, adds BullMQ job with priority
3. Task worker picks up job:
   - **Concurrency check**: verifies global and per-repo limits; re-queues with delay if exceeded
   - Reads `CLAUDE_AUTH_MODE` secret to determine auth method
   - Loads prompt template for the repo (repo override → global default → hardcoded)
   - Renders prompt with `{{TASK_FILE}}`, `{{BRANCH_NAME}}`, etc.
   - Renders task file (markdown with title + description)
   - Applies per-repo Claude settings (model, context window, thinking, effort)
   - For review tasks: applies review-specific prompt, task file, and model overrides
   - Calls `adapter.buildContainerConfig()` which produces env vars + setup files
   - For max-subscription auth: fetches `CLAUDE_CODE_OAUTH_TOKEN` from the auth service
   - Calls `repoPool.getOrCreateRepoPod()` — finds existing pod or creates one
   - Calls `repoPool.execTaskInRepoPod()` which execs a bash script:
     - `git fetch origin && git worktree add /workspace/tasks/{taskId}`
     - Decodes `OPTIO_SETUP_FILES` (base64 JSON) → writes `.optio/task.md` + auth helpers
     - Runs `claude -p "..." --dangerously-skip-permissions --output-format stream-json --verbose --max-turns 50`
     - Cleanup: `git worktree remove`
4. Worker streams exec session stdout, parsing each NDJSON line via `agent-event-parser.ts`
5. Session ID is captured from the first event and stored on the task
6. PR URLs are detected in log output and stored
7. Cost (USD) is extracted from the agent result and stored on the task
8. On completion: `running → pr_opened` or `running → completed` or `running → failed`
9. If this is a subtask, `onSubtaskComplete()` checks if the parent should advance
10. The repo pod stays alive for the next task

### Authentication (Web UI)

Multi-provider OAuth for the web UI and API. Three providers are supported:

- **GitHub** (`apps/api/src/services/oauth/github.ts`) — scopes: `read:user user:email`
- **Google** (`apps/api/src/services/oauth/google.ts`) — scopes: `openid email profile`
- **GitLab** (`apps/api/src/services/oauth/gitlab.ts`) — scopes: `read_user`

Enable a provider by setting both `<PROVIDER>_OAUTH_CLIENT_ID` and `<PROVIDER>_OAUTH_CLIENT_SECRET` env vars (e.g., `GITHUB_OAUTH_CLIENT_ID`). GitLab also accepts `GITLAB_OAUTH_BASE_URL` for self-hosted instances.

**OAuth flow**: `GET /api/auth/:provider/login` → redirect to provider → callback at `GET /api/auth/:provider/callback` → upsert user in `users` table → create session (SHA256-hashed token in `sessions` table) → set `optio_session` HttpOnly cookie (30-day TTL) → redirect to web app.

**Auth middleware** (`apps/api/src/plugins/auth.ts`): `preHandler` hook on all routes except `/api/health`, `/api/auth/*`, `/api/setup/*`. WebSocket connections accept the token as a `?token=` query param. Next.js middleware (`apps/web/src/middleware.ts`) redirects unauthenticated users to `/login`.

**Local dev bypass**: Set `OPTIO_AUTH_DISABLED=true` (API) and `NEXT_PUBLIC_AUTH_DISABLED=true` (web) to skip all auth checks. `GET /api/auth/me` returns a synthetic "Local Dev" user.

**Key routes**:

- `GET /api/auth/providers` — list enabled providers
- `GET /api/auth/me` — current user profile
- `POST /api/auth/logout` — revoke session and clear cookie

### Authentication (Claude Code)

Two modes, selected during setup:

**API Key mode**: `ANTHROPIC_API_KEY` is injected as an env var into the container. Simple.

**Max Subscription mode**: The Optio API server reads the host machine's Claude OAuth credentials from the macOS Keychain (`Claude Code-credentials` service) or `~/.claude/.credentials.json` on Linux. The token is injected directly into the container as `CLAUDE_CODE_OAUTH_TOKEN`. It also serves the token via `GET /api/auth/claude-token` for backward compatibility with the `claude-key-helper.sh` approach.

The auth service is at `apps/api/src/services/auth-service.ts`. Credentials are cached for 30 seconds and auto-refresh.

### Auto-detect image preset

When adding a repo, `repo-detect-service.ts` queries the GitHub API for root-level files and selects the image preset:

- `Cargo.toml` → rust, `package.json` → node, `go.mod` → go, `pyproject.toml`/`setup.py`/`requirements.txt` → python
- Multiple languages → full
- Also detects `testCommand` (e.g., `cargo test`, `npm test`, `go test ./...`, `pytest`)

### Prompt templates

System prompts use a simple template language:

- `{{VARIABLE}}` — replaced with the variable value
- `{{#if VAR}}...{{else}}...{{/if}}` — conditional blocks (truthy if non-empty, not "false", not "0")

Standard variables: `{{TASK_FILE}}`, `{{BRANCH_NAME}}`, `{{TASK_ID}}`, `{{TASK_TITLE}}`, `{{REPO_NAME}}`, `{{AUTO_MERGE}}`.

Review-specific variables: `{{PR_NUMBER}}`, `{{TEST_COMMAND}}`.

The template is rendered in the task worker before being passed to the agent adapter. The task description is written as a separate file (`.optio/task.md`) in the worktree, and the prompt tells the agent to read it.

Priority: repo-level override (`repos.promptTemplateOverride`) → global default (`prompt_templates` table) → hardcoded fallback in `packages/shared/src/prompt-template.ts`.

Review prompts follow the same chain: `repos.reviewPromptTemplate` → `DEFAULT_REVIEW_PROMPT_TEMPLATE` from `@optio/shared`.

### Structured log parsing

Claude Code's `--output-format stream-json` produces NDJSON. Each line is parsed by `agent-event-parser.ts` into typed `AgentLogEntry` objects with types: `text`, `tool_use`, `tool_result`, `thinking`, `system`, `error`, `info`. The session ID is extracted from the first event. These are stored in `task_logs` with `log_type` and `metadata` columns.

### Error classification

When tasks fail, the error message is pattern-matched by `packages/shared/src/error-classifier.ts` into categories (image, auth, network, timeout, agent, state, resource) with human-readable titles, descriptions, and suggested remedies. This powers both the task detail error panel and the task card previews.

### Cost tracking analytics

`GET /api/analytics/costs` (`apps/api/src/routes/analytics.ts`) provides cost analytics with optional `days` (default 30) and `repoUrl` query params. Returns:

- **summary** — total cost, task count, average cost, cost trend (% change vs previous period)
- **dailyCosts** — per-day cost and task count breakdown
- **costByRepo** — cost aggregated by repository
- **costByType** — cost aggregated by task type (coding vs review)
- **topTasks** — 10 most expensive tasks

The web UI at `/costs` (`apps/web/src/app/costs/page.tsx`) renders this data with Recharts charts: area chart for daily costs, bar chart for cost by repo, pie chart for cost by type, and a table of top tasks. Period selector (7d/14d/30d/90d) and repo filter are available. Accessible from the sidebar via the DollarSign icon.

### Repository URL normalization

`normalizeRepoUrl()` in `packages/shared/src/utils/normalize-repo-url.ts` normalizes git repository URLs to a canonical HTTPS form for consistent matching and storage. Handles:

- HTTPS/HTTP URLs, SSH shorthand (`git@host:path`), SSH protocol URLs (`ssh://git@host/path`)
- Bare domain paths, mixed case, trailing slashes, `.git` suffixes, whitespace

Canonical output: `https://github.com/owner/repo` (lowercase host, no trailing slash, no `.git`). Used throughout the codebase wherever repo URLs are compared or stored. Test coverage in `normalize-repo-url.test.ts`.

## Tech Stack

| Layer      | Technology                       | Notes                                                                                             |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------- |
| Monorepo   | Turborepo + pnpm 10              | 6 packages, workspace protocol                                                                    |
| API        | Fastify 5                        | Plugins, schema validation, WebSocket                                                             |
| ORM        | Drizzle                          | PostgreSQL, generated migrations in `apps/api/src/db/migrations/` (15 migrations)                 |
| Queue      | BullMQ + Redis                   | Also used for pub/sub (log streaming to WebSocket clients)                                        |
| Web        | Next.js 15 App Router            | Tailwind CSS v4, Zustand, Lucide icons, sonner toasts                                             |
| K8s client | @kubernetes/client-node          | Pod lifecycle, exec, log streaming, metrics                                                       |
| Validation | Zod                              | API request schemas                                                                               |
| Testing    | Vitest                           | 4 test files across shared + api (state machine, error classifier, prompt template, event parser) |
| CI         | GitHub Actions                   | Format, typecheck, test, build-web, build-image                                                   |
| Deploy     | Helm                             | Chart at `helm/optio/`                                                                            |
| Hooks      | Husky + lint-staged + commitlint | Pre-commit: lint-staged + format + typecheck. Commit-msg: conventional commits                    |

## Directory Layout

```
apps/
  api/
    src/
      routes/         health, tasks, subtasks, bulk, secrets, repos, issues, tickets, setup, auth,
                      cluster, resume, prompt-templates, analytics
      services/       task-service, repo-pool-service, secret-service, auth-service, container-service,
                      prompt-template-service, repo-service, repo-detect-service, review-service,
                      subtask-service, ticket-sync-service, event-bus, agent-event-parser,
                      session-service, oauth/ (github, google, gitlab)
      plugins/        auth (session validation middleware)
      workers/        task-worker (main job processor), pr-watcher-worker, repo-cleanup-worker,
                      ticket-sync-worker
      ws/             log-stream (per-task), events (global)
      db/             schema.ts (Drizzle), client.ts, migrations/ (15 migrations)
    drizzle.config.ts
  web/
    src/
      app/            Pages: / (overview), /tasks, /tasks/new, /tasks/[id], /repos, /repos/[id],
                      /cluster, /cluster/[id], /secrets, /settings, /setup, /costs, /login
      components/     task-card, task-list, log-viewer, web-terminal, event-timeline, state-badge,
                      skeleton, layout/ (sidebar, layout-shell, setup-check, ws-provider, user-menu)
      middleware.ts   Next.js auth middleware (redirects unauthenticated users to /login)
      hooks/          use-store (Zustand), use-websocket, use-task, use-logs
      lib/            api-client, ws-client, utils

packages/
  shared/             Types (task, agent, container, secret, ticket, events, image, agent-events),
                      state machine, prompt template renderer, error classifier, constants,
                      normalize-repo-url
  container-runtime/  ContainerRuntime interface, DockerContainerRuntime, KubernetesContainerRuntime
  agent-adapters/     AgentAdapter interface, ClaudeCodeAdapter, CodexAdapter
  ticket-providers/   TicketProvider interface, GitHubTicketProvider, LinearTicketProvider

images/               Dockerfiles: base, node, python, go, rust, full + build.sh
helm/optio/           Helm chart: api, web, postgres, redis, ingress, rbac, secrets
k8s/                  Local dev manifests: namespace.yaml, infrastructure.yaml
scripts/              repo-init.sh, agent-entrypoint.sh, setup-local.sh
```

## Database Schema

11 tables (Drizzle, 15 migrations):

- **tasks** — id, title, prompt, repoUrl, repoBranch, state (enum), agentType, containerId, sessionId, prUrl, prNumber, prState, prChecksStatus, prReviewStatus, prReviewComments, resultSummary, costUsd, errorMessage, ticketSource, ticketExternalId, metadata (jsonb), retryCount, maxRetries, priority, parentTaskId, taskType ("coding"|"review"), subtaskOrder, blocksParent, worktreeState, lastPodId, createdBy (FK to users), timestamps (created/updated/started/completed)
- **task_events** — id, taskId (FK), fromState, toState, trigger, message, createdAt (audit trail)
- **task_logs** — id, taskId (FK), stream, content, logType, metadata (jsonb), timestamp
- **secrets** — id, name, scope, encryptedValue (bytea), iv, authTag (AES-256-GCM)
- **repos** — id, repoUrl (unique), fullName, defaultBranch, isPrivate, imagePreset, extraPackages, setupCommands, customDockerfile, autoMerge, promptTemplateOverride, claudeModel, claudeContextWindow, claudeThinking, claudeEffort, autoResume, maxConcurrentTasks, maxPodInstances, maxAgentsPerPod, maxTurnsCoding, maxTurnsReview, reviewEnabled, reviewTrigger, reviewPromptTemplate, testCommand, reviewModel
- **repo_pods** — id, repoUrl, repoBranch, podName, podId, state (enum), activeTaskCount, instanceIndex, lastTaskAt, errorMessage (note: repoUrl is no longer unique — multiple pod instances per repo)
- **pod_health_events** — id, repoPodId, repoUrl, eventType ("crashed"|"oom_killed"|"restarted"|"healthy"|"orphan_cleaned"), podName, message, createdAt
- **users** — id (uuid), provider ("github"|"google"|"gitlab"), externalId, email, displayName, avatarUrl, lastLoginAt, timestamps. Unique on (provider, externalId)
- **sessions** — id (uuid), userId (FK to users), tokenHash (unique, SHA256), expiresAt (30-day TTL), createdAt
- **ticket_providers** — id, source, config (jsonb), enabled
- **prompt_templates** — id, name, template, isDefault, repoUrl, autoMerge

## Helm Chart

At `helm/optio/`. Deploys the full stack to any K8s cluster.

Key `values.yaml` settings:

- `postgresql.enabled` / `redis.enabled` — set to `false` and use `externalDatabase.url` / `externalRedis.url` for managed services
- `encryption.key` — **required**, generate with `openssl rand -hex 32`
- `agent.imagePullPolicy` — `Never` for local dev, `IfNotPresent` or `Always` for registries
- `ingress.enabled` — set to `true` with hosts for production

The chart creates: namespace, ServiceAccount + RBAC (pod/exec/secret management), API deployment + service (with health probes), web deployment + service, conditional Postgres + Redis, configurable Ingress.

```bash
# Local dev
helm install optio helm/optio --set encryption.key=$(openssl rand -hex 32)

# Production with managed services
helm install optio helm/optio \
  --set postgresql.enabled=false \
  --set externalDatabase.url="postgres://..." \
  --set redis.enabled=false \
  --set externalRedis.url="redis://..." \
  --set encryption.key=... \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=optio.example.com
```

## Commands

```bash
# Development
pnpm install                          # Install all deps
./scripts/setup-local.sh              # Bootstrap K8s infra + DB + .env
pnpm dev                              # Start API (:4000) + Web (:3100) via Turborepo
docker build -t optio-agent:latest -f Dockerfile.agent .  # Build agent image

# Quality (these are what CI runs, and pre-commit hooks mirror them)
pnpm format:check                     # Check formatting (Prettier)
pnpm turbo typecheck                  # Typecheck all 6 packages
pnpm turbo test                       # Run tests (Vitest)
cd apps/web && npx next build         # Verify production build

# Database
cd apps/api && npx drizzle-kit generate  # Generate migration after schema change
cd apps/api && npx drizzle-kit migrate   # Apply migrations

# Images
./images/build.sh                     # Build all image presets (base, node, python, go, rust, full)

# Helm
helm lint helm/optio --set encryption.key=test
helm install optio helm/optio --set encryption.key=$(openssl rand -hex 32)
helm upgrade optio helm/optio

# Teardown
pkill -f 'kubectl port-forward.*optio'
kubectl delete namespace optio
```

## Conventions

- **ESM everywhere**: all packages use `"type": "module"` with `.js` extensions in imports (TypeScript resolves them to `.ts`)
- **Conventional commits**: enforced by commitlint via husky commit-msg hook (e.g., `feat:`, `fix:`, `refactor:`)
- **Pre-commit hooks**: lint-staged (eslint + prettier on staged files), then `pnpm format:check` and `pnpm turbo typecheck` — mirrors CI
- **Tailwind CSS v4**: `@import "tailwindcss"` + `@theme` block in CSS, no `tailwind.config` file
- **Drizzle ORM**: schema in `apps/api/src/db/schema.ts`, run `drizzle-kit generate` after changes
- **Zod**: API request validation in route handlers
- **Zustand**: use `useStore.getState()` in callbacks/effects, not hook selectors (avoids infinite re-renders)
- **WebSocket events**: published to Redis pub/sub channels, relayed to browser clients
- **Next.js webpack config**: `extensionAlias` in `next.config.ts` resolves `.js` → `.ts` for workspace packages
- **Error handling**: use the error classifier for user-facing error messages, raw errors in logs
- **State transitions**: always go through `taskService.transitionTask()` which validates, updates DB, records event, and publishes to WebSocket
- **Secrets**: never log or return secret values, only names/scopes. Encrypted at rest with AES-256-GCM
- **Cost tracking**: stored as string (`costUsd`) to avoid float precision issues

## API Routes

Key routes beyond basic CRUD:

- `POST /api/tasks/reorder` — reorder task priorities by position
- `POST /api/tasks/bulk/retry-failed` — retry all failed tasks
- `POST /api/tasks/bulk/cancel-active` — cancel all running + queued tasks
- `POST /api/tasks/:id/review` — manually launch a review agent for a task
- `POST /api/tasks/:id/subtasks` — create a subtask (child, step, or review)
- `GET /api/tasks/:id/subtasks/status` — check blocking subtask completion status
- `GET /api/issues` — browse GitHub Issues across all repos
- `POST /api/issues/assign` — assign a GitHub Issue to Optio (adds label, creates task, comments on issue)
- `GET /api/auth/claude-token` — get Claude OAuth token for max-subscription mode
- `GET /api/auth/providers` — list enabled OAuth providers
- `GET /api/auth/me` — current authenticated user profile
- `POST /api/auth/logout` — revoke session and clear cookie
- `GET /api/auth/:provider/login` — initiate OAuth login flow
- `GET /api/auth/:provider/callback` — OAuth callback handler
- `GET /api/analytics/costs` — cost analytics with daily/repo/type breakdowns

## Workers

Four BullMQ workers run as part of the API server:

1. **task-worker** — main job processor, handles concurrency, provisioning, agent execution, result parsing
2. **pr-watcher-worker** — polls GitHub PRs every 30s, tracks CI/review status, triggers reviews, handles merge/close
3. **repo-cleanup-worker** — health checks every 60s, auto-restart crashed pods, clean orphan worktrees, idle cleanup
4. **ticket-sync-worker** — syncs tickets from configured providers (GitHub Issues, Linear)

## Security Model

- **Web UI / API authentication**: Multi-provider OAuth (GitHub, Google, GitLab). Sessions use SHA256-hashed tokens stored in the database with 30-day TTL. Cookies are HttpOnly + SameSite=Lax. OAuth state parameters have 10-minute TTL for CSRF protection. Disable with `OPTIO_AUTH_DISABLED=true` for local development.
- **Secrets at rest**: AES-256-GCM encryption. Secret values are never logged or returned via API — only names and scopes are exposed.
- **Claude Code auth**: API key or OAuth token injected as env vars into pod containers. Max-subscription tokens are cached for 30 seconds with auto-refresh.
- **K8s RBAC**: ServiceAccount with scoped permissions for pod lifecycle, exec, and secret management only.
- **No role-based access control** within Optio itself — any authenticated user can perform any action. Production deployments should add RBAC or restrict at the network level.

## Troubleshooting

**Pod won't start / stays in provisioning**:

- Check `kubectl get pods -n optio` for pod status and events
- Verify the agent image exists locally: `docker images | grep optio-agent`
- Ensure `OPTIO_IMAGE_PULL_POLICY=Never` is set when using local images
- Check PVC availability: `kubectl get pvc -n optio`

**Agent fails immediately with auth error**:

- Verify `CLAUDE_AUTH_MODE` secret is set (`api-key` or `max-subscription`)
- For API key mode: ensure `ANTHROPIC_API_KEY` secret exists
- For max-subscription: check `GET /api/auth/status` for token validity

**Tasks stuck in `queued` state**:

- Check concurrency limits: `OPTIO_MAX_CONCURRENT` (global) and per-repo `maxConcurrentTasks`
- Verify no tasks are stuck in `provisioning` or `running` state (may need manual cancellation)
- Check the task worker logs for re-queue messages

**WebSocket connection drops / no live logs**:

- Ensure Redis is running and accessible
- Check that `REDIS_URL` is correctly configured
- Verify the web app's `NEXT_PUBLIC_API_URL` points to the correct API host

**Pod OOM-killed / crashed**:

- Check `pod_health_events` table for crash history
- Increase pod resource limits in the Helm chart or image preset
- The cleanup worker auto-detects crashes and fails associated tasks

**OAuth login fails**:

- Verify `API_PUBLIC_URL` and `WEB_PUBLIC_URL` match the actual deployment URLs
- Ensure OAuth callback URLs are registered with the provider (e.g., `{API_PUBLIC_URL}/api/auth/github/callback`)
- Check for `invalid_state` errors — may indicate expired CSRF tokens (>10 min between login click and callback)

**Database migration errors**:

- Run `cd apps/api && npx drizzle-kit migrate` to apply pending migrations
- Check migration status: inspect `apps/api/src/db/migrations/` for the latest migration number

## Production Deployment Checklist

1. **Encryption key**: Generate with `openssl rand -hex 32` and set via `encryption.key` in Helm values
2. **OAuth providers**: Configure at least one OAuth provider (set `*_CLIENT_ID` and `*_CLIENT_SECRET` env vars)
3. **Disable auth bypass**: Ensure `OPTIO_AUTH_DISABLED` is NOT set (or set to `false`)
4. **External database**: Use managed PostgreSQL — set `postgresql.enabled=false` and `externalDatabase.url`
5. **External Redis**: Use managed Redis — set `redis.enabled=false` and `externalRedis.url`
6. **Public URLs**: Set `API_PUBLIC_URL` and `WEB_PUBLIC_URL` to the actual deployment URLs (required for OAuth callbacks)
7. **Ingress**: Enable `ingress.enabled=true` with TLS and proper host configuration
8. **Agent image**: Push to a container registry and set `agent.imagePullPolicy=IfNotPresent` or `Always`
9. **GitHub token**: Set `GITHUB_TOKEN` secret for PR watching, issue sync, and repo detection
10. **Resource limits**: Tune pod resource requests/limits based on expected agent workload
11. **Metrics server**: Install `metrics-server` in the cluster for resource usage display

## Performance Tuning

- **`OPTIO_MAX_CONCURRENT`** (default 5): Global task concurrency. Increase for clusters with more resources.
- **`maxPodInstances`** (per-repo, default 1): Scale up for repos with high task throughput. Each instance gets its own PVC and K8s pod.
- **`maxAgentsPerPod`** (per-repo, default 2): Concurrent agents per pod. Increase if pods have sufficient CPU/memory. Total capacity = `maxPodInstances × maxAgentsPerPod`.
- **`maxConcurrentTasks`** (per-repo, default 2): Legacy concurrency limit. Effective limit is `max(maxConcurrentTasks, maxPodInstances × maxAgentsPerPod)`.
- **`OPTIO_REPO_POD_IDLE_MS`** (default 600000 / 10 min): How long idle pods persist. Increase to reduce cold starts for repos with sporadic traffic.
- **`OPTIO_PR_WATCH_INTERVAL`** (default 30s): PR polling interval. Increase to reduce GitHub API usage.
- **`OPTIO_HEALTH_CHECK_INTERVAL`** (default 60s): Health check and cleanup interval.
- **`maxTurnsCoding`** / **`maxTurnsReview`** (per-repo): Limit agent turns to control cost and runtime. Null falls back to global defaults.

## Known Issues / TODO

- Agent image must be built locally (`docker build`) — K8s can't pull it from a registry yet. Set `OPTIO_IMAGE_PULL_POLICY=Never`.
- Docker Desktop K8s needs `metrics-server` installed manually for resource usage display: `kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml` then patch with `--kubelet-insecure-tls`.
- No role-based access control within Optio — any authenticated user has full access.
