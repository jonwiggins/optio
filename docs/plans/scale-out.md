# Scale-out: state in Postgres, runs that outlive an API pod

Optio runs one API/web pod. The Helm chart enforces it, because the process
holds state that a second replica would not see, and because every agent run
is an open Kubernetes exec stream held by that one process: when the pod goes
away, so does the run. This plan makes the API process disposable. Any number
of API pods share one Postgres and one Redis; the pod a run is attached to can
be killed, and another pod picks the run up where it was, with every log line
accounted for once.

**Status (2026-10-10):** phase A (foundation) built; B, C1, C2, D, E to come.
Phases land as separate PRs; each leaves the system working on one replica.

## Vocabulary

| Word                | Meaning                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Instance**        | One API process. `OPTIO_INSTANCE_ID` = `<hostname>:<random-at-boot>` (the pod name in Kubernetes, with a boot suffix so a restarted pod is a new instance).                                              |
| **Run**             | One agent execution Optio supervises: a Repo Task run, a Job run, a persistent-agent turn, a PR-review run. All are `tasks` rows except reviews (`pr_review_runs`) and turns (`persistent_agent_turns`). |
| **Run directory**   | The run's directory in its pod, `/home/agent/optio/runs/<run id>` (the run home of #664), holding the agent's output, stdin, pid and exit files.                                                         |
| **Supervisor**      | The pod-side shell that starts the agent detached from the exec session and records its exit. Nothing Optio starts in a pod is a child of an exec any more.                                              |
| **Attached**        | A run some instance is currently streaming: `attached_by` is that instance and `attach_lease_until` is in the future. Renewed every 20 s; expires 60 s after the last renew.                             |
| **Consumed offset** | `consumed_bytes` on the run: how much of the output file has been turned into log rows. Committed with those rows in one transaction, at line boundaries only.                                           |
| **Lease**           | A row in `leases` (`key`, `holder`, `expires_at`): the one way an instance claims something for a while — a poller's turn, a chat lock, a Local host.                                                    |

## Starting point (verified in code, 2026-10-10)

What ties the system to one process, from the inventory that preceded this plan:

- **Runs are exec streams.** `execTaskInRepoPod`, `execRunInPod` and
  `execTurnInPod` open one Kubernetes exec per run and the BullMQ processor
  reads its stdout for the run's whole life (`task-worker.ts` ~681–830,
  `workflow-worker.ts` ~305+, `persistent-agent-worker.ts` ~302+; PR reviews
  reuse the task path). The whole output is also kept in memory (`allLogs`).
  The pod-side script SIGTERMs the agent when stdout breaks (the EPIPE
  watchdog in `repo-pool-service.ts`), because nobody would read it otherwise;
  pooled runs have no watchdog and orphan instead. Boot runs unconditional
  sweeps that fail or flag every in-flight run (`recoverInterruptedExecutions`,
  `reconcileOrphanedTasks`, `recoverSessionTurns`), since nothing records which
  process owns a run.
- **Claude's stdin matters.** Claude Code runs with `--input-format stream-json`:
  the first user message and every mid-run message are written to the exec's
  stdin, and stdin is closed on the agent's terminal event so it exits.
- **In-memory state that diverges across replicas:** WebSocket upgrade tokens
  (`session-service.ts wsUpgradeTokens`; `/ws` has no ingress affinity), the
  per-IP WS cap, the Optio-chat per-user lock, Slack/Linear delivery dedupe
  (`event-ingress.ts recentDeliveryIds`; the other sources use Redis `SET NX`),
  the claim mutexes around count-then-claim (`claimLockChain` in the task and
  workflow workers), GitHub token refresh locks, config-sync serialization,
  glance/push bookkeeping (`glance-service.ts`, which says it assumes one
  replica), session-chat listeners and interrupts (`session-turn-service.ts`),
  session-sharing sockets, the whole Optio Local relay (`local-relay.ts`).
- **Pollers that must not overlap:** ticket sync (dedupes by scanning 500
  tasks), the schedule checker (advances `next_fire_at` after firing, no CAS),
  external PR review (`pr_reviews_pr_url_idx` is not unique), and boot's
  `cleanRepeatJobs`, which deletes every repeat schedule and lets workers re-add
  them. There is no leader election, advisory lock (outside migrations and
  secret heals), `FOR UPDATE` or `SKIP LOCKED` anywhere.
- **Already cross-replica:** BullMQ job delivery with CAS claims, the reconciler
  (version CAS in `reconcile-executor.ts`), every log/event stream (Redis
  pub/sub per task, Job run, review, agent; `/ws/events`), mid-task messages
  (`optio:task-messages:{id}`), pod slots (DB), rate limits, the setup token,
  session-terminal sockets (tmux in the pod), chat-turn exclusivity (a unique
  partial index).
- The agent image is Ubuntu 24.04 (GNU coreutils: `tail --pid`, `flock`,
  `setsid`, `python3` are there). The run home from #664 is
  `/home/agent/optio/runs/<id>`, deterministic per run, removed by the exec's
  EXIT trap and again with the worktree.
- BullMQ is 5.52 (`upsertJobScheduler` exists). The fake runtime
  (`packages/container-runtime/src/fake.ts`) kept its containers in a
  per-process `Map` and played agents in-process, so it could not survive the
  API process it ran in; phase A gave it a directory and a process per run.
- Found while building phase A: `ticket_external_id` is written by five paths
  besides the sync (the API, the Issues page, ticket triggers, local
  terminals, ticket events), so a unique index on tasks would reject work a
  person starts on purpose; the sync gets a claim table instead. The outbound
  webhooks already own `webhook_deliveries`, so the inbound dedupe table is
  `inbound_webhook_deliveries`. The protocol's script fragments have to live
  with the runtimes (`packages/container-runtime/src/run-protocol.ts`, the
  API imports the runtime package and not the other way round); `pod-env.ts`
  re-exports them beside the other script pieces. A `RunExit` has a third
  kind, `detached`, for an attach whose exec dropped without a marker (the
  attaching instance died, or closed it): neither exited nor lost.

## Design

### 1. The run protocol: start, attach, deliver, kill

Every run goes through four pod-side operations, each a short exec. The
`ContainerRuntime` interface gains them, so the Kubernetes runtime and the fake
runtime implement the same protocol and the workers never build a long-lived
exec again.

```
startRun(handle, { runId, script, initialStdin })   → { pid }        exits as soon as the agent is running
attachRun(handle, { runId, fromByte })              → { output, exit } output from fromByte until the agent exits; exit resolves exited:<code> | lost | detached
deliverStdin(handle, { runId, line })               → void           appends one line to stdin.ndjson (any instance may call it)
killRun(handle, { runId, signal })                  → void           kills the supervisor's process group
```

**Start.** The existing setup script (repo lock, worktree, credential helper,
setup files, setup commands) stays as it is up to the agent command. Instead
of running the agent inline, it writes `initialStdin` (the first stream-json
user message, built by the worker as today) to `$RUN_DIR/stdin.ndjson`, then
launches the supervisor detached — `setsid`, stdio to files, `&`, `disown` —
and prints `__OPTIO_RUN_STARTED__:<pid>` and exits. The supervisor:

```
( tail -n +1 -f stdin.ndjson | while IFS= read -r l; do [ "$l" = "__OPTIO_STDIN_EOF__" ] && break; printf '%s\n' "$l"; done ) \
  | <agent command> >> output.ndjson 2>> stderr.log
echo $? > exit
```

The `while read` loop closes the agent's stdin when it sees the EOF sentinel,
which is how the worker ends a Claude turn (it appends the sentinel where it
called `stdin.end()` today). `pid` holds the supervisor's pid, and `setsid`
makes it a process-group leader so `killRun` can take the whole tree. The
EXIT trap no longer kills children or removes the run directory; the
EPIPE watchdog is gone. `touch /home/agent/.optio-env-ready` moves into the
supervisor, after a zero exit.

**Attach.** `tail -c +$((fromByte+1)) --pid=<pid> -f output.ndjson`, which
streams from the offset and ends when the supervisor exits, flushing what is
left; then the script prints `__OPTIO_RUN_EXIT__:<code>` from the `exit` file
(waiting up to a few seconds for it). A pid that is gone with no `exit` file
(the pod itself restarted) prints `__OPTIO_RUN_LOST__`, which the worker
treats as a pod death. Attach always streams from `consumed_bytes`; the worker
**rebuilds its in-memory derivations from byte 0** on a re-attach (the PR
tool-call tracker, the session id, the terminal-event flag) by reading the
file once without persisting, so nothing derived is ever persisted beside the
offset. Output is MBs at most.

**Deliver.** Mid-run user messages stop needing the attached instance: the
route that receives a message appends the stream-json line to
`stdin.ndjson` through `deliverStdin` and marks it delivered. The Redis
message channel stays only to notify viewers.

**Kill.** `killRun` sends the signal to the process group in `pid`; this is
what cancel and the reconciler's stall action use, from any instance.

**Where things live.** `RUN_DIR` is the run home. It is no longer removed by
the exec's EXIT trap; the worker removes it when the run reaches a terminal
state and the output has been fully consumed, and the worktree / pod cleanup
paths from #664 remain the backstop.

### 2. Ownership: columns, lease, reconcile

Run rows (`runColumns()` in `schema.ts`, so both views pick them up; and the
same columns on `pr_review_runs` and `persistent_agent_turns`):

| Column               | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `exec_state`         | `null` (not started), `started` (supervisor launched; `exec_pid` set), `exited` |
| `exec_pid`           | The supervisor's pid                                                            |
| `consumed_bytes`     | Bytes of `output.ndjson` turned into log rows                                   |
| `attached_by`        | Instance streaming the run, or null                                             |
| `attach_lease_until` | When that attachment expires                                                    |

**Claiming an attachment** is one CAS:
`UPDATE … SET attached_by = $me, attach_lease_until = now() + 60s WHERE id = $id AND (attached_by IS NULL OR attach_lease_until < now())`.
The attached worker renews every 20 s. On SIGTERM it **detaches**: closes the
exec, sets `attach_lease_until = now()`, and lets the process exit, so another
instance picks the run up in seconds rather than after a lease expiry.

**The reconciler** (one new action per run kind, `reattach`, plus the existing
`requeue`) decides from the snapshot:

- `running`/`provisioning`, `exec_state = started`, attachment expired → **reattach**: enqueue the kind's BullMQ job with a fresh id (`attach:<run>:<n>`). The handler claims the attachment (CAS above) and, if it loses, exits.
- `provisioning`, `exec_state = null`, attachment expired → the run never got going: **requeue** through the existing retry path (same-pod affinity, worktree reset).
- Stall (`lastActivityAt` old) only counts while attached; an unattached run is re-attached first.
- `__OPTIO_RUN_LOST__` and a pod that is gone → the existing pod-death transition.

A repeat job every 30 s (`attach-sweep`, idempotent, under a lease) enqueues
reconcile for runs whose attachment expired, so pickup does not wait for the
5-minute resync.

**Boot** no longer fails anything. `recoverInterruptedExecutions` and the
fail/flag half of `reconcileOrphanedTasks` go; what remains is re-enqueueing
`queued` work (deduped against BullMQ), count repair, and a resync kick.
`recoverSessionTurns` stays until chat turns move to the protocol (see Out of
scope).

**BullMQ** job lifetime still equals attachment lifetime, but stall
re-delivery is no longer how recovery happens: the attach handler is
idempotent through the lease CAS, so a stale re-delivery is a no-op.
`lockDuration` / `stalledInterval` drop to 60 s / 30 s for the run queues.

**Repeat jobs** use `upsertJobScheduler` with stable ids; every instance
upserts the same schedulers, and boot's `cleanRepeatJobs` is deleted.

### 3. State moves: what goes to Postgres, what is a cache, what is transport

Rule: **correctness state goes to Postgres**; a **bounded-staleness cache**
may stay per instance when every instance can rebuild it and a stale read
costs nothing but freshness; **transport** (fan-out of live frames) is Redis
pub/sub, as it already is for logs and events.

| Today (in process)                                                                                                      | Home                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WS upgrade tokens                                                                                                       | `ws_upgrade_tokens (token_hash pk, user_id, workspace_id, expires_at)`; consumed with `DELETE … RETURNING`; swept by the attach-sweep job                                                                                                                                                                                                                                                  |
| Slack / Linear in-memory dedupe, Redis `SET NX` dedupe                                                                  | `inbound_webhook_deliveries (source, delivery_id, received_at; pk (source, delivery_id))` (`webhook_deliveries` is the outbound log); `INSERT … ON CONFLICT DO NOTHING RETURNING` claims; rows older than 24 h swept                                                                                                                                                                       |
| `claimLockChain` (tasks, workflows)                                                                                     | `pg_advisory_xact_lock(hashtext('claim:tasks'))` and per-repo / per-Job keys inside one transaction around count + CAS                                                                                                                                                                                                                                                                     |
| Optio-chat per-user lock, config-sync `running`, GitHub token refresh locks                                             | `leases` (`acquireLease` / `renewLease` / `releaseLease`: insert-or-update-where-expired, returning the row iff acquired)                                                                                                                                                                                                                                                                  |
| Pollers: ticket sync, schedule checker, external PR review, repo cleanup, skill sync, token validation                  | Each sweep runs under a lease (`poller:<name>`), **and** the work is made safe to overlap: a `ticket_sync_claims` row per (source, ticket, repo) the sync inserts before creating a task (not a unique index on tasks: a person may start a second task from the same issue on purpose), `next_fire_at` advanced by CAS before firing, a unique partial index on active reviews per PR URL |
| Glance / push bookkeeping (`lastAttention`, `lastNeedsYou`, `lastRunning`, end and snooze timers, `hostOfflineAlerted`) | `glance_state (key pk, value jsonb, due_at)`; timers become `due_at` rows swept by the attach-sweep job. The APNs/FCM 1-second coalescer stays per instance (worst case one duplicate push, which the collapse id folds)                                                                                                                                                                   |
| Session-chat listeners, interrupt, end-session                                                                          | Frames fan out on `optio:session:{id}` (the channel that exists with no subscriber); interrupt and end are `control_intent` on the turn, acted on by the attached instance; the turn's exec itself moves to the run protocol in a later phase                                                                                                                                              |
| Session-sharing socket close on revoke                                                                                  | Publish a `session:share_revoked` event; every instance closes its sockets on receipt (the 10 s DB recheck stays)                                                                                                                                                                                                                                                                          |
| Installed-skills cache (ReadWriteOnce PVC)                                                                              | `installed_skill_files (skill_id, path, content bytea, executable)` written by the sync worker; spawn reads the DB; the PVC goes                                                                                                                                                                                                                                                           |
| Per-IP WS cap, health/version/setup/scan caches, gauges                                                                 | Stay per instance (caches). Documented as per replica                                                                                                                                                                                                                                                                                                                                      |

### 4. Optio Local relay (phase D)

A daemon is one socket on one instance; a viewer may be on another. The
owning instance holds `leases` key `local-host:<id>`; "newest daemon wins"
takes the lease by force and the old holder closes its socket when its renew
fails. Terminal output is published on `optio:local:term:{id}:out` (binary
frames as buffers), which viewers subscribe to on any instance; everything
inbound (input, resize, view reports, attach, spawn, kill, dirs, limits,
credentials, backfill, capability queries) is published on
`optio:local:host:{id}:in` and replies on `optio:local:reply:{requestId}`;
the owner consumes them and keeps the grid arbiter. `isHostOnline` reads the
lease. Until this phase lands, the chart keeps `api.replicas` at 1.

### 5. Helm and ops

`OPTIO_INSTANCE_ID` from the downward API pod name plus a boot suffix. The
replica validation lifts in phase D. The deployment stays `Recreate`:
migrations still run at boot under the advisory lock and there is no
mixed-version window; since runs now survive the gap, Recreate costs an API
outage of seconds, not any work. Rolling updates (expand/contract migrations)
are out of scope.

## Phases

| Phase | PR                       | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Depends on              |
| ----- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| A     | foundation               | This document. `OPTIO_INSTANCE_ID`. **Every schema change of the whole plan in one migration** (run columns on the three run tables, `leases`, `ws_upgrade_tokens`, `inbound_webhook_deliveries`, `glance_state`, `installed_skill_files`, `ticket_sync_claims`, the unique partial index on active PR reviews). `lease-service.ts`. The run protocol on `ContainerRuntime` with the Kubernetes implementation (script builders in `pod-env.ts` / `repo-pool-service.ts`) and the **multi-process fake runtime**: containers and runs persisted under `OPTIO_FAKE_RUNTIME_DIR`, fake agents as detached child processes writing `output.ndjson`, so a fake run survives the API process. `test-utils/e2e/api-cluster.ts` starts N API servers on one database and one fake-runtime dir. | —                       |
| B     | re-attachable runs       | Workers for Repo Tasks, Job runs, agent turns and PR reviews on the protocol: start, attach from `consumed_bytes`, log rows + offset in one transaction, derivations rebuilt from byte 0, `allLogs` removed, deliver via stdin file, kill via pid, lease renew and SIGTERM detach. Reconciler `reattach` / `requeue`, attach-sweep job, boot sweeps reduced, BullMQ schedulers upserted. The kill-the-API e2e suite.                                                                                                                                                                                                                                                                                                                                                                    | A                       |
| C1    | coordination             | Advisory-lock claims, poller leases and unique keys, trigger CAS, webhook dedupe table, WS tokens table, chat lock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | A                       |
| C2    | sessions, glance, skills | Session chat over pub/sub with control intents, share revocation event, glance state table, skills in DB and the PVC removed from the chart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | A                       |
| D     | Local relay              | §4, and the chart's replica validation lifted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | B, C1                   |
| E     | verification             | The manual pass on a real cluster (below) and the docs: `docs/reconciliation.md`, `docs/production-eks.md`, `CLAUDE.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | B, C1, C2 (D for Local) |

B, C1 and C2 touch different files and run in parallel.

## Testing

**Unit.** Lease CAS semantics; offset accounting at line boundaries; the
start / attach / deliver / kill script builders; the fake runtime's protocol.

**Integration (real Postgres + Redis).** Two concurrent claimers under the
advisory lock never overshoot a limit of N; two instances acquiring one lease;
`webhook_deliveries` claims; trigger `next_fire_at` CAS with two sweeps; the
unique partial indexes; attach CAS with two claimers.

**Pipeline e2e (`api-cluster.ts`, fake runtime).** Each case asserts the run's
final state, that its log rows are contiguous with no duplicates (a counter in
the fake agent's output), and that cost was added once.

1. One server; a Repo Task running; `SIGKILL` the server; start a new one → the run completes.
2. Two servers; a run started through A; A killed → B re-attaches within 10 s; the run completes.
3. Three servers; ten concurrent runs across kinds; one server killed → all complete; the global and per-repo limits are never exceeded (polled from the DB throughout).
4. Cancel sent to the instance that is **not** attached kills the agent.
5. A mid-run message sent to a non-attached instance reaches the agent (the fake echoes stdin).
6. A WS upgrade token minted on A is accepted by B.
7. The same webhook delivery posted to A and B fires once.
8. A schedule trigger due now with two servers sweeping fires once.
9. `SIGTERM` to the attached server: another picks the run up in under 5 s.
10. The pod goes away mid-run (fake `destroy`) → the run fails with the pod-death reason, not a silent hang.
11. Job runs and persistent-agent turns through cases 1, 4 and 5.
12. Boot with runs in flight fails nothing.

**Web e2e.** The existing suite, unchanged, must pass.

**Live (manual, before merging E).** A second Helm release in its own
namespace (`optio-scale`, bundled Postgres and Redis, its own NodePorts),
never the `optio` namespace in daily use. `api.replicas: 3`. Real Repo Tasks
with a real agent (one short LLM run each, as `/live-e2e` does):

- `kubectl delete pod` of the attached API pod mid-run → the run completes and opens its PR; the UI's log view shows no gap.
- Scale 1 → 3 → 1 while runs are in flight.
- Cancel and a mid-run message from the UI while attached elsewhere (the NodePort round-robins).
- A Job run and a persistent-agent turn through the same.
- Phase D: an isolated daemon (the probe recipe, never a live session) against the 3-replica release: spawn, input, resize, kill, dirs from a browser that lands on another pod.

## Decisions (to confirm with Jon)

- **State home.** Correctness state in Postgres, caches per instance, transport in Redis. Chosen for one transactional truth beside the run rows; Redis stays what it is today, a queue and a bus.
- **Attach replays derivations from byte 0** rather than persisting tracker state. Simpler and cannot drift; output is small.
- **Recreate stays.** Runs survive it now, so the only cost is seconds of API downtime per deploy; rolling updates would impose expand/contract migrations on every schema change.
- **Session chat turns** keep today's "interrupted on restart" behavior in this plan; moving them onto the run protocol is the obvious follow-up and the design covers it.
- **The relay is last** and gates the replica count; a single relay-role deployment was the alternative and was rejected because the chart would still have to explain two kinds of API pod.

## Out of scope

- Rolling updates and expand/contract migrations.
- Session-chat turns on the run protocol (follow-up).
- Local runs (Optio Local on a machine): the daemon already owns the process; the relay phase covers their viewers.
- Postgres as a bottleneck (log insert rate, snapshot queries); measure after this lands.
