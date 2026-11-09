# Run log retention

By default Optio keeps everything a run leaves behind until someone deletes
the run: its logs, the transcript of an interactive session, the prompt it was
given and the result it produced. A deployment that has to follow a records
policy (for example "logs for 90 days") can set a retention instead, and Optio
deletes that data on its own once the work is old enough.

## Turning it on

Set the number of days in the Helm chart:

```yaml
retention:
  runLogsDays: 90
```

or, without the chart, the API's environment:

```
OPTIO_RUN_LOG_RETENTION_DAYS=90
```

`0`, empty or unset keeps everything (the default). The value is whole days
from 1 to 36500; anything else is logged as a warning and keeps everything.
Deployment admins see the setting on **Settings → Access → Run retention**
(read-only: the deployment owns it). A new value applies once the API restarts
with it.

## What is deleted

For work that **finished** more than N days ago:

| Kind of work            | Deleted rows                                         | Cleared text (the row stays)                               |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| Repo tasks and Job runs | log lines, messages sent to the task                 | prompt, result summary, error, review comments, Job output |
| PR review runs          | log lines; the review's chat once the review settled | prompt, result summary, error                              |
| Persistent agent turns  | log lines; inbox messages the turn processed         | prompt, wake payload, summary, error                       |
| Interactive sessions    | chat events                                          | first prompt, each turn's prompt                           |
| Optio Local terminals   | transcript, final screen                             | output preview                                             |

"Finished" means a terminal state (completed, failed or cancelled; an ended
session; an exited terminal; a settled review) with its end time older than
the cutoff, and no agent still recorded as running. Queued, running and
waiting work, a run whose pull request is still open (it is still watched and
may be resumed), active sessions and open reviews are never touched, however
old.

What stays: the run rows themselves (title, state, times, the PR it opened),
their cost and token counts, the state history, and the audit trail. They say
what ran and what it cost, not what it read or printed. The audit trail has
its own retention.

A task whose prompt was removed can't be retried or force-redone (the API
answers 409); create a new task instead. A Job run can still be retried: it
renders its prompt from the Job again.

## How it runs

The housekeeping tick (every 30 seconds, on one API replica at a time) runs
the retention step. Each step deletes or clears at most 1000 rows per kind of
data, so locks stay short and a large backlog drains over a few ticks without
slowing the API. Once a pass finds nothing left it rests for an hour. The
code is `apps/api/src/services/run-retention.ts`.

Deleted rows are gone from the database; backups taken before keep them until
the backups themselves expire (see [backup.md](backup.md)).
