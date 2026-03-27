# Architecture Deep Dive

Detailed subsystem documentation for Optio internals. For the high-level overview, see `CLAUDE.md`.

## Multi-pod scaling

Repos can scale beyond a single pod. Two per-repo settings control this:

- **`maxPodInstances`** (default 1) -- maximum pod replicas per repository (1-20)
- **`maxAgentsPerPod`** (default 2) -- maximum concurrent agents (worktrees) per pod instance (1-50)

Total capacity = `maxPodInstances x maxAgentsPerPod`. The task worker computes `effectiveRepoConcurrency` and uses `max(maxConcurrentTasks, effectiveRepoConcurrency)` as the per-repo limit.

Pod scheduling in `repo-pool-service.ts`:

1. **Same-pod retry affinity**: if this is a retry, prefer the pod the task last ran on (via `tasks.lastPodId`)
2. **Least-loaded selection**: pick the ready pod with the lowest `activeTaskCount`
3. **Dynamic scale-up**: if all pods are at capacity and under the instance limit, create a new pod with the next `instanceIndex`
4. **Queue overflow**: if at the instance limit and all pods are full, queue the task on the least-loaded pod

Each pod instance gets its own PVC (e.g., `optio-home-repo-0`, `optio-home-repo-1`) and is labeled with `optio.instance-index`. On idle cleanup, higher-index pods are removed first (LIFO scaling).

## Worktree lifecycle management

Tasks track their worktree state via `tasks.worktreeState`:

| State       | Meaning                                        |
| ----------- | ---------------------------------------------- |
| `active`    | Worktree is in use by a running agent          |
| `dirty`     | Agent finished but worktree not yet cleaned up |
| `reset`     | Worktree was reset for a retry on the same pod |
| `preserved` | Worktree kept for manual inspection or resume  |
| `removed`   | Worktree has been cleaned up                   |

`tasks.lastPodId` records which pod the task ran on, enabling same-pod retry affinity -- retries reuse the existing worktree (reset instead of recreate) for faster restarts.

The `repo-cleanup-worker` uses worktree state to make cleanup decisions:

- **active / preserved**: leave alone
- **dirty + retries remaining**: leave for same-pod retry
- **dirty + no retries**: remove after 2-minute grace period
- **orphaned** (no matching task): remove immediately
- **terminal states** (completed/cancelled): remove after grace period

## Pod health monitoring

The `repo-cleanup-worker` runs every 60s (`OPTIO_HEALTH_CHECK_INTERVAL`) and:

1. Checks each repo pod's status via K8s API
2. Detects crashed or OOM-killed pods, records events in `pod_health_events`
3. Fails any tasks that were running on a dead pod
4. Auto-restarts: deletes the dead pod record so the next task recreates it
5. Cleans up orphaned worktrees (worktrees for completed/failed/cancelled tasks)
6. Cleans up idle pods past the timeout

## Priority queue and concurrency

Tasks have an integer `priority` field (lower = higher priority). The task worker enforces two concurrency limits:

1. **Global**: `OPTIO_MAX_CONCURRENT` (default 5) -- total running/provisioning tasks across all repos
2. **Per-repo**: `repos.maxConcurrentTasks` (default 2) -- tasks running in the same repo pod

When a limit is hit, the task is re-queued with a 10-second delay. Task reordering is supported via `POST /api/tasks/reorder` which reassigns priority values based on position.

Bulk operations: `POST /api/tasks/bulk/retry-failed` (retries all failed tasks) and `POST /api/tasks/bulk/cancel-active` (cancels all running + queued tasks).

## Subtask system

Tasks can have child tasks (`parentTaskId`). Three subtask types:

- **child** -- independent subtask
- **step** -- sequential step in a pipeline
- **review** -- code review subtask (see below)

Subtasks have `subtaskOrder` for ordering and `blocksParent` to indicate whether the parent should wait for this subtask to complete. When a blocking subtask completes, `onSubtaskComplete()` checks if all blocking subtasks are done and can advance the parent.

Routes: `GET /api/tasks/:id/subtasks`, `POST /api/tasks/:id/subtasks`, `GET /api/tasks/:id/subtasks/status`.

## Code review agent

The review system (`review-service.ts`) launches a review agent as a blocking subtask of the original coding task:

1. Triggered automatically by the PR watcher (on CI pass or PR open, per `repos.reviewTrigger`) or manually via `POST /api/tasks/:id/review`
2. Creates a review subtask with `taskType: "review"`, `blocksParent: true`
3. Builds a review-specific prompt using `repos.reviewPromptTemplate` (or default) with variables: `{{PR_NUMBER}}`, `{{TASK_FILE}}`, `{{REPO_NAME}}`, `{{TASK_TITLE}}`, `{{TEST_COMMAND}}`
4. Uses `repos.reviewModel` (defaults to "sonnet") -- allows using a cheaper model for reviews
5. The review task runs in the same repo pod, scoped to the PR branch
6. Parent task waits for the review to complete before advancing

## PR watcher

`pr-watcher-worker.ts` runs as a BullMQ repeating job every 30s (`OPTIO_PR_WATCH_INTERVAL`). For each task in `pr_opened` state:

1. Fetches PR data, check runs, and reviews from the GitHub API
2. Updates task fields: `prNumber`, `prState`, `prChecksStatus`, `prReviewStatus`, `prReviewComments`
3. Triggers review agent if CI just passed and `repos.reviewEnabled` + `repos.reviewTrigger === "on_ci_pass"`
4. Triggers review agent on first PR detection if `repos.reviewTrigger === "on_pr"`
5. On PR merge: transitions task to `completed`
6. On PR close without merge: transitions task to `failed`
7. On "changes requested" review with `repos.autoResumeOnReview`: transitions to `needs_attention` then re-queues with the review comments as a resume prompt

## How a task runs (detailed flow)

1. User creates task via UI, ticket sync, or GitHub Issue assignment
2. `POST /api/tasks` inserts row, transitions `pending -> queued`, adds BullMQ job with priority
3. Task worker picks up job:
   - **Concurrency check**: verifies global and per-repo limits; re-queues with delay if exceeded
   - Reads `CLAUDE_AUTH_MODE` secret to determine auth method
   - Loads prompt template for the repo (repo override -> global default -> hardcoded)
   - Renders prompt with `{{TASK_FILE}}`, `{{BRANCH_NAME}}`, etc.
   - Renders task file (markdown with title + description)
   - Applies per-repo Claude settings (model, context window, thinking, effort)
   - For review tasks: applies review-specific prompt, task file, and model overrides
   - Calls `adapter.buildContainerConfig()` which produces env vars + setup files
   - For max-subscription auth: fetches `CLAUDE_CODE_OAUTH_TOKEN` from the auth service
   - Calls `repoPool.getOrCreateRepoPod()` -- finds existing pod or creates one
   - Calls `repoPool.execTaskInRepoPod()` which execs a bash script:
     - `git fetch origin && git worktree add /workspace/tasks/{taskId}`
     - Decodes `OPTIO_SETUP_FILES` (base64 JSON) -> writes `.optio/task.md` + auth helpers
     - Runs `claude -p "..." --dangerously-skip-permissions --output-format stream-json --verbose --max-turns 50`
     - Cleanup: `git worktree remove`
4. Worker streams exec session stdout, parsing each NDJSON line via `agent-event-parser.ts`
5. Session ID is captured from the first event and stored on the task
6. PR URLs are detected in log output and stored
7. Cost (USD) is extracted from the agent result and stored on the task
8. On completion: `running -> pr_opened` or `running -> completed` or `running -> failed`
9. If this is a subtask, `onSubtaskComplete()` checks if the parent should advance
10. The repo pod stays alive for the next task

## Prompt templates

System prompts use a simple template language:

- `{{VARIABLE}}` -- replaced with the variable value
- `{{#if VAR}}...{{else}}...{{/if}}` -- conditional blocks (truthy if non-empty, not "false", not "0")

Standard variables: `{{TASK_FILE}}`, `{{BRANCH_NAME}}`, `{{TASK_ID}}`, `{{TASK_TITLE}}`, `{{REPO_NAME}}`, `{{AUTO_MERGE}}`.

Review-specific variables: `{{PR_NUMBER}}`, `{{TEST_COMMAND}}`.

Priority: repo-level override (`repos.promptTemplateOverride`) -> global default (`prompt_templates` table) -> hardcoded fallback in `packages/shared/src/prompt-template.ts`.

## Auto-detect image preset

When adding a repo, `repo-detect-service.ts` queries the GitHub API for root-level files and selects the image preset:

- `Cargo.toml` -> rust, `package.json` -> node, `go.mod` -> go, `pyproject.toml`/`setup.py`/`requirements.txt` -> python
- Multiple languages -> full
- Also detects `testCommand` (e.g., `cargo test`, `npm test`, `go test ./...`, `pytest`)

## Structured log parsing

Claude Code's `--output-format stream-json` produces NDJSON. Each line is parsed by `agent-event-parser.ts` into typed `AgentLogEntry` objects with types: `text`, `tool_use`, `tool_result`, `thinking`, `system`, `error`, `info`. The session ID is extracted from the first event. These are stored in `task_logs` with `log_type` and `metadata` columns.

## Error classification

When tasks fail, the error message is pattern-matched by `packages/shared/src/error-classifier.ts` into categories (image, auth, network, timeout, agent, state, resource) with human-readable titles, descriptions, and suggested remedies. This powers both the task detail error panel and the task card previews.

## Cost tracking analytics

`GET /api/analytics/costs` (`apps/api/src/routes/analytics.ts`) provides cost analytics with optional `days` (default 30) and `repoUrl` query params. Returns:

- **summary** -- total cost, task count, average cost, cost trend (% change vs previous period)
- **dailyCosts** -- per-day cost and task count breakdown
- **costByRepo** -- cost aggregated by repository
- **costByType** -- cost aggregated by task type (coding vs review)
- **topTasks** -- 10 most expensive tasks

The web UI at `/costs` renders this data with Recharts charts. Period selector (7d/14d/30d/90d) and repo filter are available.

## Slack notifications

`slack-service.ts` sends rich Block Kit messages to Slack when tasks transition to notifiable states. Supports per-repo and global webhook configuration.

**Configuration** (per-repo fields in `repos` table):

- `slackWebhookUrl` -- incoming webhook URL (per-repo, overrides global)
- `slackChannel` -- optional channel override
- `slackNotifyOn` -- JSONB array of states to notify on (default: `["completed","failed","needs_attention","pr_opened"]`)
- `slackEnabled` -- boolean toggle (default: `false`)

A global fallback webhook can be set via the `SLACK_WEBHOOK_URL` secret (stored in the secrets table, not an env var).

**Message format**: Block Kit attachments with status emoji, repo name, cost, PR link, and action buttons:

- "View Logs" -- always present, links to task in web UI
- "Retry" -- on failed tasks, transitions to `queued`
- "Cancel" -- on failed or `needs_attention` tasks, transitions to `cancelled`

**Interactive actions**: Button clicks POST to `POST /api/webhooks/slack/actions`, which validates the payload and performs the requested task transition.

**Integration point**: `task-service.ts` calls `notifySlackOnTransition()` on every state transition. Notifications are fire-and-forget (failures are logged, never thrown).

## Task dependencies and workflows

Tasks can depend on other tasks (`task_dependencies` table). The task worker checks `areDependenciesMet()` before starting a task and cascades failures. Workflow templates define multi-step pipelines (`workflow_templates`, `workflow_runs`).
