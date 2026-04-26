# Tasks: Repo Tasks, Standalone Tasks, and Persistent Agents

Optio's runtime tier has three flavors:

1. **Repo Task** — agent runs in a worktree, opens a PR, terminates.
2. **Standalone Task** — agent runs once with no repo, produces side effects, terminates.
3. **Persistent Agent** — long-lived, named, message-driven; _doesn't terminate_. See [persistent-agents.md](persistent-agents.md).

The first two share most of the pipeline (prompts, triggers, agent config, run history, logs, costs) — they're separated only by whether a repo is attached. Persistent Agents are a distinct runtime model: turns are inputs to a long-lived process, rather than the unit of work itself.

This guide covers the two Task flavors, when to use each, and how the unified `/api/tasks` HTTP layer presents them. For Persistent Agents see [persistent-agents.md](persistent-agents.md).

## The two flavors

### Repo Task — has a repo

A Repo Task targets a specific repository and ends by opening a pull request. The pipeline:

1. Find or spin up an isolated Kubernetes pod for the repo (pod-per-repo).
2. Create a git worktree for the task — multiple tasks can run concurrently on one pod.
3. Run the configured agent (Claude Code, Codex, Copilot, Gemini, OpenCode) with the rendered prompt.
4. Stream structured logs back to the web UI in real time.
5. The agent stops after opening a PR — it does not block on CI.
6. The PR watcher tracks CI checks, review status, and merge state.
7. If enabled, auto-trigger the code-review agent on CI pass or PR open.
8. If enabled, auto-resume the agent when reviewers request changes.
9. Auto-complete on merge; auto-fail on close.

Use a Repo Task when the work produces code: bug fixes, features, refactors, dependency bumps, doc edits — anything that wants to land as a reviewed PR.

### Standalone Task — no repo

A Standalone Task runs an agent in an isolated pod with no repo checkout. It produces logs and side effects: querying Slack, writing to a database, posting a report, calling an MCP server, triaging a ticket queue.

Use a Standalone Task when the work is not code: scheduled reports, cron-driven triage, webhook responses, on-demand operational scripts.

## Three task types in the data model

The user-facing flavors are backed by three internal types. The distinction is whether the row is a _blueprint_ (definition that spawns runs) or a _one-off run_:

| Type             | Backing table  | Purpose                                                | Has runs           | Has triggers |
| ---------------- | -------------- | ------------------------------------------------------ | ------------------ | ------------ |
| `repo-task`      | `tasks`        | Ad-hoc one-time Repo Task                              | No (it _is_ a run) | No           |
| `repo-blueprint` | `task_configs` | Reusable Repo Task definition that spawns `tasks`      | Yes                | Yes          |
| `standalone`     | `workflows`    | Standalone Task definition that spawns `workflow_runs` | Yes                | Yes          |

A blueprint plus a fired trigger produces a run. The same trigger types (`manual`, `schedule`, `webhook`, `ticket`) work for both `repo-blueprint` and `standalone` because the trigger table is polymorphic — see [Triggers](#triggers) below.

> **Backend-naming note.** The schema still says `workflows`, `workflow_runs`, and `workflow_triggers` for historical reasons. User-facing copy is always "Task" / "Repo Task" / "Standalone Task". Routes follow the same rule: `/api/tasks` is the canonical surface; `/api/jobs/*` and `/api/task-configs/*` are back-compat aliases.

## The unified `/api/tasks` HTTP layer

All three types are reachable through one polymorphic resource. The server resolves an ID across all three tables; UUIDs are globally unique so there is no collision.

| Endpoint                                                         | Purpose                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /api/tasks?type=repo-task\|repo-blueprint\|standalone\|all` | Unified list, filterable by type                                                                 |
| `POST /api/tasks`                                                | Create. Body takes `{ type, ... }` and dispatches to the right service                           |
| `GET /api/tasks/:id`                                             | Resolve across tables; returns the native row tagged with `type`                                 |
| `GET/POST /api/tasks/:id/runs[/:runId]`                          | List/start runs (spawned `tasks` for blueprints, `workflow_runs` for standalone, 405 for ad-hoc) |
| `GET/POST/PATCH/DELETE /api/tasks/:id/triggers[/:triggerId]`     | Manage triggers (405 for ad-hoc repo-task)                                                       |

The resolver lives in `apps/api/src/services/unified-task-service.ts` (`resolveAnyTaskById`) and checks `tasks` → `task_configs` → `workflows` in order. The polymorphic routes are in `apps/api/src/routes/tasks-unified.ts`.

Legacy `/api/jobs/*` and `/api/task-configs/*` endpoints still work as thin aliases.

## How they appear in the UI

The web UI hides the schema split entirely.

- **`/tasks`** — the main hub.
  - **Repo Tasks** tab: ad-hoc and blueprint-spawned `tasks` runs. Bulk actions, state filters, real-time WebSocket updates.
  - **Standalone** tab: `workflows` (blueprints) with their runs and triggers. One-click "Run Now."
  - **Issues** tab: GitHub Issues across connected repos. "Assign to Optio" creates an ad-hoc Repo Task.
  - **Pull Requests** tab: PR browser with CI / review / merge tracking.
- **`/tasks/scheduled`** — manage `repo-blueprint` rows: schedule, webhook, ticket, manual triggers; pause/resume; run-now.
- **`/jobs`**, **`/jobs/:id`**, **`/jobs/:id/runs/:runId`** — Standalone detail and run views (the legacy "jobs" route names live on under the hood).

## Triggers

Triggers live in one polymorphic table, `workflow_triggers`, keyed by `(target_type, target_id)`. `target_type` is `"job"` (Standalone) or `"task_config"` (Repo blueprint). Trigger types: `manual`, `schedule` (cron), `webhook`, `ticket`.

The `workflow-trigger-worker` polls due schedule triggers every 60 seconds (`OPTIO_WORKFLOW_TRIGGER_INTERVAL`) and dispatches:

- `target_type="job"` → `workflowService.createWorkflowRun()` → spawns a `workflow_runs` row.
- `target_type="task_config"` → `taskConfigService.instantiateTask()` → renders the blueprint's prompt with trigger params, creates a `tasks` row, transitions it to `queued`, and enqueues the BullMQ job.

## Templates and parameters

Both blueprint types use the same template engine: `{{param}}` substitution and `{{#if param}}...{{/if}}` blocks. Templates render lazily at trigger-firing time, so values from the trigger payload (cron-formatted timestamps, webhook bodies, ticket fields) substitute into the prompt before the agent ever sees it.

Reusable templates live in `prompt_templates` with a `kind` discriminator (`prompt` / `review` / `job` / `task`). Template precedence: repo override → global default → hardcoded fallback.

## Service map

| Concern                | Service                                                                      | Routes                                              |
| ---------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| Polymorphic resolution | `services/unified-task-service.ts`                                           | `routes/tasks-unified.ts`                           |
| Repo Task runs         | `services/task-service.ts`, `workers/task-worker.ts`                         | `routes/tasks.ts`                                   |
| Repo Task blueprints   | `services/task-config-service.ts`                                            | `routes/task-configs.ts`                            |
| Standalone Tasks       | `services/workflow-service.ts`, `workers/workflow-worker.ts`                 | `routes/workflows.ts` (also mounted as `/api/jobs`) |
| Triggers               | `services/workflow-trigger-service.ts`, `workers/workflow-trigger-worker.ts` | included in the above                               |
| Templates              | `services/prompt-template-service.ts`                                        | `routes/prompt-templates.ts`                        |

State changes for both Repo Task runs and Standalone runs flow through the [reconciliation control plane](./reconciliation.md) when enabled.
