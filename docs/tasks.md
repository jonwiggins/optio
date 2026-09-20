# Sessions: one noun for every kind of agent work

Optio presents every unit of agent work as a **session** with five attributes. This guide explains the model, how each combination of attributes is stored and executed, and how the polymorphic `/api/tasks` HTTP layer presents the pod-side kinds. For the long-lived kind see [persistent-agents.md](persistent-agents.md); for anything that runs on a user's own machine see [optio-local.md](optio-local.md).

## The five attributes

| Attribute | Question                | Values                                                                                                                                                                                    |
| --------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **When**  | What starts it?         | `manual` (now) · `schedule` (cron) · `webhook` · `ticket` (GitHub / GitLab / Linear / Jira / Notion) · `github` / `slack` / `linear` events (machine only) · messages (persistent agents) |
| **Where** | Where does it run?      | `cluster` — an Optio pod, with one of your registered repos or with no repo · `local` — a directory on a paired machine, as it is or on a new branch that becomes a PR                    |
| **Who**   | What does the work?     | A bare terminal, or an agent runtime (`claude-code`, `codex`, `copilot`, `gemini`, `cursor`, `opencode`, `openclaw`) plus its model / provider options                                    |
| **What**  | What is it asked to do? | The prompt (or a saved prompt template), with the trigger's `{{params}}` available                                                                                                        |
| **Then**  | What happens after?     | `exits` — stop when done · `waits-for-me` — halt at the agent's prompt between turns · `waits-for-messages` — a persistent agent that keeps memory and wakes on messages                  |

Plus a **name** (or "Session N").

The New Session form (`/sessions/new`, `apps/web/src/components/session-form/`) asks these in order, each answer narrowing the next: an event trigger forces the machine location, a bare terminal skips the prompt, a persistent agent lives in a pod. `normalize()` keeps a draft consistent when an upstream answer changes; `describe()` renders the draft as a sentence whose gaps double as validation:

> Started by GitHub events, a Claude Code session on my laptop on a new branch in ~/src/app that opens a PR and exits when done.

Presets seed common shapes — **Open a PR**, **Interactive chat**, **Scheduled run**, **Persistent agent** — but any point in the space is reachable.

## From attributes to a storage kind

Which row a session becomes is a pure function of the attributes (`deriveKind` in `model.ts`):

```
then = waits-for-messages                          → persistent-agent
then = waits-for-me,  where = cluster              → pod-session
then = waits-for-me,  where = local,  triggered    → local-blueprint
then = waits-for-me,  where = local,  now          → local-terminal
when = github | slack | linear event               → local-blueprint
then = exits, with repo, triggered                 → repo-blueprint
then = exits, with repo, now                       → repo-task
then = exits, no repo                              → standalone
```

| Kind               | Backing table                                 | What it is                                                                                    | Spawns runs?            | Legacy name           |
| ------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------- | --------------------- |
| `repo-task`        | `tasks`                                       | One run in a repo worktree that ends by opening a PR (or in a local checkout on a new branch) | No — it _is_ a run      | Task / Repo Task      |
| `repo-blueprint`   | `task_configs` + `workflow_triggers`          | A saved PR-session definition; each trigger firing spawns a `tasks` row                       | Yes (`tasks`)           | Scheduled Task        |
| `standalone`       | `workflows` + `workflow_runs` (+ trigger)     | Agent work with no repo on a pooled pod (or a machine); run now or on a trigger               | Yes (`workflow_runs`)   | Job / Standalone Task |
| `local-blueprint`  | `local_blueprints` + `workflow_triggers`      | "When X happens, run this agent on my machine" — incl. GitHub / Slack / Linear events         | Yes (`local_terminals`) | Local Automation      |
| `local-terminal`   | `local_terminals`                             | An interactive terminal or agent on a paired machine                                          | No                      | Local session         |
| `pod-session`      | `interactive_sessions`                        | An interactive terminal + agent chat inside a repo pod                                        | No                      | Session (v0.4)        |
| `persistent-agent` | `persistent_agents` + turns / messages / pods | Long-lived, named, message-driven agent                                                       | Turns                   | Agent                 |

Each branch of `submit.ts` calls the same service the dedicated form for that kind used to call, so nothing about how a kind runs changed in v0.5 — only where you make it and where you see it.

`repo-task`, `repo-blueprint`, and `standalone` all carry a **run location** (`run_target` = `cluster` | `local`, with `local_host_id` / `local_dir` / `local_session_mode`). A local run is the same row, executed by a `local_terminals` row through the daemon instead of a pod; the terminal's frames drive the run's state (PR link → `pr_opened`, exit → `completed` / `failed`). See [optio-local.md](optio-local.md#local-runs-tasks-and-jobs-on-your-machine).

## The Sessions feed

`/sessions` merges every kind into one list (`apps/web/src/lib/sessions-feed.ts`). Each row is projected onto the same shape — When, Where, Who, Then, and a **status** on one scale:

| Status      | Meaning                                                             |
| ----------- | ------------------------------------------------------------------- |
| `needs_you` | An interactive session is waiting for input                         |
| `running`   | An agent is working (or a pod is provisioning)                      |
| `queued`    | Waiting for capacity                                                |
| `waiting`   | Open but idle: a PR waiting on CI / review, an agent between turns  |
| `scheduled` | A blueprint / recurring job with an enabled trigger and a next fire |
| `paused`    | A blueprint or agent with triggers disabled / agent paused          |
| `done`      | Completed, merged, or exited cleanly                                |
| `failed`    | Failed, cancelled, closed without merge, or the pod / terminal died |

Views: **Active** (`needs_you` / `running` / `queued` / `waiting`), **Recurring** (definitions that spawn runs), **Agents** (persistent agents), **History** (`done` / `failed`). Rows sort needs-you first, then live, then by recency. The Overview's board and the iOS app's Sessions tab consume the same projection.

Today the feed is a client-side merge of the per-kind endpoints (unified tasks, local terminals + automations, pod sessions, persistent agents). A server-side `/api/sessions` read model can replace `collectSessions` without touching the pages.

## Surfaces

Sidebar (v0.5): **Overview** · **Work** — Sessions, Reviews, Inbox · **Library** — Prompts, Repos, Machines, Connections · **Insights** — Analytics, Costs, Activity, Cluster.

- **`/sessions`**, **`/sessions/new`** — the unified feed and the one creation form. `/tasks/new`, `/jobs/new`, and `/agents/new` redirect here.
- **`/reviews`**, **`/reviews/:id`** — code-review subtasks plus external PR reviews, with CI / review / merge tracking.
- **`/issues`** (Inbox) — GitHub / GitLab Issues across connected repos. "Assign to Optio" creates a `repo-task`.
- **`/machines`** — paired Optio Local hosts and their directory allowlists.
- Detail pages per kind still exist and link back to `/sessions`: `/tasks/:id`, `/tasks/scheduled/:id`, `/jobs/:id`, `/jobs/:id/runs/:runId`, `/agents/:id`, `/local/:id`, `/sessions/:id` (pod sessions).
- The per-kind list pages are retired: `/tasks`, `/jobs`, `/tasks/scheduled`, `/agents`, and `/local` redirect to the matching `/sessions?view=…`. Local Automations are edited on `/machines#automations`.
- Legacy `/tasks?tab=standalone|issues|prs` URLs redirect to `/sessions?view=recurring`, `/issues`, `/reviews`.

## The PR pipeline (`repo-task`)

1. Find or spin up an isolated Kubernetes pod for the repo (pod-per-repo), or — for a local run — pick the checkout on the machine.
2. Create a git worktree (or a branch) for the session; many run concurrently per pod.
3. Run the configured runtime with the rendered prompt and injected connections.
4. Stream structured logs back to the UI in real time.
5. The agent stops after opening a PR — it does not block on CI.
6. The PR watcher tracks CI checks, review status, and merge state (GitHub, GitLab incl. self-hosted, AWS CodeCommit).
7. If enabled, launch the code-review agent on CI pass or PR open.
8. If enabled, resume the agent on CI failure, merge conflict, or review changes requested (capped by `OPTIO_MAX_AUTO_RESUMES`).
9. Auto-complete on merge; auto-fail on close.

State machine (`packages/shared/src/utils/state-machine.ts`): `pending → queued → provisioning → running → pr_opened → completed`, with `needs_attention`, `failed`, `cancelled`, and retry edges. Always transition via `taskService.transitionTask()`.

## Pod sessions without a repo (`standalone`)

An agent runs in a pooled job pod with no checkout and produces logs and side effects: querying Slack, writing to a database, posting a report, calling an MCP server, triaging a ticket queue. Pods are shared across runs of the same definition, keyed on `(workflow_id, instance_index)`, with `maxPodInstances` replicas × `maxAgentsPerPod` concurrent runs. Runs auto-retry with exponential backoff.

## Triggers

Triggers live in one polymorphic table, `workflow_triggers`, keyed by `(target_type, target_id)`:

| `target_type`     | Dispatches to                          | Produces                            |
| ----------------- | -------------------------------------- | ----------------------------------- |
| `job`             | `workflowService.createWorkflowRun()`  | a `workflow_runs` row               |
| `task_config`     | `taskConfigService.instantiateTask()`  | a `tasks` row, queued and enqueued  |
| `local_blueprint` | `local-blueprint-service` → the daemon | a `local_terminals` row on the host |

Trigger types: `manual`, `schedule` (cron; the `workflow-trigger-worker` polls every 60 s, `OPTIO_WORKFLOW_TRIGGER_INTERVAL`), `webhook` (`/api/hooks/:path`), `ticket` (ticket sync), and — for local blueprints only — `github`, `slack`, `linear` events (signed ingress in `routes/local-ingress.ts`, matched in `local-event-service.ts`). Persistent agents reuse the same table for cron / webhook / ticket wake sources.

Ticket triggers fire from the ticket-sync sweep (`ticket-sync-service.ts`) rather than the poller: every new actionable ticket is offered to the enabled `ticket` triggers of each target type — `task_config` (`fireTicketTriggers`), `job` (`workflowService.fireJobTicketTriggers`), and `local_blueprint` (`fireLocalTicketTriggers`) — filtered by `config.source` and any-match `config.labels`, with the same six params (`ticketSource`, `ticketExternalId`, `ticketTitle`, `ticketBody`, `ticketUrl`, `ticketLabels`).

## Templates and parameters

Every kind uses the same template engine: `{{param}}` substitution and `{{#if param}}...{{/if}}` blocks, rendered lazily at firing time so the trigger payload (ticket fields, webhook body, event details) substitutes into the prompt before the agent sees it. The form lists the params each **When** provides (`TRIGGER_PARAMS` in `model.ts`). For local automations, params are shell-single-quoted before substitution so payloads can never inject commands.

Reusable templates live in `prompt_templates` with a `kind` discriminator (`prompt` / `review` / `job` / `task`), managed under **Library → Prompts**. Precedence: repo override → global default → hardcoded fallback.

## The unified `/api/tasks` HTTP layer

The three pod-side kinds are reachable through one polymorphic resource. The server resolves an ID across all three tables; UUIDs are globally unique so there is no collision.

| Endpoint                                                         | Purpose                                                                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/tasks?type=repo-task\|repo-blueprint\|standalone\|all` | Unified list, filterable by type                                                                                                         |
| `POST /api/tasks`                                                | Create. Body takes `{ type, ... }` (+ `runTarget` / `localHostId` / `localDir` / `localSessionMode`) and dispatches to the right service |
| `GET /api/tasks/:id`                                             | Resolve across tables; returns the native row tagged with `type`                                                                         |
| `GET/POST /api/tasks/:id/runs[/:runId]`                          | List/start runs (spawned `tasks` for blueprints, `workflow_runs` for standalone, 405 for ad-hoc)                                         |
| `GET/POST/PATCH/DELETE /api/tasks/:id/triggers[/:triggerId]`     | Manage triggers (405 for ad-hoc repo-task)                                                                                               |

The resolver lives in `apps/api/src/services/unified-task-service.ts` (`resolveAnyTaskById`) and checks `tasks` → `task_configs` → `workflows` in order. The polymorphic routes are in `apps/api/src/routes/tasks-unified.ts`. Legacy `/api/jobs/*` and `/api/task-configs/*` endpoints still work as thin aliases.

The other kinds have their own resources: `/api/local/*` (hosts, terminals, blueprints), `/api/sessions/*` (pod sessions), `/api/persistent-agents/*` and the inter-agent `/api/internal/persistent-agents/*`.

> **Backend-naming note.** The schema still says `tasks`, `task_configs`, `workflows`, `workflow_runs`, `workflow_triggers`, and `local_blueprints` for historical reasons, and older UI copy called these Tasks, Scheduled Tasks, Jobs, and Local Automations. v0.5 collapsed them into Sessions in the UI; the tables and services are unchanged.

## Service map

| Concern                | Service                                                                                    | Routes                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Polymorphic resolution | `services/unified-task-service.ts`                                                         | `routes/tasks-unified.ts`                                            |
| PR sessions (runs)     | `services/task-service.ts`, `workers/task-worker.ts`                                       | `routes/tasks.ts`                                                    |
| PR session blueprints  | `services/task-config-service.ts`                                                          | `routes/task-configs.ts`                                             |
| No-repo pod sessions   | `services/workflow-service.ts`, `workers/workflow-worker.ts`                               | `routes/workflows.ts` (also mounted as `/api/jobs`)                  |
| Local runs / terminals | `services/local-run-service.ts`, `local-terminal-service.ts`, `local-blueprint-service.ts` | `routes/local.ts`, `routes/local-ingress.ts`                         |
| Persistent agents      | `services/persistent-agent-service.ts`, `workers/persistent-agent-worker.ts`               | `routes/persistent-agents.ts`, `routes/persistent-agent-internal.ts` |
| Triggers               | `services/workflow-trigger-service.ts`, `workers/workflow-trigger-worker.ts`               | included in the above                                                |
| Templates              | `services/prompt-template-service.ts`                                                      | `routes/prompt-templates.ts`                                         |
| Sessions feed (web)    | `apps/web/src/lib/sessions-feed.ts`, `components/session-form/`                            | `/sessions`, `/sessions/new`                                         |

State changes for every kind flow through the [reconciliation control plane](./reconciliation.md); local runs skip its capacity / stall / pod checks because the terminal is the source of truth.
