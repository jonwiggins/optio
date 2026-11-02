# Pausing all agent work

A deployment admin can pause all agent work in the deployment with one switch,
or stop everything at once. Both are off unless someone uses them: nothing
changes for a deployment that never does.

Find them in **Settings → Access → Agent work** (deployment admins only). Both
ask for a reason. Everyone signed in then sees a banner on every page:
"Agent work is paused by an administrator: _reason_".

## What a pause does

While paused, no new agent work starts in any workspace:

| Work                                                        | While paused                                                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Queued Tasks, Job runs, persistent-agent turns, PR reviews  | Held in the queue with the reason as their message, at the same admission check as usage budgets. Retries and resumes wait too.    |
| Scheduled work (schedule triggers)                          | Not fired. Each due schedule fires **once** when the pause lifts, not once per missed tick.                                        |
| Triggered work (webhooks, tickets, events)                  | Received and saved as before (a webhook answers `202 {queued: true}`), then held until the pause lifts. Nothing is lost.           |
| Session messages                                            | Queued in the session and sent when the pause lifts. A session without a message queue refuses them with the reason.               |
| Interactive starts (new task, retry, run now, new session…) | Refused with `409` and the reason. The list is `START_ROUTES` in `apps/api/src/services/agent-work-pause.ts`.                      |
| Optio Local agent terminals                                 | A terminal that reaches its start while paused ends with the reason, as with a usage budget. Start it again after the pause lifts. |
| Work already running                                        | Carries on. Use **Stop everything** to cancel it.                                                                                  |

A task that was already setting up its pod when the pause began doesn't start
its agent: it goes back to the queue and is held with the rest.

Lifting the pause (**Resume agent work**) wakes held work at once instead of at
its next one-minute check, delivers the held trigger occurrences, and lets the
schedule sweep fire due schedules on its next pass. Work still over a usage
budget stays held by the budget.

The pause is one row in `deployment_settings` (`agentWork.paused`), read on
every check without a cache, so it holds on every API and worker replica at once
and survives restarts.

## Stop everything

**Stop everything** pauses, then cancels every queued and running agent run in
every workspace, each through its own cancel path, so its state, pod and slot
are cleaned up as a person's cancel would:

- Tasks waiting on dependencies, queued or running are cancelled (a running
  agent is signalled to stop; its worktree is kept). A task caught setting up
  its pod is cancelled before its agent starts.
- Job runs are cancelled.
- PR reviews with a run queued, setting up or running are cancelled.
- Persistent agents with a turn queued or running are paused, and their agent
  is signalled to stop. Their owners resume them when ready.
- Interactive sessions are ended, which interrupts their turn and removes the
  pod.
- Optio Local agent terminals are killed.

Cancelled work stays cancelled when the pause lifts; start it again as usual.
Stop everything leaves the pause on. Resume when you are ready.

## Who can do it, and the record

Only a deployment admin (Settings → Access → Sign-in) pauses, resumes or stops.
Workspace admins and members get `403`. Each action is written to the action log
with who did it and the reason: `agent_work.pause`, `agent_work.resume` and
`agent_work.stop` (with the number of runs cancelled of each kind).

## API

| Method and path             | Who               | Body                                                            |
| --------------------------- | ----------------- | --------------------------------------------------------------- |
| `GET /api/agent-work/pause` | anyone signed in  |                                                                 |
| `PUT /api/agent-work/pause` | deployment admins | `{ "paused": true, "reason": "..." }`, or `{ "paused": false }` |
| `POST /api/agent-work/stop` | deployment admins | `{ "reason": "..." }`                                           |

The reason is required (up to 500 characters).

## During an incident

An agent misbehaves, or a credential leaks:

1. **Stop everything** with a short reason ("Investigating a leaked token").
   Nothing new starts, and running agents are stopped in every workspace.
2. Rotate what needs rotating and review the action log and the cancelled runs.
3. **Resume agent work**. Held scheduled and triggered work starts; cancelled
   runs are started again by their owners.

## During an upgrade

1. **Pause agent work** ("Upgrading Optio") a while before the upgrade, and let
   running work finish (watch the Overview or the Tasks list), or **Stop
   everything** if it can't wait.
2. Upgrade (Helm, Zarf). The pause is in the database, so the new API and
   workers come up paused.
3. Check the deployment, then **Resume agent work**.
