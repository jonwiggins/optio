# Work: one noun for every kind of agent work

Optio presents every unit of agent work as **work** with five attributes — a one-time terminal on a pod or a machine, a one-off agent run, an agent handling a PR, a recurring definition with prior runs and a history, a persistent agent. This guide explains the model, how each combination of attributes is stored and executed, and how the polymorphic `/api/tasks` HTTP layer presents the pod-side kinds. For the long-lived kind see [persistent-agents.md](persistent-agents.md); for anything that runs on a user's own machine see [optio-local.md](optio-local.md).

## The five attributes

| Attribute | Question                | Values                                                                                                                                                                                             |
| --------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **When**  | What starts it?         | `manual` (now) · `schedule` (cron) · `webhook` · `ticket` (GitHub / GitLab / Linear / Jira / Notion) · `github` / `slack` / `linear` / `pylon` / `pagerduty` events · messages (persistent agents) |
| **Where** | Where does it run?      | `cluster` — an Optio pod, with one of your registered repos or with no repo · `local` — a directory on a paired machine, as it is or on a new branch that becomes a PR                             |
| **Who**   | What does the work?     | A bare terminal, or an agent runtime (`claude-code`, `codex`, `copilot`, `gemini`, `cursor`, `opencode`, `openclaw`) plus its model / provider options                                             |
| **What**  | What is it asked to do? | The prompt (or a saved prompt template), with the trigger's `{{params}}` available                                                                                                                 |
| **Then**  | What happens after?     | `exits` — stop when done · `waits-for-me` — halt at the agent's prompt between turns · `waits-for-messages` — a persistent agent that keeps memory and wakes on messages                           |

Plus a **name** (or "Job N" / "Terminal N" for its kind).

**Every When works with every Where.** A schedule, a webhook, a ticket, or a GitHub / Slack / Linear event can start work in a pod or on a machine; the trigger is stored the same way whatever it attaches to (see [Triggers](#triggers)).

**Every Who works with every When and Where it fits.** A Terminal is a shell you open (a pod session; a terminal on your machine, by hand or on a trigger) or a command that runs and exits — a Job with no agent, in a pod or on a machine, on any trigger. A persistent agent can have a repo and works in one checkout of it across turns. What stays apart is only what makes no sense: "works until merged" needs an agent and a repo, a pod session needs a repo and a person, a persistent agent lives in a pod.

The New work form (`/work/new`, `apps/web/src/components/work-form/`) asks these in order, each answer narrowing the next. `normalize()` keeps a draft consistent when an upstream answer changes; `describe()` renders the draft as a sentence whose gaps double as validation:

> Started by GitHub events, a Claude Code run in an Optio pod with acme/app that opens a PR and exits when done.

Presets seed common shapes — **Open a PR**, **Interactive chat**, **Scheduled run**, **Persistent agent** — but any point in the space is reachable.

## From attributes to a storage kind

Which row a piece of work becomes is a pure function of the attributes (`deriveKind` in `model.ts`):

```
then = waits-for-messages                          → persistent-agent
then = waits-for-me,  where = cluster              → pod-session
then = waits-for-me,  where = local,  triggered    → local-blueprint
then = waits-for-me,  where = local,  now          → local-terminal
then = exits, with repo, triggered                 → repo-blueprint
then = exits, with repo, now                       → repo-task
then = exits, no repo                              → standalone
```

"Triggered" means any When but `manual` — an event trigger is a When like the others, so "summarize every opened PR" is a `standalone` Job in a pod with a `github` trigger, and "review requests assigned to me, on my laptop, on a new branch" is a `repo-blueprint` that runs in the machine's checkout.

| Kind               | Backing table                                 | What it is                                                                                    | Spawns runs?            | Legacy name           |
| ------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------- | --------------------- |
| `repo-task`        | `tasks`                                       | One run in a repo worktree that ends by opening a PR (or in a local checkout on a new branch) | No — it _is_ a run      | Task / Repo Task      |
| `repo-blueprint`   | `work_definitions` + `workflow_triggers`      | A saved PR-session definition; each trigger firing spawns a `tasks` row                       | Yes (`tasks`)           | Scheduled Task        |
| `standalone`       | `work_definitions` (+ trigger)                | An agent or a shell command with no repo on a pooled pod (or a machine); now or on a trigger  | Yes (`tasks`)           | Job / Standalone Task |
| `local-blueprint`  | `work_definitions` + `workflow_triggers`      | "When X happens, open this agent on my machine and wait for me" — an interactive automation   | Yes (`local_terminals`) | Local Automation      |
| `local-terminal`   | `local_terminals`                             | An interactive terminal or agent on a paired machine                                          | No                      | Local session         |
| `pod-session`      | `interactive_sessions`                        | An interactive terminal + agent chat inside a repo pod                                        | No                      | Session (v0.4)        |
| `persistent-agent` | `persistent_agents` + turns / messages / pods | Long-lived, named, message-driven agent                                                       | Turns                   | Agent                 |

`submit.ts` turns the draft into a `WorkSpec` and `POST`s it to `/api/work`, which derives the same kind (`kindOfSpec`) and writes the row and its trigger in one transaction (`services/work-write-service.ts`); a saved definition goes back through `PATCH /api/work/:id`. Each kind still runs the way it always has — only where you make it and where you see it changed.

## Where → Environment

Pod work's **Where** also says what its pod has besides the code. The repo's and the workspace's settings are the defaults; a piece of work can switch connections, MCP servers, and skills on or off by id, pick its pod secrets, and add setup commands that run before the agent (`WorkSettings`, `packages/shared/src/work/settings.ts`, stored only as the changes in a `settings` column on `tasks`, `work_definitions`, and `persistent_agents`). `buildAgentEnvironment` (`services/agent-environment-service.ts`) turns defaults plus changes into `.mcp.json`, skill files, and env for every pod worker — Repo Task, PR review, Job, persistent agent; a command Job gets only its setup commands. A Codex run gets the same servers a second time as `[mcp_servers.*]` TOML in a `config.toml` of its own, and its launch line points `CODEX_HOME` at it (`utils/codex-config.ts`), because Codex reads `$CODEX_HOME/config.toml` and never `.mcp.json`; one home per run keeps concurrent worktrees' connections apart and Codex's session logs out of the checkout. Work that opens a PR can also make its follow-through **more careful** than its repo's — ask for a review, open draft PRs, resume fewer times — but never less: the repo's settings are an admin's (`effectivePrSettings`). Work on a machine runs with the machine's own CLI configuration and takes none of it.

`repo-task`, `repo-blueprint`, and `standalone` all carry a **run location** (`run_target` = `cluster` | `local`, with `local_host_id` / `local_dir` / `local_session_mode`). A local run is the same row, executed by a `local_terminals` row through the daemon instead of a pod; the terminal's frames drive the run's state (PR link → `pr_opened`, exit → `completed` / `failed`). See [optio-local.md](optio-local.md#local-runs-tasks-and-jobs-on-your-machine).

## The Work feed

`/work` shows every kind in one list, built server-side by `GET /api/work` (`apps/api/src/services/work-service.ts`; the row vocabulary — `WorkRow`, `inView`, `countWork` — lives in `@optio/shared`). Each row is projected onto the same shape — When, Where, Who, Then, and a **status** on one scale:

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

Views: **Active** (`needs_you` / `running` / `queued` / `waiting`), **Recurring** (definitions that spawn runs), **Agents** (persistent agents), **History** (`done` / `failed`). Rows sort needs-you first, then live, then by recency. The Overview's board and the iOS app's Work tab consume the same projection.

The server scopes each kind the way its own endpoint does — workspace rows by workspace, a person's machines and pod sessions by person — and `GET /api/work/:id` resolves an id of any kind. The iOS and Android apps still merge the per-kind endpoints client-side: they also talk to self-hosted servers older than `/api/work`, and every endpoint they read keeps its shape.

## Surfaces

Sidebar (v0.6): **Overview** · **Work** · **Reviews** · **Inbox** · **Library** — Prompts, Repos, Machines, Connections · **Insights** — Analytics, Costs, Activity, Cluster. (iOS: the Work tab, with All / Reviews / Inbox under it.)

- **`/work`**, **`/work/new`** — the unified feed and the one creation form. `/tasks/new`, `/jobs/new`, `/agents/new`, and the v0.5 `/sessions/new` redirect here.
- **`/reviews`**, **`/reviews/:id`** — code-review subtasks plus external PR reviews, with CI / review / merge tracking.
- **`/issues`** (Inbox) — GitHub / GitLab Issues across connected repos. "Assign to Optio" creates a `repo-task`.
- **`/machines`** — where work runs: each paired Optio Local host with the work on it (live now, and set up to run there — grouped by the feed's `where.hostId`, `lib/work-places.ts`) and its directory allowlist, then the Optio pods' work grouped by repo, Jobs, and persistent agents.
- Detail pages per kind still exist and link back to `/work`: `/tasks/:id`, `/tasks/scheduled/:id`, `/jobs/:id`, `/jobs/:id/runs/:runId`, `/agents/:id`, `/local/:id`, `/sessions/:id` (pod sessions — the one place the word keeps its narrow meaning).
- The per-kind list pages are retired: `/tasks`, `/jobs`, `/tasks/scheduled`, `/agents`, `/local`, and the v0.5 `/sessions` redirect to the matching `/work?view=…`. Recurring work (scheduled Tasks, Jobs, Local Automations) each have a page about them (`/tasks/scheduled/:id`, `/jobs/:id`, `/local/automations/:id`: stats, triggers, prior runs) and are edited at `/work/:id/edit` — the New work form reopened on the saved row, with the kind locked.
- Legacy `/tasks?tab=standalone|issues|prs` URLs redirect to `/work?view=recurring`, `/issues`, `/reviews`.

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

### How Optio finds a task's PRs

A PR URL in an agent's output is not evidence: agents print PRs they looked at (`gh pr view 812`), PRs they were told about, and example URLs. A task adopts only:

1. **PRs its agent's tool calls created.** A shell call that runs `gh pr create`, `glab mr create`, `git push -o merge_request.create`, `hub pull-request`, `gh api … /pulls` with POST (or the GraphQL `createPullRequest` mutation), or `aws codecommit create-pull-request` — anywhere in a compound command, `$(…)` included — or an MCP `create_pull_request` / `create_merge_request` tool (any server prefix). The PR comes from that call's own result, paired by tool-use / call id. A failed call adopts nothing, except `gh pr create` reporting that a PR for the branch already exists. Pods read Claude Code's stream-json and Codex's `exec --json` events; local runs read the terminal's transcript. The detector is pure and lives in `packages/shared/src/utils/pr-tool-calls.ts`.
2. **PRs on the task's branches.** A PR whose head branch is `optio/task-<id>`, `optio/task-<id>-<slug>` or `optio/task-<id>/<slug>` belongs to the task. The prompt asks an agent that needs more than one PR to name extra branches `optio/task-<id>-<slug>` (git can't hold both `optio/task-<id>` and `optio/task-<id>/x`). After a pod run Optio lists the task's pushed branches in the worktree and asks the platform for their PRs; every run (pod or local) also asks for open PRs by head-branch prefix (`GitPlatform.findPullRequestsByHeadPrefix`; GitHub and GitLab list and filter, CodeCommit filters its open PRs).

Each tool-call PR is confirmed on the git platform before it is adopted: same repo as the task (the base repo; a fork's head may differ), open or merged, and either on the task's branches or created during this run (2 minutes of clock skew allowed). When the platform can't be asked (no token, an API error other than 404), a PR in the task's repo is adopted on the tool call's word and a warning is logged.

Every PR is a `task_prs` row (`source`: `tool_call`, `branch` or `attached`). `tasks.pr_url` stays the **primary** PR — the first one adopted — and is what the PR watcher, reviews, auto-resume and auto-merge follow; other PRs are tracked alongside. `GET /api/tasks/:id` returns them as `task.prs`; `POST /api/tasks/:id/prs` attaches one by hand (member role; personal work only by its owner) and `DELETE /api/tasks/:id/prs/:prId` stops tracking one — the primary only while another can take its place. The task page lists them once a task has more than one.

## Jobs: work without a repo (`standalone`)

An agent — or a shell command — runs in a pooled job pod with no checkout and produces logs and side effects: querying Slack, writing to a database, posting a report, calling an MCP server, triaging a ticket queue. A command's exit status settles the run (`services/command-run.ts`). Pods are shared across runs of the same definition, keyed on `(workflow_id, instance_index)`, with `maxPodInstances` replicas × `maxAgentsPerPod` concurrent runs. Runs auto-retry with exponential backoff.

## Triggers

Triggers live in one polymorphic table, `workflow_triggers`, keyed by `(target_type, target_id)`, with one CRUD (`services/trigger-service.ts`, shared Zod bodies in `schemas/trigger.ts`) behind every route that manages them and one dispatcher (`services/trigger-dispatch.ts`, `fireTrigger`) behind every way they fire:

| `target_type`      | `fireTrigger` calls                    | Produces                                       |
| ------------------ | -------------------------------------- | ---------------------------------------------- |
| `job`              | `workflowService.createWorkflowRun()`  | a Job run (`tasks` row, `kind = 'standalone'`) |
| `task_config`      | `taskConfigService.instantiateTask()`  | a `tasks` row, queued and enqueued             |
| `local_blueprint`  | `local-blueprint-service` → the daemon | a `local_terminals` row on the host            |
| `persistent_agent` | `wakeAgent()`                          | an inbox message; the reconciler starts a turn |
| `pr_review`        | `reReview()`                           | a re-review run (schedule only)                |

Trigger types — the same nine for every target (`TRIGGER_TYPES` / `TRIGGER_TYPES_FOR_TARGET` in `@optio/shared`): `manual`, `schedule` (cron; the `workflow-trigger-worker` polls every 60 s, `OPTIO_WORKFLOW_TRIGGER_INTERVAL`), `webhook` (`/api/hooks/:path`), `ticket` (ticket sync), and the events `github`, `slack`, `linear`, `pagerduty` (signed ingress in `routes/event-ingress.ts` plus the existing `/api/webhooks/github` receiver; normalized and matched in `services/event-trigger-service.ts`, then fanned out with `fireEventTriggers`) and `pylon` (Pylon can't sign its deliveries, so each Pylon trigger has its own shared secret — minted on create and returned once — and its deliveries go to `/api/hooks/pylon/:triggerId` with `X-Optio-Secret`, matched by `firingFor` and fired for that one trigger). A definition may carry several triggers, including several of one type (a 9 am and a 5 pm schedule); only webhook paths are unique across the table. The `validateTriggerConfig` rules (`cronExpression`, `path`, `source`, `login` for personal GitHub kinds, `channelId` for Slack, `user` for personal Linear kinds, free-text `events` (≤ 20, ≤ 100 chars) for Pylon, `events` ⊆ the PagerDuty incident event types with `services` / `urgency` for PagerDuty) are the same everywhere. A trigger's stored `secret` (`webhook`, `pylon`) is never read back: every list / update response replaces it with `hasSecret: true` (`publicTrigger`), and an update that carries no non-empty `secret` keeps the stored one.

What a firing hands its target is uniform too (`TriggerFiring`): `params` for the prompt / command template, an optional `ticket` link, a `title`, and — for a persistent agent, which reads an inbox rather than params — a `message`. Two event-specific rules: a scheduled Task with a `github` trigger and no `repos` filter listens to its own repo only, and a task started by a PR / issue _event_ is not linked to it as a ticket (a ticket link auto-closes the issue when the task completes; the event's fields still reach the prompt as params). Events about a repo registered in Optio only reach definitions in that repo's workspace.

Ticket triggers fire from the ticket-sync sweep (`ticket-sync-service.ts`) rather than the poller: every new actionable ticket goes through `fireTicketTriggers`, which offers it to every enabled `ticket` trigger whatever its target, filtered by `config.source` and any-match `config.labels`, with the same six params (`ticketSource`, `ticketExternalId`, `ticketTitle`, `ticketBody`, `ticketUrl`, `ticketLabels`).

## Templates and parameters

Every kind uses the same template engine: `{{param}}` substitution and `{{#if param}}...{{/if}}` blocks, rendered lazily at firing time so the trigger payload (ticket fields, webhook body, event details) substitutes into the prompt before the agent sees it. The form lists the params each **When** provides (`TRIGGER_PARAMS` in `model.ts`). Commands (a command Job, a Local automation) render through `renderCommandTemplate`: each param becomes a shell variable assigned on the first line and each `{{param}}` only references it, so a payload is never parsed as shell code wherever the template puts it.

Reusable templates live in `prompt_templates` with a `kind` discriminator (`prompt` / `review` / `job` / `task`), managed under **Library → Prompts**. Precedence: repo override → global default → hardcoded fallback.

## The unified `/api/tasks` HTTP layer

The three pod-side kinds are reachable through one polymorphic resource. The server resolves an ID across all three tables; UUIDs are globally unique so there is no collision.

| Endpoint                                                         | Purpose                                                                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/tasks?type=repo-task\|repo-blueprint\|standalone\|all` | Unified list, filterable by type                                                                                                         |
| `POST /api/tasks`                                                | Create. Body takes `{ type, ... }` (+ `runTarget` / `localHostId` / `localDir` / `localSessionMode`) and dispatches to the right service |
| `GET /api/tasks/:id`                                             | Resolve across tables; returns the native row tagged with `type`                                                                         |
| `GET/POST /api/tasks/:id/runs[/:runId]`                          | List/start runs (spawned Repo Tasks for blueprints, Job runs for standalone, 405 for ad-hoc)                                             |
| `GET/POST/PATCH/DELETE /api/tasks/:id/triggers[/:triggerId]`     | Manage triggers (405 for ad-hoc repo-task)                                                                                               |

The resolver lives in `apps/api/src/services/unified-task-service.ts` (`resolveAnyTaskById`) and checks `tasks` → `work_definitions` (scheduled Tasks, Jobs) → PR reviews in order. `/api/work` (`routes/work.ts`) is the newer resource over every kind: list, any id, create from a `WorkSpec`, save, delete, runs, triggers. The polymorphic routes are in `apps/api/src/routes/tasks-unified.ts`. Legacy `/api/jobs/*` and `/api/task-configs/*` endpoints still work as thin aliases.

The other kinds have their own resources: `/api/local/*` (hosts, terminals, blueprints), `/api/sessions/*` (pod sessions), `/api/persistent-agents/*` and the inter-agent `/api/internal/persistent-agents/*`.

> **Backend-naming note.** The tables kept some historical names. Every saved definition — scheduled Task, Job, Local automation — is a `work_definitions` row (`kind` = `repo-blueprint` | `standalone` | `local-blueprint`), and every run — a Repo Task or a Job run — is a `tasks` row (`kind` = `repo` | `standalone`), read through the `repo_tasks` / `workflow_runs` views by code about one kind; `workflow_triggers` is the one trigger table, `agent_pods` the one pod table, `task_logs` the one log table. The legacy per-kind endpoints project rows back to their old shapes, and `/api/work` serves every kind as one resource (`docs/plans/work-unification.md`).

## Service map

| Concern                | Service                                                                                                                | Routes                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Polymorphic resolution | `services/unified-task-service.ts`                                                                                     | `routes/tasks-unified.ts`                                                     |
| PR sessions (runs)     | `services/task-service.ts`, `workers/task-worker.ts`                                                                   | `routes/tasks.ts`                                                             |
| PR session blueprints  | `services/task-config-service.ts`                                                                                      | `routes/task-configs.ts`                                                      |
| No-repo pod sessions   | `services/workflow-service.ts`, `workers/workflow-worker.ts`                                                           | `routes/workflows.ts` (also mounted as `/api/jobs`)                           |
| Local runs / terminals | `services/local-run-service.ts`, `local-terminal-service.ts`, `local-blueprint-service.ts`                             | `routes/local.ts`                                                             |
| Persistent agents      | `services/persistent-agent-service.ts`, `workers/persistent-agent-worker.ts`                                           | `routes/persistent-agents.ts`, `routes/persistent-agent-internal.ts`          |
| Triggers               | `services/trigger-service.ts`, `trigger-dispatch.ts`, `event-trigger-service.ts`, `workers/workflow-trigger-worker.ts` | trigger sub-routes of the above, `routes/hooks.ts`, `routes/event-ingress.ts` |
| Templates              | `services/prompt-template-service.ts`                                                                                  | `routes/prompt-templates.ts`                                                  |
| Work list / resolver   | `services/work-service.ts` (rows), `@optio/shared` `work/feed.ts` (vocabulary), web `components/work-form/`            | `routes/work.ts` (`/api/work`); web `/work`, `/work/new`, `/work/:id/edit`    |

State changes for every kind flow through the [reconciliation control plane](./reconciliation.md); local runs skip its capacity / stall / pod checks because the terminal is the source of truth.
