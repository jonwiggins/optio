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

What a `resumeAgent` tells the agent (`buildResumeContext` in
`reconcile-executor.ts`, with what `services/resume-facts.ts` reads first):

- **CI failing** — on GitLab, the failed jobs of the newest pipeline on the
  MR's head commit (blocking ones first, at most five), each with its name,
  stage and the last 150 lines of its log, GitLab's markers and colours
  removed and token / password / key shapes masked
  (`git-platform/gitlab-ci-logs.ts`). The prompt's first line names the jobs,
  so the needs-attention event on the task page shows them. On GitHub, with
  `OPTIO_CI_FAILURE_LOGS=true` (Helm `api.extraEnv`), the same from GitHub
  Actions: the failed jobs of the newest failed run of each workflow on the
  PR's head commit, their logs without timestamps or group markers, and `gh`
  in the prompt's words (`git-platform/github-ci-logs.ts`; the log download
  URL GitHub redirects to is fetched without the token).
  `OPTIO_CI_FAILURE_LOGS=false` reads no logs on either. Elsewhere, or when
  the jobs can't be read, the generic "investigate which checks failed".
- **Conflicts** — `git rebase origin/<branch>` onto the MR's own target
  branch (the task's branch when the MR can't be read), never a fixed
  `origin/main`. A manual restart of a task with conflicts uses the task's
  branch too.
- **Review** — the reviewer's comments, as before.

The reads use the task's own token (its creator, workspace and team). The
resume waits for them at most 15 seconds, then goes ahead with the fallback
(the generic CI wording, the task's own branch). After the wait it checks the
task hasn't changed meanwhile; if another reconcile pass already resumed it,
this one is dropped as stale instead of resuming the task twice.

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

## Attachment: runs that outlive an API process

Every agent run — a Repo Task, a Job run, a persistent-agent turn, a PR-review run — lives in its pod under the **run protocol** (`packages/container-runtime/src/run-protocol.ts`, `docs/plans/scale-out.md` §1): a start exec launches the agent under a supervisor and returns; the agent's output goes to `output.ndjson` in its run directory; any API instance can attach to that file, append to the agent's stdin, or signal it. One instance at a time **streams** a run: the one holding its attachment.

The run's row carries the attachment (`exec_state`, `exec_pid`, `consumed_bytes`, `attached_by`, `attach_lease_until`; on `tasks` for Repo Tasks and Job runs, on `persistent_agent_turns`, on `pr_review_runs`). `apps/api/src/services/run-attachment.ts` owns them:

- **Hold.** The job that claims a run (its state-machine claim) takes the lease and renews it every 20 s; a lease lasts 60 s. `attached_by` names the **hold**, not just the instance (`<instance>/<nonce>`), and every write of the columns is a CAS on it — so an old attempt's job and a new attempt's job on the same instance are never mistaken for each other. A renewal that matches nothing means the run was taken or queued again: the stream is severed at once and the worker returns.
- **Start.** Once the supervisor runs, one update sets `exec_state = started`, `exec_pid`, `consumed_bytes = 0` and renews the lease. A task or review run stays `provisioning` (an agent turn's agent stays `provisioning`) until then, so `running` always means an agent some instance can attach to. A fresh start in a run directory stops a previous attempt's supervisor still alive there (TERM, up to 5 s, KILL, up to 5 s; one that survives fails the start with nothing touched), then moves that attempt's files aside — never truncated in place, so a straggler writing through an open descriptor never lands in the new output.
- **Claim** (a re-attach). One CAS: the agent was started (or its exit is half recorded), the run is still active (`provisioning`/`running`; a turn not finished) — a run already terminal is never claimed — and the lease expired or the attachment was closed, whoever held it. An attach job exits at once when a job of this process still holds the run.
- **Stream** (`streamRun`, the one loop every kind uses). The attach reads the output from byte 0. Lines that end at or before `consumed_bytes` were stored by an earlier attachment: they only feed the in-memory derivations (the PR tool-call tracker, the session id, the terminal event, the result digest — cost, tokens, auth failures — and a command's exit receipt). The rest become log rows, each chunk's batch stored **with the new offset in one transaction** (`appendRunLogsBatch`: the offset write is a CAS on the hold and the old offset), so a run that changes hands gets no duplicate and no gap. Offsets count bytes and move only at line ends. A re-attach reads the output by what the attempt ran (a Job run's recorded `agent_type`, a turn's recorded runtime), never a definition edited since.
- **Settle.** When the agent exited and its output is consumed, `settleRun` records `exec_state = exited` with the run's spend in the same statement, iff this hold has the run and nobody recorded the exit before — so cost is added once, whoever finishes the run. An instance that attaches to a run whose exit was recorded but whose state never moved finishes it without adding the spend again. A settle (or a stream) that lost the run tells `taken` (another hold has the same agent) from `reset` (the run was queued again, or a new attempt started): a reset job gives its pod slot back. The attached instance then removes the run directory, reading the tail of the agent's stderr in the same exec (a warning in the log; a failed, lost or silent run's error message carries it).
- **Letting go** (`endRunJob`, the one rule for every kind and every way a job ends). A job that started or claimed an agent and ends without finishing the run or leaving it for another instance — an error while setting the run up, a cancel or requeue under it — stops that agent first (TERM, scoped to its supervisor's pid, so a newer attempt in the same directory is never hit), unless its exit is recorded or another hold streams it; then it gives the lease and the slot back.
- **Errors past the start** (`onStreamError`). An error once the agent streams or settles — a database error writing the logs, a publish, a parser — is the instance's trouble, not the run's: the job gives the lease up (`attach_lease_until = now()`) without signalling the agent or failing the run, and the reconciler re-attaches. Attach jobs that fail one attempt are counted (`attachFailures` in the run row's jsonb — a task's or Job run's `metadata`, a review run's `metadata`, a turn's `wake_payload`; cleared when the attempt starts and when an attach job makes progress; the starting job's failure does not count): the third in a row fails the run with the last error, the way the kind fails a run, and its agent is stopped by the rule above.
- **Requeue.** Every path that sends a run back to `queued` (a task's transition, its force-redo, a Job run's retry or requeue, a review run's requeue) goes through `resetRunAttempt`: in the same transaction the attachment columns are cleared, and once it commits the last attempt's agent, if it was started, gets TERM (pid-scoped).
- **Detach.** On SIGTERM, before the workers close, every run still being set up or streamed is severed and its lease set to `now()`, so other instances pick the runs up in seconds. A run past its stream keeps its lease and finishes settling there (waited for up to 20 s, `OPTIO_DETACH_SETTLE_WAIT_MS`), so its result, transitions and callbacks happen once.

The reconciler decides from `snapshot.execution` (the row's attachment; the open turn's for an agent, the active run's for a review). A lease in the future is **attached**; a row with no lease yet is attached while it was written in the last two lease periods (claiming a run and taking its lease are two statements).

| Run is…                                      | Attachment                                        | Decision                                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running` / `provisioning`                   | `exec_state` started or exited, lease expired     | **`reattach`**: enqueue the kind's attach job `attach__<run>__<expired lease ms>`; its handler claims by CAS (`claimAttachment`) and finishes the run from `consumed_bytes`, or exits when it loses |
| `provisioning` (a Job run: `running`)        | never started, lease expired, held by an instance | **`requeueRun`**: the kind's own retry — a task or review run back to `queued`, a Job run through `failed` to `queued` without spending a retry, a turn halted and its agent back to `idle`         |
| `running`                                    | never started, never held                         | A run from before the protocol: a task needs attention, a Job run or agent fails as uncertain (what boot used to do)                                                                                |
| `running`                                    | attached                                          | Stall detection as before — **only while attached**; an unattached run is re-attached first                                                                                                         |
| any active state, pod `error` / `terminated` | any                                               | The existing pod-death transition                                                                                                                                                                   |

The executor applies `reattach` under the version CAS without writing anything (`updated_at = updated_at`), so a worker finishing the run at the same moment never loses its own CAS. The attach job's id dedupes every pass that saw the same expiry; jobs are removed when done, so the next expiry gets a new one.

A worker's job lasts as long as its stream, so the run queues use `lockDuration` 60 s and `stalledInterval` 30 s; a stale BullMQ re-delivery is a no-op (the run is no longer queued, or its claim CAS loses). Cancelling a run (any kind) signals its process group from whichever instance took the request (`signalRun`: the pod and run directory from the database); a mid-run message to a task is appended to its agent's stdin by the route (`task-message-delivery.ts`); the reconciler's stall and pod-death failures stop a still-running agent the same way. A boot fails nothing: it re-enqueues `queued` work, repairs pod slot counts, sweeps expired attachments and kicks a resync.

## Producers

Several things enqueue a reconcile job:

1. **State-change events.** `taskService.transitionTask`, `workflow-worker`'s `transitionRun` helper, and the persistent-agent worker's per-turn finalizer all fire `enqueueReconcile` after every successful transition. Anywhere the codebase changes a run's state, the reconciler is woken within milliseconds.
2. **PR poll updates.** The `pr-watcher-worker` polls open PRs every 30s, writes refreshed `prState` / `prChecksStatus` / `prReviewStatus` / `prReviewComments` to the row, then enqueues a reconcile so the decision function sees the new PR data.
3. **Pod-health events.** When `repo-cleanup-worker` detects a crashed or OOM-killed pod, it marks worktrees dirty and enqueues a reconcile for each affected task — the reconciler observes `pod.phase=error` from the snapshot and fires the FAILED transition.
4. **Persistent Agent wakes.** `wakeAgent()` (called from the inbox API, the inter-agent HTTP API, the workflow-trigger worker on `target_type='persistent_agent'`, and the cleanup worker on warm-window expiry) enqueues a reconcile so the decision function picks up new messages or intents.
5. **Control intents.** UI/API actions that set `control_intent` (`cancel`, `retry`, `resume`, `restart`, `pause`, `archive`) enqueue a reconcile so the decision function applies the intent.
6. **Periodic resync.** Every 5 minutes (configurable) the resync worker scans non-terminal runs across all four tables and enqueues each one. Safety net for any signal that's lost. Every boot asks for one pass at once.
7. **The attach sweep.** Every 30 s (`attach-sweep`, one BullMQ job scheduler every instance upserts) every active run whose attachment expired — on `tasks`, `pr_review_runs`, `persistent_agent_turns` — gets a reconcile pass, which re-attaches it. A killed instance's runs move on within a lease period plus a sweep.

The queue dedups by `${kind}__${id}`, so multiple producers do not amplify load.

## Configuration

| Env var                           | Default           | Purpose                                                  |
| --------------------------------- | ----------------- | -------------------------------------------------------- |
| `OPTIO_RECONCILE_CONCURRENCY`     | `4`               | Parallel reconcile jobs                                  |
| `OPTIO_RECONCILE_LOCK_MS`         | `30000`           | BullMQ job lock — hard kill for runaway jobs             |
| `OPTIO_RECONCILE_RESYNC_INTERVAL` | `300000` (5 min)  | Full sweep cadence for non-terminal runs                 |
| `OPTIO_STALL_THRESHOLD_MS`        | `900000` (15 min) | Heartbeat staleness threshold the decision function uses |
| `OPTIO_MAX_AUTO_RESUMES`          | `10`              | Cap on `auto_resume_*` events between manual actions     |
| `OPTIO_ATTACH_LEASE_MS`           | `60000`           | How long a run's attachment lasts without a renewal      |
| `OPTIO_ATTACH_RENEW_MS`           | `20000`           | How often the attached instance renews it                |
| `OPTIO_ATTACH_SWEEP_INTERVAL_MS`  | `30000`           | How often expired attachments get a reconcile pass       |
| `OPTIO_DETACH_SETTLE_WAIT_MS`     | `20000`           | On shutdown, how long runs past their stream may settle  |

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
| `packages/shared/src/reconcile/attachment.ts`                 | The pure reading of a run's attachment                |
| `apps/api/src/services/run-attachment.ts`                     | Hold, claim, stream, settle, detach; the attach job   |
| `apps/api/src/services/run-output-digest.ts`                  | A run's result, read line by line as it streams       |
| `apps/api/src/workers/attach-sweep-worker.ts`                 | Reconcile passes for expired attachments              |
| `apps/api/src/db/migrations/1776686400_reconcile_columns.sql` | Schema columns for `tasks` + `workflow_runs`          |

Decision logic is exhaustively tested in `packages/shared/src/reconcile/*.test.ts`. Because the decision functions are pure, every state machine edge case is covered without mocking I/O.

## Debugging a decision

Each decision emits a `reconcile.decision` log line:

```
{ kind: "repo", id: "...", action: "transition", from: "running",
  to: "pr_opened", reason: "pr-detected", outcome: "applied" }
```

`outcome` is one of `applied`, `shadow`, `stale` (CAS failed, re-enqueued), `deferred` (backoff), or `error`. To understand why the reconciler chose an action, find the matching `reconcile.snapshot` log immediately preceding it — it contains the inputs the decision function saw.
