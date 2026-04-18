# Reconciliation Control Plane

Optio drives task and pod state through a Kubernetes-style reconciliation loop. A worker observes the world, runs a pure decision function, and applies a single typed action — gated by compare-and-swap so concurrent observers cannot trample each other.

This guide covers what the loop does, how to enable it, the configuration surface, and how to debug a decision.

## Why a reconciler

Before v0.2.0, state transitions lived inside the workers that produced them: `task-worker` advanced provisioning and running, `pr-watcher-worker` advanced PR state, `workflow-worker` advanced standalone runs, `repo-cleanup-worker` failed crashed pods. Each was correct in isolation but together they had three structural problems:

1. **Lost events left rows stuck.** A dropped websocket message or a crashed subscriber could strand a task in `provisioning` forever.
2. **No single decision point.** Two workers could attempt overlapping transitions on the same row.
3. **Hard to test.** Decisions were tangled with I/O, so most logic was exercised only through integration tests.

The reconciler centralizes the decision step. Workers still produce events and execute side effects (spawning pods, running agents, polling GitHub), but the call to `taskService.transitionTask()` flows through the reconciler.

## How a reconcile pass runs

```
Event source (state change, webhook, periodic resync)
   │
   ▼
reconcile-queue  (BullMQ, dedup by `${kind}__${id}`)
   │
   ▼
reconcile-worker pops { kind: "repo" | "standalone", id }
   │
   ▼
buildWorldSnapshot(ref)
  - read run row, pod state, PR status, deps, capacity, heartbeat
  - run reads in parallel, record per-source errors
   │
   ▼
reconcileRepo(snapshot)        ← pure function, no I/O
reconcileStandalone(snapshot)  ← pure function, no I/O
   │
   ▼  (Action union)
executeAction(action, snapshot, { shadow })
  - shadow=true:  log decision, return
  - shadow=false: CAS-update row; transitions delegate
                  to taskService.transitionTask()
   │
   ▼
Telemetry: reconcile.decision { kind, id, action, reason, outcome }
```

A snapshot is frozen — once read, the decision function only sees that point-in-time view, and the executor's CAS check refuses to write if the row moved underneath it. A failed CAS re-enqueues the job for a fresh pass rather than retrying with stale data.

## What it reconciles

Two run kinds, two state machines.

### Repo runs (`tasks` table)

States: `pending`, `waiting_on_deps`, `queued`, `provisioning`, `running`, `needs_attention`, `pr_opened`, `completed`, `failed`, `cancelled`.

The repo decision function evaluates capacity, dependency state, pod health, PR status (CI, review, merge), heartbeat staleness, and the per-task auto-merge / auto-review settings. Actions it can return:

| Action             | When                                                               |
| ------------------ | ------------------------------------------------------------------ |
| `transition`       | A state change is justified by the snapshot                        |
| `launchReview`     | PR is open, CI passed, review agent is enabled and not yet running |
| `autoMergePr`      | PR is approved, CI green, auto-merge enabled                       |
| `resumeAgent`      | Reviewer requested changes, auto-resume enabled                    |
| `requeueForAgent`  | Task is queued but capacity is now available                       |
| `patchStatus`      | Non-state metadata needs to be written (e.g., heartbeat, attempts) |
| `deferWithBackoff` | A required read failed; defer and retry with exponential backoff   |
| `noop`             | The world matches the desired state                                |

### Standalone runs (`workflow_runs` table)

States: `queued`, `running`, `completed`, `failed`. Simpler — the decision function reads pod state and decides whether to enqueue the agent, transition, or back off.

## Triggers

Three things can enqueue a reconcile job:

1. **State-change events.** Producers (the existing workers) enqueue after a meaningful side effect.
2. **Periodic resync.** Every 5 minutes (configurable) the resync worker scans non-terminal `tasks` and `workflow_runs` and enqueues each one. This is the safety net for lost events.
3. **Manual.** Operations tooling can enqueue directly with `{ kind, id }`.

The queue dedups by `${kind}__${id}`, so multiple producers do not amplify the load.

## Enabling

The reconciler is **off by default** and ships in shadow mode behind a feature flag. The recommended rollout is:

1. **Phase A — observe.** Enable workers in shadow mode. Decisions are logged but not applied. Compare logged decisions against actual state to validate correctness.
2. **Phase B — apply.** Disable shadow. The reconciler's decisions become the source of truth.
3. **Phase C — retire ad-hoc transitions.** Remove direct `transitionTask()` calls from individual workers as the reconciler subsumes them.

Today, Phase A is the supported configuration.

## Configuration

| Env var                           | Default           | Purpose                                                  |
| --------------------------------- | ----------------- | -------------------------------------------------------- |
| `OPTIO_RECONCILE_ENABLED`         | `false`           | Start the reconcile worker and resync worker             |
| `OPTIO_RECONCILE_SHADOW`          | `true`            | Log decisions without applying them                      |
| `OPTIO_RECONCILE_CONCURRENCY`     | `4`               | Parallel reconcile jobs                                  |
| `OPTIO_RECONCILE_LOCK_MS`         | `30000`           | BullMQ job lock — hard kill for runaway jobs             |
| `OPTIO_RECONCILE_RESYNC_INTERVAL` | `300000` (5 min)  | Full sweep cadence for non-terminal runs                 |
| `OPTIO_STALL_THRESHOLD_MS`        | `900000` (15 min) | Heartbeat staleness threshold the decision function uses |

## Schema

The `tasks` and `workflow_runs` tables each gained three columns (migration `1776686400_reconcile_columns.sql`):

| Column                    | Type          | Purpose                                                     |
| ------------------------- | ------------- | ----------------------------------------------------------- |
| `control_intent`          | `text`        | Operator-set intent: `cancel`, `retry`, `resume`, `restart` |
| `reconcile_backoff_until` | `timestamptz` | Defer further reconciliation until this time                |
| `reconcile_attempts`      | `integer`     | Backoff exponent counter                                    |

All three are nullable / default zero, so no backfill was required.

## Code map

| File                                                          | Role                                            |
| ------------------------------------------------------------- | ----------------------------------------------- |
| `packages/shared/src/reconcile/types.ts`                      | `RunRef`, `WorldSnapshot`, `Action` unions      |
| `packages/shared/src/reconcile/reconcile-repo.ts`             | Pure decision logic for repo runs               |
| `packages/shared/src/reconcile/reconcile-standalone.ts`       | Pure decision logic for standalone runs         |
| `apps/api/src/workers/reconcile-worker.ts`                    | BullMQ consumer + resync worker                 |
| `apps/api/src/services/reconcile-snapshot.ts`                 | Builds the frozen world view                    |
| `apps/api/src/services/reconcile-executor.ts`                 | CAS-gated mutations; delegates to `taskService` |
| `apps/api/src/services/reconcile-queue.ts`                    | Queue setup and dedup-aware enqueue helpers     |
| `apps/api/src/db/migrations/1776686400_reconcile_columns.sql` | Schema columns                                  |

Decision logic is exhaustively tested in `packages/shared/src/reconcile/*.test.ts`. Because the decision functions are pure, every state machine edge case is covered without mocking I/O.

## Debugging a decision

Each decision emits a `reconcile.decision` log line:

```
{ kind: "repo", id: "...", action: "transition", from: "running",
  to: "pr_opened", reason: "pr-detected", outcome: "applied" }
```

`outcome` is one of `applied`, `shadow`, `stale` (CAS failed, re-enqueued), `deferred` (backoff), or `error`. To understand why the reconciler chose an action, find the matching `reconcile.snapshot` log immediately preceding it — it contains the inputs the decision function saw.
