# The audit trail

Who did what, from where: sign-ins and refused sign-ins, sign-outs, API
keys, tokens, team and workspace membership, every merge, and settings
changes, next to everything else Optio already recorded in its action log
(tasks, repos, secrets, connections, …). Admins read it on the **Audit**
page, filter it, and export it as CSV or JSON lines; it is kept for a set
number of days and can be copied, entry by entry, to the API's log for a
SIEM.

The trail is Optio's action log (the table `optio_actions`). Each entry has:

| Field          | What it holds                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| time           | When it happened                                                                                                                                                                 |
| actor          | The person (id, email, name); none for Optio itself (an automatic merge) and for a refused sign-in                                                                               |
| workspace      | The workspace it happened in; none for deployment-wide entries (refused sign-ins, sign-in settings, deployment admins, audit retention, an export of every workspace, a restore) |
| action         | A dotted name, `<resource>.<verb>[.<detail>]`, e.g. `team.join.approve` (the page shows a label, "Join request approved")                                                        |
| success        | Whether it went through; a refused or failed attempt is recorded too                                                                                                             |
| client address | The address the request came from, as the API sees it through the proxies it trusts (`OPTIO_TRUST_PROXY`, Helm `rateLimit.trustProxy`); see below for which entries carry it     |
| details        | Ids, names and small values (below). Never a secret, a token, a password, a prompt or a request body                                                                             |

The client address is recorded on every action listed under "What is
recorded" below when a person's request makes it; the reconciler's
automatic merges and the `merge_pr` tool's entries have none. The rest of
upstream's action log (`task.*`, `repo.*`, `secret.*`, `model_provider.*`,
`connection.*`, …) is recorded without it, as are entries written before
this release.

## What is recorded

| Area         | Actions                                                                                                                                                                                                                                                            | Details                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in      | `auth.sign_in`, `auth.sign_in.failure`, `auth.sign_out`                                                                                                                                                                                                            | `provider` (`oidc`, `ldap`), `via` (`web`, `cli`); for a refusal the `reason` and the `username` (LDAP) or `email` it was tried with                                                                                                                                                                                                                                               |
| API keys     | `api_key.create`, `api_key.delete`                                                                                                                                                                                                                                 | The key's `id` and `name`, `via` (`settings`, `cli`), `expiresAt`                                                                                                                                                                                                                                                                                                                  |
| Tokens       | `gateway.token.set` / `.delete`, `gitlab.token.set` / `.delete`, `github.token.*`, `agent.token.*` (an agent's own `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`; with `OPTIO_MODEL_ACCESS=gateway` these count as `gateway.token.*`)                                    | The secret's `name`, `scope` (`user`, `team`, `global`) and `teamId`; `targetUserId` when an admin removes someone else's personal token (offboarding); never the value                                                                                                                                                                                                            |
| Gateway keys | `gateway_key.issue`, `gateway_key.rotate`, `gateway_key.revoke`, `team_key.create`, `budget.set`, `model_provider.key_issuing` (keys Optio makes on the gateway, [model-gateway.md](model-gateway.md#keys-optio-makes))                                            | The gateway's `id`, `scope` (`user`, `team` with `teamId`), the key's `keyAlias`, `maxBudget` (USD) and `budgetDuration`; for a revoke its `reason` and, when Optio or an admin revoked someone else's, `targetUserId`; `fields` changed for `model_provider.key_issuing` (names only: a new admin key shows as `adminKey`). Never a key                                           |
| Teams        | `team.create`, `team.update`, `team.delete`, `team.groups`, `team.join` (an open team), `team.join.request`, `team.join.approve`, `team.join.deny`, `team.leave`, `team.member.add`, `team.member.role`, `team.member.remove`                                      | `teamId`, `targetUserId` (whose membership), `role`; `fields` changed (names only) for `team.update`                                                                                                                                                                                                                                                                               |
| Workspaces   | `workspace.create`, `workspace.delete`, `workspace.settings`, `workspace.default_gateway`, `workspace.member.add`, `workspace.member.role`, `workspace.member.remove`, `workspace.member.join` (by a directory group)                                              | `targetUserId`, `role`; `fields` changed (names only) for `workspace.settings`                                                                                                                                                                                                                                                                                                     |
| Merges       | `pr.merge`, `pr.merge.refused`, `auto_merge.confirm`, `auto_merge.off`                                                                                                                                                                                             | `via`: `button` (the Merge button), `auto` (the reconciler), `mcp` (the `merge_pr` tool); `prUrl`, `mergeMethod`; an automatic merge also has `taskId`, `confirmedBy` and `confirmedAt` (who accepted the "merge automatically" dialog, and when); a refused merge its `reason`. `auto_merge.*` names the repo, task, scheduled Task or work (`type`, `id`)                        |
| Settings     | `sign_in.provider_saved`, `sign_in.provider_deleted`, `sign_in.deployment_admin_added`, `sign_in.deployment_admin_removed`, `sign_in.deployment_admin_claimed`, `settings.update`, `audit.settings`, `audit.export`                                                | The provider; the person; the retention days; the export's format                                                                                                                                                                                                                                                                                                                  |
| Accounts     | `user.disabled`, `user.enabled`, `directory.sync`, `directory.settings`                                                                                                                                                                                            | `targetUserId`, `email`, `reason` (`gone`, `disabled_in_directory`, `not_in_required_group`, `domain_not_allowed`, `admin`), `via` (`directory`, `admin`, `sign_in`), `count` (automations paused or resumed there); a sync run's `trigger`, `status` and counts; the settings' `fields`. See [directory-sync.md](directory-sync.md)                                               |
| GitLab bot   | `gitlab_mention.start`, `gitlab_mention.resume`, `gitlab_mention.refuse`, `gitlab_bot.settings` (@-mentions in GitLab comments, [gitlab-bot.md](gitlab-bot.md))                                                                                                    | The commenter's GitLab `username` (the entry's person is their Optio account when found), `commentUrl`, the repo, `kind` (`work`, `fix_pipeline`, `empty`, `help`), the run's `taskId` (`teamId` for a team's); a refusal's `reason` (`no_account`, `viewer`, `gitlab_access`, `no_token`, …); the settings' `fields`                                                              |
| Agent policy | `agent_policy.update` (the workspace's, a team's or a repo's, [agent-policy.md](agent-policy.md))                                                                                                                                                                  | `level` (`workspace`, `team` with `teamId`, `repo` with `repoId`), the deny rules `added` and `removed`, and `defaults` / `runtimeClassName` when they changed                                                                                                                                                                                                                     |
| Database     | `database.restored`: a restore from a dump ([backup.md](backup.md))                                                                                                                                                                                                | The `dump` restored; `keptAs`, where the database as it was is kept. Deployment-wide, by Optio                                                                                                                                                                                                                                                                                     |
| Integrations | `remote_workspace_connection.create`, `remote_workspace_connection.update`, `remote_workspace_connection.delete` (earlier entries: `coder_connection.*`), `ticket_provider.create`, `ticket_provider.delete`, `ticket_provider.enable` (re-enabled after failures) | The connection's or provider's `id`, the connection's `name` and `provider` (`coder`, `codespaces`, `daytona`, `e2b`), the ticket provider's `type` (`jira`, …); whose it is (`scope`: `workspace`, `team` with `teamId`, `user` with `targetUserId` when that isn't the person acting); for a change, the `fields` sent (names only: a new token shows as `token`). Never a token |

Everything upstream's action log already recorded stays: `task.*`, `repo.*`,
`secret.*`, `connection.*`, `webhook.*`, `workflow.*`, `model_provider.*`,
`mcp.*` (the controller's tools), and so on.

- **Every merge**, whoever makes it: the Merge button (`via: button`), the
  reconciler merging by itself after someone confirmed automatic merging
  (`via: auto`, with that person and time), and a person's own agent through
  the controller's `merge_pr` (`via: mcp`). A `merge_pr` from an agent run is
  refused (the merge guard, `services/auto-merge-guard.ts`) and recorded as
  `pr.merge.refused`. A merge the git host refused is a `pr.merge` with
  `success: false` and the host's answer as its `reason`.
- **Refused sign-ins** are recorded with why: `invalid_credentials`,
  `user_not_found`, `connection` and `config` (LDAP: wrong password, no such
  user, the directory unreachable or misconfigured), `group_not_allowed`,
  `domain_not_allowed`, `unverified_email` (the access rules), and for OIDC
  `invalid_state`, `missing_params`, `provider_error` (the identity
  provider's own error) and `auth_failed`; `account_disabled` for an
  account Optio disabled.
- **Disabled accounts**: the directory sync (people who sign in with LDAP)
  or a deployment admin disables someone who left; `user.disabled` goes to
  each of their workspaces, `user.enabled` when they come back, and every
  sync run is a deployment-wide `directory.sync`
  ([directory-sync.md](directory-sync.md)).
- Not recorded as separate entries: the automatic joins at sign-in (by email
  domain, directory groups and SSO group → team mappings; the sign-in itself
  is), and the short-lived tokens Optio makes for itself (remote-workspace pairing, run
  credentials).

## Who reads it

| Who                 | Reads                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| A workspace admin   | Their workspace's entries                                                                        |
| A deployment admin  | Every workspace's, and the deployment-wide ones (no workspace); they may narrow to one workspace |
| Members and viewers | Nothing: the Audit page, its export and its settings answer 403                                  |

Members still have the **Activity** feed of their workspace, which leaves out
sign-ins, API keys, tokens, gateway keys and budgets, merges and the audit's
own entries (`auth.*`, `api_key.*`, `*.token.*`, `gateway_key.*`,
`team_key.*`, `budget.*`, `pr.merge*`, `auto_merge.*`, `audit.*`,
`gitlab_mention.*`) and never shows client addresses. Merges and GitLab
comments are left out because their entries name merge requests and runs
that the workspace's work-visibility rule may hide from a member.

A workspace admin's Activity feed (and upstream's action list,
`GET /api/optio/actions`, which now follows the same rule) also shows
upstream's older entries that have no workspace, but never the
deployment-wide audit entries: refused sign-ins with the name tried, the
sign-ins of people in no workspace, sign-in settings, deployment admins and
the audit's own settings. Those are for deployment admins only.

## The Audit page

**Your menu → Audit** (shown to workspace and deployment admins).

- **Filters**: a person (what they did, and what was done to them: their
  membership, an automatic merge they confirmed; click a name in the list to
  narrow to it), a team (its members' entries and entries naming it), an
  action group (Sign-in, API keys, Tokens, Teams, Workspace members, Merges,
  Settings, Secrets) and/or action names (`team.join, pr.merge`: a name
  matches itself and the actions under it, `team` matches `team.join.approve`),
  dates (from / to, whole days in UTC), and the outcome. Deployment admins
  also pick **All workspaces** or **This workspace**.
- **CSV** and **JSON lines** download every entry the filters match (not just
  the page shown).
- **Audit trail** at the bottom: how long entries are kept and where that
  comes from, and whether they also go to the API's log. A deployment admin
  changes the days there. The same card is under **Settings → Access**.

## Export

```bash
curl -fsS -H "Authorization: Bearer $OPTIO_PAT" \
  "https://optio.example.com/api/audit/export?format=jsonl&from=2026-10-01&to=2026-10-31&action=auth,pr.merge" \
  > audit-october.jsonl
```

`GET /api/audit/export` (also served as `/api/activity/export`) takes the
page's filters as query parameters — `from`, `to` (an ISO time, or a date:
its start for `from`, its end for `to`, UTC), `userId`, `teamId`, `action`
(comma-separated), `outcome` (`success` / `failure`), and for deployment
admins `workspace` (`all`, the default; `current`; or a workspace id) — and
`format`:

- `csv`: the columns `time, workspace_id, workspace, actor_id, actor_email,
actor_name, action, label, success, client_ip, details` (details as JSON).
  A cell that starts with `=`, `+`, `-` or `@` gets a leading `'`, so a
  spreadsheet never runs it as a formula.
- `jsonl`: one JSON object per line, `{ id, time, workspaceId,
workspaceName, actor: { id, email, name } | null, action, label, success,
clientIp, details }`.
- `json`: the same objects in one array.

The export has no size limit (it reads the trail in batches) and is itself
recorded (`audit.export`). `GET /api/audit` returns the same objects a page
at a time (`limit` up to 500, `offset`) with the `total`.

## Retention

Entries are kept for **365 days** unless the deployment says otherwise:

1. a deployment admin's setting on the Audit page (or
   `PUT /api/audit/settings { "retentionDays": 730 }`; `null` goes back to
   the deployment's), else
2. `OPTIO_AUDIT_RETENTION_DAYS` (Helm `audit.retentionDays`), else
3. 365.

Whole days, 1 to 36500. The housekeeping sweep (every 30 seconds, on one API
replica) deletes entries older than that, 5000 at a time, and once a pass
finds nothing more to delete it rests for a day. A shorter retention takes
effect at the next sweep. The prune is the only thing that deletes audit
entries; task logs and other records follow their own rules, so the trail
can outlive the runs it names.

## A copy for your SIEM

With `OPTIO_AUDIT_STDOUT=json` (Helm `audit.stdout: json`), every entry the
action log writes is also printed to the API container's stdout as one JSON
line, which the cluster's log collector ships like any container log:

```json
{
  "type": "optio.audit",
  "version": 1,
  "time": "2026-10-24T09:12:03.120Z",
  "id": "7c1e…",
  "action": "auth.sign_in",
  "success": true,
  "workspaceId": "0b9d…",
  "actor": { "id": "5f2a…", "email": "carol@example.com", "name": "Carol" },
  "clientIp": "10.20.30.40",
  "details": { "provider": "ldap", "via": "cli" }
}
```

Route the lines whose `type` is `optio.audit` to the SIEM; the API's own
log lines (pino JSON, with `level` and `msg`) go on as before. The copy is
printed after the entry is stored, so the database stays the record of
truth; retention applies only to the database.

## For developers: recording an action

Fork code and later packages record through one function,
`auditEvent` in `apps/api/src/services/audit.ts`:

```ts
import { auditEvent } from "../services/audit.js";

// In a route, after the action succeeded (or failed: success: false).
void auditEvent({
  req, // actor, workspace and client address
  action: "team.join.approve",
  details: { teamId, targetUserId },
});

// Without a request (a worker): name the actor (or null for Optio) and the workspace.
void auditEvent({ action: "pr.merge", userId: null, workspaceId, details: { via: "auto" } });
```

- It never throws and never delays the action; don't `await` it in a route.
- `details` keys must be on the action log's allowlist
  (`ACTION_PARAM_ALLOWLIST` in `services/optio-action-service.ts`; the
  audit's own keys are in `services/audit-params.ts`). Anything else is
  dropped when written. Add a key there only for ids, names and small
  values, never for anything secret.
- Name a new action in `AUDIT_ACTION_LABELS` (and a group in
  `AUDIT_ACTION_GROUPS` if it needs a filter of its own) in
  `packages/shared/src/audit/actions.ts`, so the page shows a label.
- An action only admins should see goes under one of
  `ADMIN_ONLY_ACTION_PREFIXES` (`services/audit.ts`), which the members'
  Activity feed leaves out.
- A deployment-wide action (one about the whole deployment, not a
  workspace) is written with `workspaceId: null`, and its prefix belongs in
  `DEPLOYMENT_WIDE_ACTION_PREFIXES` (the admin-only ones and `sign_in`), so
  only deployment admins read it outside the Audit page too
  (`services/audit-visibility.ts`).
- Helpers for the common shapes: `auditSignIn`, `auditSignInFailure`,
  `auditPersonEvent` (a person, before anyone is signed in),
  `auditTokenSecret` (a secret that is a token), `auditAutoMergeSetting`,
  `auditAutoMerge`.

Upstream's `logAction` still works and lands in the same trail (with the
client address when given `clientIp`); use `auditEvent` in new code.

The code: `services/audit.ts` (writing), `services/audit-query.ts` (reading,
CSV / JSON lines), `services/audit-retention.ts` (retention, the prune),
`services/audit-stdout.ts` (the SIEM copy), `routes/audit.ts` (the API),
`apps/web/src/components/audit/` (the page), migration
`1792710000_audit_trail.sql` (`optio_actions.client_ip`, an index, the
`audit_settings` row).
