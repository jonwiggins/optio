# Reconciliation Control Plane

Optio drives task and pod state through a Kubernetes-style reconciliation loop. A worker observes the world, runs a pure decision function, and applies a single typed action — gated by compare-and-swap so concurrent observers cannot trample each other.

This guide covers what the loop does, the configuration surface, and how to debug a decision.

## Why a reconciler

Before v0.2.0, state transitions lived inside the workers that produced them: `task-worker` advanced provisioning and running, `pr-watcher-worker` advanced PR state, `workflow-worker` advanced standalone runs, `repo-cleanup-worker` failed crashed pods. Each was correct in isolation but together they had three structural problems:

1. **Lost events left rows stuck.** A dropped websocket message or a crashed subscriber could strand a task in `provisioning` forever.
2. **No single decision point.** Two workers could attempt overlapping transitions on the same row.
3. **Hard to test.** Decisions were tangled with I/O, so most logic was exercised only through integration tests.

The reconciler centralizes the decision step. Workers still produce events and execute side effects (spawning pods, running agents, polling GitHub), but PR-driven transitions, auto-merge, auto-resume, review launch, stall and pod-death detection, and control-intent handling all flow through the reconciler.

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
executeAction(action, snapshot)
  - state mutations: CAS-update row, then delegate to
                     taskService.transitionTask() for fan-out
  - side effects: enqueue agent jobs, call platform.merge,
                  launch review subtask, etc.
   │
   ▼
Telemetry: reconcile.decision { kind, id, action, reason, outcome }
```

A snapshot is frozen — once read, the decision function only sees that point-in-time view, and the executor's CAS check refuses to write if the row moved underneath it. A failed CAS re-enqueues the job for a fresh pass rather than retrying with stale data.

## What it reconciles

Four run kinds, four state machines. The `RunKind` discriminator is `"repo" | "standalone" | "pr-review" | "persistent-agent"` (see `packages/shared/src/reconcile/types.ts`).

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

### PR-review runs (`pr_reviews` table)

External PR reviews — code-review subtasks for PRs that aren't tied to a Repo Task. The decision function tracks pod state, review-agent completion, and re-runs on push events when configured. Lifted out of the Repo Task pipeline so external PRs can be reviewed without going through the worktree flow.

### Persistent Agent runs (`persistent_agents` table)

The state machine is **cyclic** rather than terminal — agents return to `idle` after each successful turn rather than transitioning to a terminal state.

States: `idle`, `queued`, `provisioning`, `running`, `paused`, `failed`, `archived`.

```
idle ── pending msg / intent ──▶ queued ──▶ provisioning ──▶ running
  ▲                                                              │
  └────────────────── turn halted (success) ─────────────────────┘
```

The Persistent Agent decision function (`reconcile-persistent-agent.ts`) considers: pending inbox messages, control intent (`pause`, `resume`, `restart`, `archive`), pod lifecycle mode (`always-on` / `sticky` / `on-demand`), pod warm-window (`keep_warm_until`), `consecutive_failures` against `consecutive_failure_limit`, and reconcile backoff. Actions it can return include `enqueueTurn`, `provisionPod`, `markIdle`, `pausePod`, `archive`, `failPermanently`, plus the standard `patchStatus` / `deferWithBackoff` / `noop`.

`paused` and `failed` require a manual `resume` control intent before the agent will act again. `archived` is terminal — the row is kept for history but no further turns are possible.

## Producers

Several things enqueue a reconcile job:

1. **State-change events.** `taskService.transitionTask`, `workflow-worker`'s `transitionRun` helper, and the persistent-agent worker's per-turn finalizer all fire `enqueueReconcile` after every successful transition. Anywhere the codebase changes a run's state, the reconciler is woken within milliseconds.
2. **PR poll updates.** The `pr-watcher-worker` polls open PRs every 30s, writes refreshed `prState` / `prChecksStatus` / `prReviewStatus` / `prReviewComments` to the row, then enqueues a reconcile so the decision function sees the new PR data.
3. **Pod-health events.** When `repo-cleanup-worker` detects a crashed or OOM-killed pod, it marks worktrees dirty and enqueues a reconcile for each affected task — the reconciler observes `pod.phase=error` from the snapshot and fires the FAILED transition.
4. **Persistent Agent wakes.** `wakeAgent()` (called from the inbox API, the inter-agent HTTP API, the workflow-trigger worker on `target_type='persistent_agent'`, and the cleanup worker on warm-window expiry) enqueues a reconcile so the decision function picks up new messages or intents.
5. **Control intents.** UI/API actions that set `control_intent` (`cancel`, `retry`, `resume`, `restart`, `pause`, `archive`) enqueue a reconcile so the decision function applies the intent.
6. **Periodic resync.** Every 5 minutes (configurable) the resync worker scans non-terminal runs across all four tables and enqueues each one. Safety net for any signal that's lost.

The queue dedups by `${kind}__${id}`, so multiple producers do not amplify load.

## Configuration

| Env var                           | Default           | Purpose                                                  |
| --------------------------------- | ----------------- | -------------------------------------------------------- |
| `OPTIO_RECONCILE_CONCURRENCY`     | `4`               | Parallel reconcile jobs                                  |
| `OPTIO_RECONCILE_LOCK_MS`         | `30000`           | BullMQ job lock — hard kill for runaway jobs             |
| `OPTIO_RECONCILE_RESYNC_INTERVAL` | `300000` (5 min)  | Full sweep cadence for non-terminal runs                 |
| `OPTIO_STALL_THRESHOLD_MS`        | `900000` (15 min) | Heartbeat staleness threshold the decision function uses |
| `OPTIO_MAX_AUTO_RESUMES`          | `10`              | Cap on `auto_resume_*` events between manual actions     |

## Schema

The `tasks`, `workflow_runs`, `pr_reviews`, and `persistent_agents` tables each carry the same three reconcile columns (`tasks` and `workflow_runs` got them via migration `1776686400_reconcile_columns.sql`; `persistent_agents` includes them in its own migration):

| Column                    | Type          | Purpose                                                     |
| ------------------------- | ------------- | ----------------------------------------------------------- |
| `control_intent`          | `text`        | Operator-set intent: `cancel`, `retry`, `resume`, `restart` |
| `reconcile_backoff_until` | `timestamptz` | Defer further reconciliation until this time                |
| `reconcile_attempts`      | `integer`     | Backoff exponent counter                                    |

All three are nullable / default zero, so no backfill was required.

## Code map

| File                                                          | Role                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/shared/src/reconcile/types.ts`                      | `RunKind`, `RunRef`, `WorldSnapshot`, `Action` unions |
| `packages/shared/src/reconcile/reconcile-repo.ts`             | Pure decision logic for repo runs                     |
| `packages/shared/src/reconcile/reconcile-standalone.ts`       | Pure decision logic for standalone runs               |
| `packages/shared/src/reconcile/reconcile-pr-review.ts`        | Pure decision logic for external PR reviews           |
| `packages/shared/src/reconcile/reconcile-persistent-agent.ts` | Pure decision logic for Persistent Agents             |
| `apps/api/src/workers/reconcile-worker.ts`                    | BullMQ consumer + resync worker                       |
| `apps/api/src/services/reconcile-snapshot.ts`                 | Builds the frozen world view                          |
| `apps/api/src/services/reconcile-executor.ts`                 | CAS-gated mutations; delegates to `taskService`       |
| `apps/api/src/services/reconcile-queue.ts`                    | Queue setup and dedup-aware enqueue helpers           |
| `apps/api/src/db/migrations/1776686400_reconcile_columns.sql` | Schema columns for `tasks` + `workflow_runs`          |

Decision logic is exhaustively tested in `packages/shared/src/reconcile/*.test.ts`. Because the decision functions are pure, every state machine edge case is covered without mocking I/O.

## Debugging a decision

Each decision emits a `reconcile.decision` log line:

```
{ kind: "repo", id: "...", action: "transition", from: "running",
  to: "pr_opened", reason: "pr-detected", outcome: "applied" }
```

`outcome` is one of `applied`, `shadow`, `stale` (CAS failed, re-enqueued), `deferred` (backoff), or `error`. To understand why the reconciler chose an action, find the matching `reconcile.snapshot` log immediately preceding it — it contains the inputs the decision function saw.
