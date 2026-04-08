# CLAUDE.md

Context and conventions for AI assistants working on the Optio codebase.

## What is Optio?

Optio is a workflow orchestration system for AI coding agents. Think of it as "CI/CD where the build step is an AI agent." Users submit tasks (manually or from GitHub Issues, Linear, Jira, or Notion), and Optio:

1. Spins up an isolated Kubernetes pod for the repository (pod-per-repo)
2. Creates a git worktree for the task (multiple tasks can run concurrently per repo)
3. Runs Claude Code, OpenAI Codex, or GitHub Copilot with a configurable prompt
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
│  :30310     │     │   :30400     │     │  ┌─ Repo Pod A ──┐  │
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

All services run in Kubernetes (including API and web). Local dev uses
Docker Desktop K8s with Helm. See setup-local.sh.
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

**Local dev bypass**: Set `OPTIO_AUTH_DISABLED=true` (API and web middleware) to skip all auth checks. `GET /api/auth/me` returns a synthetic "Local Dev" user.

**Key routes**:

- `GET /api/auth/providers` — list enabled providers
- `GET /api/auth/me` — current user profile
- `POST /api/auth/logout` — revoke session and clear cookie

### Authentication (Claude Code)

Three modes, selected during the setup wizard:

**API Key mode**: `ANTHROPIC_API_KEY` is injected as an env var into the container. Simple, pay-per-use.

**OAuth Token mode** (recommended for k8s): User extracts their Claude Max/Pro OAuth token from the macOS Keychain via a one-liner in the setup wizard, then pastes it. The token is stored as an encrypted secret (`CLAUDE_CODE_OAUTH_TOKEN`) and injected into agent pods. This gives full subscription access including usage tracking.

**Max Subscription mode** (legacy, local dev only): The API server reads credentials directly from the host's macOS Keychain or `~/.claude/.credentials.json`. Only works when the API runs on the host machine, not in k8s.

The auth service is at `apps/api/src/services/auth-service.ts`. For usage tracking, it falls back to reading `CLAUDE_CODE_OAUTH_TOKEN` from the secrets store when the Keychain is unavailable (k8s deployments).

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

| Layer      | Technology                       | Notes                                                                              |
| ---------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| Monorepo   | Turborepo + pnpm 10              | 6 packages, workspace protocol                                                     |
| API        | Fastify 5                        | Plugins, schema validation, WebSocket                                              |
| ORM        | Drizzle                          | PostgreSQL, generated migrations in `apps/api/src/db/migrations/` (~28 migrations) |
| Queue      | BullMQ + Redis                   | Also used for pub/sub (log streaming to WebSocket clients)                         |
| Web        | Next.js 15 App Router            | Tailwind CSS v4, Zustand, Lucide icons, sonner toasts, Recharts                    |
| K8s client | @kubernetes/client-node          | Pod lifecycle, exec, log streaming, metrics                                        |
| Validation | Zod                              | API request schemas                                                                |
| Testing    | Vitest                           | Test files across shared + api                                                     |
| CI         | GitHub Actions                   | Format, typecheck, test, build-web, build-image                                    |
| Deploy     | Helm                             | Chart at `helm/optio/`, local dev via `setup-local.sh`                             |
| Hooks      | Husky + lint-staged + commitlint | Pre-commit: lint-staged + format + typecheck. Commit-msg: conventional commits     |

## Directory Layout

```
apps/
  api/
    src/
      routes/         health, tasks, subtasks, bulk, secrets, repos, issues, tickets, setup, auth,
                      cluster, resume, prompt-templates, analytics, webhooks, comments, schedules,
                      slack, task-templates, workspaces, dependencies, workflows, mcp-servers,
                      sessions, skills, shared-directories
      services/       task-service, repo-pool-service, secret-service, auth-service, container-service,
                      prompt-template-service, repo-service, repo-detect-service, review-service,
                      subtask-service, ticket-sync-service, event-bus, agent-event-parser,
                      session-service, interactive-session-service, workspace-service, webhook-service,
                      comment-service, schedule-service, slack-service, task-template-service,
                      workflow-service, dependency-service, mcp-server-service, skill-service,
                      shared-directory-service,
                      oauth/ (github, google, gitlab)
      plugins/        auth (session validation middleware)
      workers/        task-worker (main job processor), pr-watcher-worker, repo-cleanup-worker,
                      ticket-sync-worker, webhook-worker, schedule-worker
      ws/             log-stream (per-task), events (global), session-terminal, session-chat, ws-auth
      db/             schema.ts (Drizzle ~26 tables), client.ts, migrations/ (~28 migrations)
    drizzle.config.ts
  web/
    src/
      app/            Pages: / (overview), /tasks, /tasks/new, /tasks/[id], /repos, /repos/[id],
                      /cluster, /cluster/[id], /secrets, /settings, /setup, /costs, /login,
                      /sessions, /sessions/[id], /templates, /workspace-settings, /schedules,
                      /workflows
      components/     task-card, task-list, log-viewer, web-terminal, event-timeline, state-badge,
                      skeleton, session-terminal, session-chat, split-pane, activity-feed,
                      pipeline-timeline,
                      layout/ (sidebar, layout-shell, setup-check, ws-provider, user-menu,
                      theme-provider, themed-toaster, workspace-switcher)
      middleware.ts   Next.js auth middleware (redirects unauthenticated users to /login)
      hooks/          use-store (Zustand), use-websocket, use-task, use-logs
      lib/            api-client, ws-client, ws-auth, utils

packages/
  shared/             Types (task, agent, container, secret, ticket, events, image, agent-events,
                      session, workspace, mcp), state machine, prompt template renderer,
                      error classifier, constants, normalize-repo-url
  container-runtime/  ContainerRuntime interface, DockerContainerRuntime, KubernetesContainerRuntime
  agent-adapters/     AgentAdapter interface, ClaudeCodeAdapter, CodexAdapter, CopilotAdapter
  ticket-providers/   TicketProvider interface, GitHubTicketProvider, LinearTicketProvider, JiraTicketProvider, NotionTicketProvider

Dockerfile.api        API server Docker image (tsx-based)
Dockerfile.web        Web UI Docker image (Next.js production build)
Dockerfile.agent      Legacy agent image
images/               Agent preset Dockerfiles: base, node, python, go, rust, full + build.sh
helm/optio/           Helm chart: api, web, postgres, redis, ingress, rbac, secrets
scripts/              setup-local.sh, update-local.sh, repo-init.sh, agent-entrypoint.sh
```

## Database Schema

~26 tables (Drizzle, ~28 migrations). Key tables:

**Core:**

- **tasks** — id, title, prompt, repoUrl, repoBranch, state (enum), agentType, containerId, sessionId, prUrl, prNumber, prState, prChecksStatus, prReviewStatus, prReviewComments, resultSummary, costUsd, inputTokens, outputTokens, modelUsed, errorMessage, ticketSource, ticketExternalId, metadata (jsonb), retryCount, maxRetries, priority, parentTaskId, taskType, subtaskOrder, blocksParent, worktreeState, lastPodId, workspaceId, createdBy, timestamps
- **task_events** — id, taskId, fromState, toState, trigger, message, userId, createdAt
- **task_logs** — id, taskId, stream, content, logType, metadata (jsonb), timestamp
- **task_comments** — id, taskId, userId, content, timestamps
- **task_dependencies** — id, taskId, dependsOnTaskId, createdAt
- **task_templates** — id, name, description, repoUrl, prompt, agentType, metadata, workspaceId

**Infrastructure:**

- **repos** — id, repoUrl, fullName, defaultBranch, isPrivate, imagePreset, autoMerge, claudeModel, claudeContextWindow, claudeThinking, claudeEffort, autoResume, maxConcurrentTasks, maxPodInstances, maxAgentsPerPod, reviewEnabled, reviewTrigger, slackEnabled, slackWebhookUrl, workspaceId, etc.
- **repo_pods** — id, repoUrl, repoBranch, podName, podId, state, activeTaskCount, instanceIndex, cachePvcName, cachePvcState, workspaceId
- **repo_shared_directories** — id, repoId, workspaceId, name, description, mountLocation, mountSubPath, sizeGi, scope, createdBy, lastClearedAt, lastMountedAt, timestamps
- **pod_health_events** — id, repoPodId, repoUrl, eventType, podName, message, createdAt
- **secrets** — id, name, scope, encryptedValue (bytea), iv, authTag (AES-256-GCM), workspaceId

**Auth & Multi-tenancy:**

- **users** — id, provider, externalId, email, displayName, avatarUrl, defaultWorkspaceId, timestamps
- **sessions** — id, userId, tokenHash (SHA256), expiresAt (30-day TTL), createdAt
- **workspaces** — id, name, slug, description, createdBy, timestamps
- **workspace_members** — id, workspaceId, userId, role (admin/member/viewer), createdAt

**Interactive Sessions:**

- **interactive_sessions** — id, repoUrl, userId, worktreePath, branch, state (active/ended), podId, costUsd, timestamps
- **session_prs** — id, sessionId, prUrl, prNumber, prState, prChecksStatus, prReviewStatus, timestamps

**Integrations:**

- **webhooks** — id, url, events (jsonb), secret, active, workspaceId
- **webhook_deliveries** — id, webhookId, event, payload, statusCode, success, deliveredAt
- **ticket_providers** — id, source, config (jsonb), enabled
- **prompt_templates** — id, name, template, isDefault, repoUrl, autoMerge
- **schedules** / **schedule_runs** — scheduled/recurring task execution
- **workflow_templates** / **workflow_runs** — multi-step workflow automation
- **mcp_servers** — MCP server configs (global or per-repo)
- **custom_skills** — custom agent skills/commands

## Helm Chart

At `helm/optio/`. Deploys the full stack to any K8s cluster.

Key `values.yaml` settings:

- Image defaults point to GHCR (`ghcr.io/jonwiggins/optio-*`) with `pullPolicy: IfNotPresent` — works on any cluster out of the box
- `agent.image.prefix` — controls how preset images (base, node, python, …) are resolved. Default: `ghcr.io/jonwiggins/optio-agent-`. Set to `optio-` for local dev
- `postgresql.enabled` / `redis.enabled` — set to `false` and use `externalDatabase.url` / `externalRedis.url` for managed services
- `encryption.key` — **required**, generate with `openssl rand -hex 32`
- `ingress.enabled` — set to `true` with hosts for production

Local dev overrides live in `helm/optio/values.local.yaml` (short image names, `pullPolicy: Never`, `auth.disabled`, NodePort services). `setup-local.sh` applies this automatically.

The chart creates: namespace, ServiceAccount + RBAC (pod/exec/secret management), API deployment + service (with health probes), web deployment + service, conditional Postgres + Redis, configurable Ingress.

```bash
# Local dev (setup-local.sh handles this automatically)
helm install optio helm/optio -n optio --create-namespace \
  -f helm/optio/values.local.yaml \
  --set encryption.key=$(openssl rand -hex 32)

# Production with managed services
helm install optio helm/optio -n optio --create-namespace \
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
# Setup (first time — builds everything, deploys to local k8s via Helm)
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
cd apps/api && npx drizzle-kit generate  # Generate migration after schema change (uses unix-timestamp prefixes)
cd apps/api && npx tsx src/db/migrate.ts  # Apply migrations to DATABASE_URL (standalone runner for CI/testing)
bash scripts/check-migration-prefixes.sh  # Check for duplicate numeric prefixes

# Agent images
./images/build.sh                     # Build all image presets (base, node, python, go, rust, full)

# Helm
helm lint helm/optio --set encryption.key=test
helm upgrade optio helm/optio -n optio --reuse-values

# Teardown
helm uninstall optio -n optio
```

## Conventions

- **ESM everywhere**: all packages use `"type": "module"` with `.js` extensions in imports (TypeScript resolves them to `.ts`)
- **Conventional commits**: enforced by commitlint via husky commit-msg hook (e.g., `feat:`, `fix:`, `refactor:`)
- **Pre-commit hooks**: lint-staged (eslint + prettier on staged files), then `pnpm format:check` and `pnpm turbo typecheck` — mirrors CI
- **Tailwind CSS v4**: `@import "tailwindcss"` + `@theme` block in CSS, no `tailwind.config` file
- **Drizzle ORM**: schema in `apps/api/src/db/schema.ts`, run `drizzle-kit generate` after changes. **New migrations use unix-timestamp prefixes** (`migrations.prefix: "unix"` in `drizzle.config.ts`) to prevent collisions from concurrent branches. Existing `00xx_*` files are frozen — never rename them. A CI job applies all migrations against a fresh Postgres to catch drift. `scripts/check-migration-prefixes.sh` blocks new duplicate numeric prefixes (historical ones are allowlisted)
- **Zod**: API request validation in route handlers
- **Zustand**: use `useStore.getState()` in callbacks/effects, not hook selectors (avoids infinite re-renders)
- **WebSocket events**: published to Redis pub/sub channels, relayed to browser clients
- **Next.js webpack config**: `extensionAlias` in `next.config.ts` resolves `.js` → `.ts` for workspace packages
- **Error handling**: use the error classifier for user-facing error messages, raw errors in logs
- **State transitions**: always go through `taskService.transitionTask()` which validates, updates DB, records event, and publishes to WebSocket
- **Secrets**: never log or return secret values, only names/scopes. Encrypted at rest with AES-256-GCM
- **Cost tracking**: stored as string (`costUsd`) to avoid float precision issues

### Shared cache directories

Per-repo persistent cache directories that survive across tasks and pod recreation. Backed by K8s PVCs with `ReadWriteOnce` access mode (works on any cluster).

**Architecture**: one PVC per pod instance (`optio-cache-{repoSlug}-{instanceIndex}`), sized as the sum of all shared directory sizes. Each shared directory is a `subPath` mount within that PVC. This avoids per-node volume attach limits.

**Schema**: `repo_shared_directories` table stores the logical directory entries. `repo_pods.cache_pvc_name` / `cache_pvc_state` track PVC bookkeeping.

**Mount locations**:

- `mountLocation: home` — mounts at `/home/agent/<mountSubPath>` (e.g., `.npm`, `.cache/pip`). Tool caches work automatically without env vars.
- `mountLocation: workspace` — mounts at `/workspace/<mountSubPath>` (e.g., `.optio-cache/node-modules`). For build artifacts.

**Routes**:

- `GET /api/repos/:id/shared-directories` — list (member)
- `POST /api/repos/:id/shared-directories` — create (admin)
- `PATCH /api/repos/:id/shared-directories/:dirId` — update (admin)
- `DELETE /api/repos/:id/shared-directories/:dirId` — delete + cleanup (admin)
- `POST /api/repos/:id/shared-directories/:dirId/clear` — clear contents via exec (admin)
- `POST /api/repos/:id/shared-directories/:dirId/usage` — check disk usage (member)
- `POST /api/repos/:id/pods/recycle` — destroy idle pods so they recreate with new mounts (admin)

**Common cache recipes**:

| Tool        | Name           | Location | Sub-path                | Size |
| ----------- | -------------- | -------- | ----------------------- | ---- |
| npm         | npm-cache      | home     | .npm                    | 10Gi |
| pnpm        | pnpm-store     | home     | .local/share/pnpm/store | 10Gi |
| pip         | pip-cache      | home     | .cache/pip              | 10Gi |
| cargo       | cargo-registry | home     | .cargo/registry         | 20Gi |
| Go          | go-mod         | home     | go/pkg/mod              | 10Gi |
| HuggingFace | huggingface    | home     | .cache/huggingface      | 50Gi |

**Constraints**: name is a slug (1-40 chars, `^[a-z0-9](-?[a-z0-9])*$`), size 1-100Gi per dir, 200Gi total per repo. Only `per-pod` scope is supported in v1; `per-repo` (RWX) is reserved for a follow-up.

**Helm config** (`values.yaml`): `agent.cache.enabled`, `agent.cache.storageClass`, `agent.cache.maxSizePerDirectoryGi`, `agent.cache.maxSizeTotalGi`, `agent.cache.defaultSizePerDirectoryGi`.

### Interactive sessions

Sessions provide persistent, interactive workspaces connected to repo pods:

- `POST /api/sessions` — create a session (provisions worktree in repo pod)
- `GET /api/sessions` — list sessions (filterable by state, repo)
- `POST /api/sessions/:id/end` — end session (cleanup worktree)
- `WS /ws/sessions/:id/terminal` — xterm.js WebSocket for interactive terminal
- `WS /ws/sessions/:id/chat` — interactive Claude Code chat session

Sessions track PRs opened during the session (`session_prs` table) and cost. The web UI at `/sessions` provides a terminal + agent chat split pane.

### Workspaces (multi-tenancy)

Resources are scoped to workspaces. Key tables (`workspaces`, `workspace_members`) with roles (admin/member/viewer). A default workspace is created on first setup. Most tables have a `workspaceId` column for scoping.

### Task dependencies and workflows

Tasks can depend on other tasks (`task_dependencies` table). The task worker checks `areDependenciesMet()` before starting a task and cascades failures. Workflow templates define multi-step pipelines (`workflow_templates`, `workflow_runs`).

## API Routes

Key routes beyond basic CRUD:

- `POST /api/tasks/reorder` — reorder task priorities by position
- `POST /api/tasks/bulk/retry-failed` — retry all failed tasks
- `POST /api/tasks/bulk/cancel-active` — cancel all running + queued tasks
- `POST /api/tasks/:id/review` — manually launch a review agent for a task
- `POST /api/tasks/:id/resume` — resume a needs_attention/failed task (session-based)
- `POST /api/tasks/:id/force-restart` — fresh agent session on existing PR branch
- `POST /api/tasks/:id/force-redo` — clear everything and re-run from scratch
- `POST /api/tasks/:id/subtasks` — create a subtask (child, step, or review)
- `POST /api/tasks/:id/comments` — add a comment to a task
- `GET /api/sessions` / `POST /api/sessions` — interactive session management
- `GET /api/issues` — browse GitHub Issues across all repos
- `POST /api/issues/assign` — assign a GitHub Issue to Optio
- `GET /api/auth/providers` — list enabled OAuth providers
- `GET /api/auth/me` — current user profile
- `GET /api/auth/status` — Claude subscription status (checks Keychain + secrets store)
- `GET /api/auth/usage` — Claude Max/Pro usage metrics
- `GET /api/analytics/costs` — cost analytics with daily/repo/type breakdowns
- `GET /api/workspaces` — workspace management
- `GET /api/webhooks` — webhook configuration
- `GET /api/schedules` — scheduled/recurring task management
- `GET /api/mcp-servers` — MCP server configuration
- `GET /api/skills` — custom skill management

## Workers

Six BullMQ workers run as part of the API server:

1. **task-worker** — main job processor, handles concurrency, dependency checks, provisioning, agent execution, result parsing
2. **pr-watcher-worker** — polls GitHub PRs every 30s, tracks CI/review status, triggers reviews, auto-resumes on conflicts/failures, handles merge/close
3. **repo-cleanup-worker** — health checks every 60s, auto-restart crashed pods, clean orphan worktrees, idle cleanup
4. **ticket-sync-worker** — syncs tickets from configured providers (GitHub Issues, Linear, Jira, Notion)
5. **webhook-worker** — delivers webhook events to configured endpoints
6. **schedule-worker** — checks and triggers scheduled/recurring tasks

## Security Model

- **Web UI / API authentication**: Multi-provider OAuth (GitHub, Google, GitLab). Sessions use SHA256-hashed tokens stored in the database with 30-day TTL. Cookies are HttpOnly + SameSite=Lax. OAuth state parameters have 10-minute TTL for CSRF protection. Disable with `OPTIO_AUTH_DISABLED=true` for local development.
- **Secrets at rest**: AES-256-GCM encryption. Secret values are never logged or returned via API — only names and scopes are exposed.
- **Claude Code auth**: Three modes — API key (`ANTHROPIC_API_KEY`), OAuth token from secrets store (`CLAUDE_CODE_OAUTH_TOKEN`), or host Keychain (legacy local dev). Token injected as env var into agent pods.
- **K8s RBAC**: ServiceAccount with namespace-scoped Role (pods, exec, secrets, PVCs, services, events) + ClusterRole (nodes, namespaces, metrics).
- **Multi-tenancy**: Workspace-scoped resources. Workspace roles (admin/member/viewer) are in the schema but enforcement is partial.

## Troubleshooting

**Pod won't start / stays in provisioning**:

- Check `kubectl get pods -n optio` for pod status and events
- Verify the agent image exists locally: `docker images | grep optio-agent`
- Ensure `OPTIO_IMAGE_PULL_POLICY=Never` is set when using local images
- Check PVC availability: `kubectl get pvc -n optio`

**Agent fails immediately with auth error**:

- Verify `CLAUDE_AUTH_MODE` secret is set (`api-key` or `oauth-token`)
- For API key mode: ensure `ANTHROPIC_API_KEY` secret exists
- For OAuth token mode: ensure `CLAUDE_CODE_OAUTH_TOKEN` secret exists
- Check `GET /api/auth/status` for token validity

**Tasks stuck in `queued` state**:

- Check concurrency limits: `OPTIO_MAX_CONCURRENT` (global) and per-repo `maxConcurrentTasks`
- Verify no tasks are stuck in `provisioning` or `running` state (may need manual cancellation)
- Check the task worker logs for re-queue messages

**WebSocket connection drops / no live logs**:

- Ensure Redis is running and accessible
- Check that `REDIS_URL` is correctly configured
- Verify the web app's `INTERNAL_API_URL` points to the correct API host

**Pod OOM-killed / crashed**:

- Check `pod_health_events` table for crash history
- Increase pod resource limits in the Helm chart or image preset
- The cleanup worker auto-detects crashes and fails associated tasks

**OAuth login fails**:

- Verify `PUBLIC_URL` matches the actual deployment URL
- Ensure OAuth callback URLs are registered with the provider (e.g., `{PUBLIC_URL}/api/auth/github/callback`)
- Check for `invalid_state` errors — may indicate expired CSRF tokens (>10 min between login click and callback)

**Database migration errors**:

- Migrations auto-run on API server startup (via `drizzle-orm/postgres-js/migrator`)
- To manually generate a new migration: `cd apps/api && npx drizzle-kit generate`
- Historical duplicate-numbered migration files are allowlisted. A repair migration ensures no columns are missing. New migrations use unix-timestamp prefixes (`migrations.prefix: "unix"` in `drizzle.config.ts`) to prevent future collisions.
- CI runs `scripts/check-migration-prefixes.sh` and applies migrations to a fresh Postgres to catch drift. Use `tsx src/db/migrate.ts` to test migrations locally.

## Production Deployment Checklist

1. **Encryption key**: Generate with `openssl rand -hex 32` and set via `encryption.key` in Helm values
2. **OAuth providers**: Configure at least one OAuth provider (set `*_CLIENT_ID` and `*_CLIENT_SECRET` env vars)
3. **Disable auth bypass**: Ensure `OPTIO_AUTH_DISABLED` is NOT set (or set to `false`)
4. **External database**: Use managed PostgreSQL — set `postgresql.enabled=false` and `externalDatabase.url`
5. **External Redis**: Use managed Redis — set `redis.enabled=false` and `externalRedis.url`
6. **Public URL**: Set `PUBLIC_URL` to the actual deployment URL (required for OAuth callbacks)
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

- Agent images are published to GHCR via `release.yml` on tag push. Local dev builds images locally via `setup-local.sh`
- `setup-local.sh` installs `metrics-server` automatically; production clusters should install it separately
- Workspace RBAC roles (admin/member/viewer) are in the schema but not fully enforced in all routes
- All four ticket providers are implemented (GitHub Issues, Linear, Jira, and Notion)
- Historical duplicate-numbered migration files (prefixes 0016, 0018, 0019, 0026, 0039, 0042) are allowlisted in `scripts/check-migration-prefixes.sh`. A repair migration (`1775613995_repair_duplicate_migrations.sql`) idempotently ensures all objects from these duplicates exist. New migrations use unix-timestamp prefixes to prevent future collisions
- OAuth tokens from `claude setup-token` have limited scopes and may not support usage tracking (Keychain-extracted tokens have full scopes)
- The API container runs via `tsx` (TypeScript execution) rather than compiled JS, since workspace packages export `./src/index.ts` not `./dist/index.js`
