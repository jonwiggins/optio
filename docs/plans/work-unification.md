# Backend Work unification

The UI presents every kind of agent work as one noun, **Work**, described by five
attributes (When / Where / Who / What / Then). Until this change the backend
stored that one noun in seven shapes across a dozen tables, and every client
(web, iOS, Android) rebuilt the Work list by fanning out to six endpoints and
merging the results by hand. This plan brings the tables, endpoints, and
service logic in line with the UI.

It is done in four phases; each leaves the system working and is its own set
of commits.

## Starting point

| Concern     | Before                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Definitions | `task_configs` (scheduled Tasks), `workflows` (Jobs), `local_blueprints` (Local automations)                                   |
| Runs        | `tasks` (Repo Task runs), `workflow_runs` (Job runs)                                                                           |
| Triggers    | `workflow_triggers`, polymorphic on `(target_type, target_id)` — already shared                                                |
| Pods        | `repo_pods`, `workflow_pods`, `persistent_agent_pods`, each with its own pool service using the same verbs                     |
| Logs        | `task_logs` (tasks + PR review runs), `workflow_run_logs`, `persistent_agent_turn_logs`                                        |
| HTTP        | `/api/tasks` (3 of 7 kinds), `/api/jobs`, `/api/task-configs`, `/api/local/*`, `/api/sessions`, `/api/persistent-agents`       |
| Work list   | rebuilt three times (web `lib/work-feed.ts`, iOS `WorkFeed.swift`, Android `core/workfeed`) from six endpoints                 |
| Costs       | `/costs` reads tasks, job runs, and unlinked local terminals; persistent-agent turns, PR-review runs, and pod sessions missing |

## Target model

```
work_definitions ──fires (triggers)──▶ tasks (runs)            ─┐
   kind: repo-blueprint │ standalone       kind: repo │ standalone │  task_logs
         │ local-blueprint ──────────▶ local_terminals           │  (every run's log)
                                                                 │
persistent_agents ─turns─▶ persistent_agent_turns ───────────────┘
                                                     agent_pods (every pod)
```

- **One definitions table**, `work_definitions`, with a `kind` discriminator
  whose values are the kind names the API already uses
  (`repo-blueprint`, `standalone`, `local-blueprint`).
- **One runs table**, `tasks`, with a `kind` discriminator (`repo`,
  `standalone`, the reconciler's `RunKind`s). Optio's own vocabulary already
  calls both a "task" (Repo Task / Standalone Task), and every child table
  (`task_events`, `task_logs`, `task_comments`, …) keys on `task_id`, so the
  Job runs move into `tasks` rather than both moving into a renamed table.
  Renaming `tasks` would touch ~100 files for no behavioral gain and leave
  the vocabulary half-renamed (`task_id`, `task_state`, `/api/tasks`,
  `task.*` webhooks).
- **One trigger table**, `triggers` (was `workflow_triggers`), whose
  definition rows all carry `target_type = 'work'`.
- **One pod table**, `agent_pods`, keyed by `(pool, pool_key, instance_index)`
  where `pool` is the `RunKind` the pod serves.
- **One log table**, `task_logs`, for task runs, PR-review runs, and
  persistent-agent turns.
- **One HTTP resource**, `/api/work`, for the list, any id, creation from the
  five attributes, editing, deletion, runs, and triggers. Every legacy
  endpoint keeps its exact response shape (the shipped mobile apps and the
  CLI call them) by projecting the unified rows.

Persistent agents keep their own tables: their lifecycle is cyclic and they
run turns, not runs. Interactive pod sessions and local terminals keep theirs
too: they are sessions, not runs of a definition. All three join the Work
list, the resolver, and cost accounting.

## Phase 0 — the Work read model

- `packages/shared/src/types/work.ts`: `WorkRow`, `WorkSource`, `WorkStatus`,
  `WorkView`, `inView`, `sortWork`, `countWork` — the projection's
  vocabulary, shared by the server and the web (and generated into the iOS /
  Android model files).
- `apps/api/src/services/work-service.ts`: `listWork(scope)` projects every
  kind onto `WorkRow` server-side (the logic of the web's `collectWork`, now
  with SQL-side scoping); `resolveWork(id, scope)` resolves an id across every
  table (tasks, definitions, persistent agents, local terminals, pod
  sessions, PR reviews).
- `GET /api/work?view=…` and `GET /api/work/:id`.
- The web's `useWorkFeed` reads `/api/work`; `collectWork` leaves the web.
  The iOS and Android apps keep their client-side merge for now: they ship
  separately from the server and talk to self-hosted servers that may predate
  `/api/work`, so they can only drop the merge once the oldest server they
  support has it. Every endpoint the merge reads keeps its shape.
- `/costs` counts every row that carries spend: persistent-agent turns,
  PR-review runs, and pod sessions join the union.

## Phase 1 — shared execution primitives

- **Logs**: `workflow_run_logs` and `persistent_agent_turn_logs` fold into
  `task_logs` (new `persistent_agent_id` / `persistent_agent_turn_id`
  columns; Job-run logs use the existing `workflow_run_id`).
  `services/run-log-service.ts` is the one append / read path.
- **Cost**: `services/run-cost-service.ts` — one atomic, SQL-side
  accumulation (`cost_usd + $x`) used by every worker, replacing the
  read-add-write in the task worker and the overwrite in the job and PR-review
  workers (a retried Job run no longer loses its earlier attempts' spend).
- **Transitions**: the four Job-run transition implementations (worker,
  service ×2, zombie cleanup, executor) collapse into one CAS transition with
  one fan-out (WS event, outbound webhook, reconcile wake).
- **Pods**: `repo_pods`, `workflow_pods`, `persistent_agent_pods` →
  `agent_pods`. `services/agent-pod-pool.ts` holds the shared verbs (select
  with retry affinity → least-loaded → scale up → wait, create-with-record,
  wait-for-ready, exec in a per-run directory, release, idle reap); the repo,
  Job, and persistent-agent pool services keep only what is theirs (the repo
  pod's PVCs / sidecars / clone, the agent pod's lifecycle modes). Pod names,
  labels, and specs are unchanged.

## Phase 2 — one definitions table

- Migration: create `work_definitions`, copy `task_configs`, `workflows`,
  `local_blueprints` into it (ids preserved), retarget their triggers to
  `target_type = 'work'`, rename `workflow_triggers` → `triggers` (dropping
  the legacy `workflow_id`), add `tasks.work_id` (backfilled from
  `metadata.taskConfigId`), and drop the three old tables.
- `services/work-definition-service.ts`: one CRUD, one validation, one
  `fireDefinition(definition, firing)` that starts whatever the kind starts.
  `task-config-service`, `workflow-service`, and `local-blueprint-service`
  become thin projections for the legacy routes.
- `POST /api/work` creates from the five attributes: the server derives the
  kind (`deriveKind`, now in `@optio/shared`), creates the row and its trigger
  in one transaction, and starts the first run for "now" work. `PATCH`,
  `DELETE`, and the `runs` / `triggers` sub-resources complete the resource.
  The web form calls it, so the client-side create-then-attach-then-rollback
  dance goes away.

## Phase 3 — one runs table

- Migration: `tasks` gains `kind`, `params`, `output`, `trigger_id`, `pod_id`,
  `finished_at`; `repo_url` becomes nullable (a `CHECK` keeps it required for
  `kind = 'repo'`). `workflow_runs` rows move into `tasks` (ids preserved;
  rendered prompt and agent snapshotted from the definition), their logs
  re-key to `task_id`, local terminals re-point, and `workflow_runs` is
  dropped.
- Every query over `tasks` is audited: repo-only paths (capacity, PR watcher,
  worktree cleanup, stats, the Tasks list) filter `kind = 'repo'`.
- A Job run is a snapshot of its definition at fire time, like a scheduled
  Task's spawned task already is.
- `local-run-service` has one dispatch and one terminal→run sync instead of
  one per kind; zombie detection, cost, and the reconciler's table mapping
  read one table.
- Legacy `/api/jobs/:id/runs*` and `/api/workflow-runs/*` project task rows
  back to the `WorkflowRun` shape; WebSocket events and outbound webhooks keep
  their names.

## Upgrade notes

Migrations copy data and drop the old tables inside a transaction, so an
upgrade is safe to roll forward, but an API replica still running the old
code during a rolling deploy will see "relation does not exist" errors until
it is replaced. Scale the API to one replica (or accept a minute of errors on
the old replica) while upgrading across this change.
