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
work_definitions ──fires (triggers)──▶ work_runs  (tasks = the kind='repo' view) ─┐
  kind: repo-blueprint │ standalone        kind: repo │ standalone                 │  task_logs
        │ local-blueprint ───────────▶ local_terminals                              │  (every run's log)
                                                                                    │
persistent_agents ──turns──▶ persistent_agent_turns ────────────────────────────────┘
                                                              agent_pods (every pod)
```

- **One definitions table**, `work_definitions`, with a `kind` discriminator
  whose values are the kind names the API already uses
  (`repo-blueprint`, `standalone`, `local-blueprint`).
- **One runs table**, `work_runs`, with a `kind` discriminator (`repo` |
  `standalone`, the reconciler's pod-run `RunKind`s). `tasks` stays as an
  auto-updatable view over it (`WHERE kind = 'repo' WITH CHECK OPTION`), so
  every existing repo-task query — capacity, the PR watcher, worktree cleanup,
  stale / orphan / resync sweeps, bulk actions, stats, the CLI's endpoints —
  stays repo-only by construction instead of by audit, and inserts through it
  get `kind = 'repo'`. Code that is about every run (the Work list, costs,
  local runs, zombie detection, the reconciler's table mapping) reads
  `work_runs`. Child tables (`task_events`, `task_logs`, …) keep their
  `task_id` columns, which now point at `work_runs`.
- **Triggers** stay where they are (`workflow_triggers`, already polymorphic
  on `(target_type, target_id)`); definition targets point into
  `work_definitions`. Renaming the table or the target types would be churn
  with no behavior change.
- **One pod table**, `agent_pods`, keyed by `(pool, pool_key, instance_index)`
  where `pool` is the run kind the pod serves (`repo`, `standalone`,
  `persistent-agent`) and `pool_key` is what pods are shared across (the
  normalized repo URL, the definition id, the agent id).
- **One log table**, `task_logs`, for task runs, Job runs, PR-review runs, and
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

- `packages/shared/src/work/feed.ts`: `WorkRow`, `WorkSource`, `WorkStatus`,
  `WorkView`, `inView`, `sortWork`, `countWork` — the projection's
  vocabulary, shared by the server and the web. It lives outside `types/` so
  the Swift / Kotlin generators don't emit a twin of the apps' hand-written
  models.
- `apps/api/src/services/work-service.ts`: `listWork(scope)` projects every
  kind onto `WorkRow` server-side, scoped like each kind's own endpoint;
  `resolveWork(id, scope)` resolves an id of any kind.
- `GET /api/work?view=…` and `GET /api/work/:id`.
- The web's `useWorkFeed` reads `/api/work`; `collectWork` leaves the web.
  The iOS and Android apps keep their client-side merge for now: they ship
  separately from the server and talk to self-hosted servers that may predate
  `/api/work`, so they can only drop the merge once the oldest server they
  support has it. Every endpoint the merge reads keeps its shape.
- `/costs` counts every row that carries spend: persistent-agent turns,
  PR-review runs, and pod sessions join the union, and each row links to its
  own page.

## Phase 1 — shared execution primitives

- **Logs**: `persistent_agent_turn_logs` folds into `task_logs` (a new
  `persistent_agent_turn_id` column, cascading like the old table; the agent
  is reached through the turn). `services/run-log-service.ts` writes and
  reads every owner's lines. Job-run logs fold in Phase 3, straight onto `task_id`, so no
  log row is moved twice. The auth-failure detector keeps scanning only
  repo-task and PR-review logs (agent and Job output legitimately contains
  third-party "bad credentials" strings).
- **Cost**: SQL-side accumulation helpers (`trim_scale(numeric + $x)`), so
  adding an attempt's spend is atomic instead of read-add-write. Used by the
  task worker (same totals as today), the Job worker (a retried Job run now
  sums its attempts instead of keeping only the last — a visible change to
  `/costs` and the run webhooks' `costUsd`), the PR-review worker, and a
  persistent agent's running total (which also stops bumping `updated_at`,
  the reconciler's CAS version). Local runs keep writing the daemon's
  absolute per-terminal usage.
- **Transitions**: the Job-run transition implementations (worker, service
  ×2, zombie cleanup, executor) collapse into one CAS transition with one
  fan-out (WS event, outbound webhook, reconcile wake). The worker's
  transitions become compare-and-swap, so a run cancelled mid-flight is no
  longer overwritten by the worker's own completion.
- **Pods**: `repo_pods`, `workflow_pods`, `persistent_agent_pods` →
  `agent_pods`. Per-pool semantics are kept exactly: repo pods stay keyed by
  the normalized repo URL with no workspace (StatefulSet and PVC names derive
  from it), the `(key, index)` uniqueness stays Job-pool-only, and an agent
  pod's `keep_warm_until = NULL` still means always-on.
  `services/agent-pod-pool.ts` holds the shared verbs — pick a pod (retry
  affinity → least-loaded → reap dead / stale → scale up at the lowest free
  index → wait), record / ready / error, release, count reconciliation; the
  repo, Job, and agent pool services keep only what is theirs (the repo pod's
  StatefulSet / PVCs / sidecars / clone, the agent pod's lifecycle modes). Pod
  names, labels, and specs are unchanged.

## Phase 2 — one definitions table

- Migration: create `work_definitions`, copy `task_configs`, `workflows`,
  `local_blueprints` into it (ids preserved), repoint the FKs that named the
  old tables (Job runs and the triggers' legacy `workflow_id` cascade from a
  Job definition, as before), add `tasks.work_id` (backfilled from
  `metadata.taskConfigId` where the config still exists; `ON DELETE SET NULL`,
  so deleting a scheduled Task keeps the tasks it spawned, as before), and
  drop the three old tables.
- Name uniqueness stays per kind, via partial unique indexes: scheduled Tasks
  and Jobs per workspace, Local automations per person. Defaults that differ
  by kind (`local_session_mode`, `max_retries`) are applied by the service.
- `services/work-definition-service.ts`: one CRUD, one `fireDefinition` that
  starts whatever the kind starts. `task-config-service`, `workflow-service`,
  and `local-blueprint-service` become thin projections for the legacy
  routes, which keep their response shapes field for field.
- `POST /api/work` creates from the five attributes: the server derives the
  kind (`deriveKind`, now in `@optio/shared`), creates the row and its trigger
  in one transaction, and starts the first run for "now" work. `PATCH`,
  `DELETE`, and the `runs` / `triggers` sub-resources complete the resource.
  The web form calls it, so the client-side create-then-attach-then-rollback
  dance goes away.

## Phase 3 — one runs table

- Migration: rename `tasks` → `work_runs`; add `kind` (default `repo`);
  `repo_url`, `prompt`, `agent_type` become nullable with a `CHECK` that keeps
  them required for `kind = 'repo'`; recreate `tasks` as the repo-only view;
  move `workflow_runs` rows in (ids preserved; `workspace_id` / `created_by`
  backfilled from the definition; unknown states mapped to `failed`), their
  logs onto `task_id`, and their local terminals' back-pointers; drop
  `workflow_runs`.
- Job-run columns map onto existing ones where the meaning matches
  (`finished_at` → `completed_at`, …); only what has no equivalent is added.
- A Job run keeps reading its definition live at execution time (prompt,
  enabled, location, limits, retries), exactly as today — nothing is
  snapshotted that wasn't before. The run records the prompt it actually ran.
- `local-run-service` has one dispatch and one terminal → run sync; PR
  detection stays repo-only (a Job that prints a PR URL is not "PR opened").
- Legacy `/api/jobs/:id/runs*` and `/api/workflow-runs/*` project rows back
  to the `WorkflowRun` shape; WebSocket events and outbound webhooks keep
  their names.
- A test pins the view to the table (same columns), and CLAUDE.md says how to
  add a column (to `work_runs`, then recreate the view).

## Safety nets

- Migration tests on populated databases: migrate to the previous release,
  seed rows of every old shape, apply the new migrations, assert every row
  landed (ids, scoping, FKs, cascades).
- A test that fails when source code names a dropped table in raw SQL.
- `openapi.test.ts`, `openapi:lint`, `gen:swift` / `gen:kotlin` stay green.

## Upgrade notes

- Migrations copy data and drop the old tables inside one transaction, so a
  failed upgrade rolls back cleanly. Copying large log tables can take longer
  than the liveness probe allows, so the API deployment gets a `startupProbe`
  that gives boot-time migrations up to ten minutes.
- During a rolling update the old replica keeps serving while the new one
  migrates, and fails on the tables that are gone. For this upgrade, use the
  chart's `api.strategy: { type: Recreate }` (or scale the API to zero first).
