# Usage and budgets

**Insights → Usage** (`/usage`; `/costs` redirects here) shows recorded tokens,
reported costs and API-equivalent estimates for the selected workspace. The
leaderboard combines **People** and **Organization work**, with separate filters.
It measures activity, not individual performance.

Private work is attributed to its owner. Organization-owned work is attributed to
the work itself, regardless of who created it. A recurring definition combines
its runs; a persistent agent combines its turns; a parent task includes its
subtasks. Unlinked Local sessions and pod chat turns belong to their user.
Members see aggregate rankings; private run titles and links are visible only to
their owner and workspace admins. Every query remains workspace-scoped.

Tokens include input (including cache reads/writes) plus output. The cached-input
tile is a subset, not an additional charge. Unknown costs stay unknown. Estimates
are identified separately and are not an invoice, especially for subscription
accounts. Counts represent distinct runs observed in the period, so a run that
spans days can appear in more than one period. A completion is counted in the
period when the terminal outcome was recorded.

## Teams

The **Teams** panel under the leaderboard sums the same ledger by the
team that owns the work: a team's Tasks, Job runs and persistent-agent turns
are charged to the team, whoever started them (the ledger itself still names
the person). Each team shows its tokens, recorded cost and runs over the
period, and — when Optio made the team's gateway key — the team's gateway
budget and what it has spent (read live from the gateway where it reports
spend, else as Optio last saw it;
[model-gateway.md](model-gateway.md#keys-optio-makes)). The gateway refuses
the team's model calls once that budget is spent; the monthly budgets below
are Optio's own admission control and are separate.

A workspace admin sees every team of the workspace, anyone else the teams
they are an active member of: a team's work is its members' to see in both
work-visibility modes (docs/teams.md "Who sees whose work").
`GET /api/usage/teams?days=` (1–365, default 30; members and admins) answers
`{ start, end, teams: [{ teamId, name, tokens, costUsd, runs, gatewayBudget }] }`
(`services/team-usage-service.ts`).

## Accounting

`usage_ledger` records positive deltas in the same Postgres transaction as each
source's counters. Database triggers cover Repo Tasks, Job runs, PR-review runs,
persistent-agent turns, Local terminals and pod chat turns. Linked Local
terminals are counted through their Task or Job run, not twice. Local runs sum
all their terminal attempts; repeated, older and regressing daemon snapshots
cannot lower stored totals. Pod attempts add exact numeric costs in SQL.

The ledger retains attribution, model and work names when the source disappears.
Deleting a run does not erase recorded usage. Historical totals are backfilled
once, dated by completion or last update and marked **historical**. Their original
daily timing and any previously unrecorded tokens cannot be reconstructed. Model
attribution follows the model reported when a delta is observed; this is not a
per-request model trace.

`GET /api/analytics/usage` supports period, kind, rank metric, search, model,
repository and subject filters. Leaderboards are paginated in groups of 25;
subject activity shows the latest 50 visible runs. The legacy
`GET /api/analytics/costs` contract remains available for native clients.

## Budgets

Workspace admins can set one monthly budget per organization, person or shared
work. Select a leaderboard row to set its budget. Either a token or dollar limit
can be used, or both. Limits reset at midnight UTC on the first of the month.

- **Show an alert in Usage**: highlights the budget in the dashboard; does not
  send email or push notifications.
- **Pause new work**: holds queued Task and Job attempts, persistent-agent turns
  and PR-review runs before execution. Queued pod work rechecks each minute and
  continues after the budget is raised, removed or reset. New pod chat turns are
  refused with the budget reason. A Local session that reaches admission while
  blocked reports an error and can be restarted after the budget is raised.

Admission uses recorded usage, including estimates. Work already executing is
allowed to finish, and several concurrent runs may report after the limit has
been reached. Unknown prices count toward token limits only. These are admission
controls, not guaranteed provider billing ceilings. Existing Job per-run budgets
also prevent a subsequent attempt once its recorded cost reaches the limit.
Shells and agents running independently of Optio are outside these controls.
