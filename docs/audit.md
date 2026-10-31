# The audit trail

Who did what, from where: sign-ins and refused sign-ins, sign-outs, API
keys, tokens, workspace membership, merges, and settings
changes, next to everything else Optio already recorded in its action log
(tasks, repos, secrets, connections, …). Admins read it on the **Audit**
page, filter it, and export it as CSV or JSON lines; it is kept for a set
number of days and can be copied, entry by entry, to the API's log for a
SIEM.

The trail is Optio's action log (the table `optio_actions`). Each entry has:

| Field          | What it holds                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| time           | When it happened                                                                                                                                                             |
| actor          | The person (id, email, name); none for Optio itself (an automatic merge) and for a refused sign-in                                                                           |
| workspace      | The workspace it happened in; none for deployment-wide entries (refused sign-ins, sign-in settings, deployment admins, audit retention, an export of every workspace)        |
| action         | A dotted name, `<resource>.<verb>[.<detail>]`, e.g. `workspace.member.add` (the page shows a label, "Workspace member added")                                                |
| success        | Whether it went through; a refused or failed attempt is recorded too                                                                                                         |
| client address | The address the request came from, as the API sees it through the proxies it trusts (`OPTIO_TRUST_PROXY`, Helm `rateLimit.trustProxy`); see below for which entries carry it |
| details        | Ids, names and small values (below). Never a secret, a token, a password, a prompt or a request body                                                                         |

The client address is recorded on every action listed under "What is
recorded" below when a person's request makes it; the reconciler's
automatic merges and the `merge_pr` tool's entries have none. The rest of
upstream's action log (`task.*`, `repo.*`, `secret.*`, `model_provider.*`,
`connection.*`, …) is recorded without it, as are entries written before
this release.

Behind a proxy, set `OPTIO_TRUST_PROXY` (Helm
`rateLimit.trustProxy`) to the explicit trusted proxy IPs or CIDRs, separated
by commas: the ingress controller's own address as a `/32` (e.g.
`192.0.2.10/32`), or its load balancer's or the nodes' CIDR when it runs with
host networking. It is unset by default. A CIDR that also covers agent pods,
such as the cluster's pod CIDR (`10.42.0.0/16` on k3s), is equivalent to
`true`: any agent pod can reach the API and claim to be `127.0.0.1`, which
skips the per-IP and sign-in rate limits and puts that address in the audit
rows. `true`, numeric hop counts (`1`, `2`), the proxy-addr keywords
`uniquelocal` and `linklocal`, and CIDRs shorter than `/8` (IPv6 `/16`) are
ignored: the API trusts nobody, logs a warning at startup, and records every
client as the ingress controller's address. A value that is not an IP
address, a CIDR or `loopback` (say `ingress`) stops the API at startup with
an error naming it. Enabling ingress alone does not enable proxy trust. Only
trust proxies that overwrite forwarded headers from clients.

## What is recorded

| Area       | Actions                                                                                                                                  | Details                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Sign-in    | `auth.sign_in`, `auth.sign_in.failure`, `auth.sign_out`                                                                                  | The provider and `via`; for a refusal, the reason and email when available                   |
| API keys   | `api_key.create`, `api_key.delete`                                                                                                       | The key's id, name, `via` and expiry                                                         |
| Tokens     | `gateway.token.set` / `.delete`, `gitlab.token.set` / `.delete`, `github.token.*`, `agent.token.*`                                       | The secret's name and user/global scope; never the value                                     |
| Workspaces | `workspace.create`, `workspace.delete`, `workspace.settings`, `workspace.member.add`, `workspace.member.role`, `workspace.member.remove` | The target person, role and changed field names                                              |
| Merges     | `pr.merge`                                                                                                                               | `via`: `button`, `auto` or `mcp`; PR URL and merge method, with task id for automatic merges |
| Settings   | `audit.settings`, `audit.export`                                                                                                         | The retention days or export format                                                          |

Everything upstream's action log already recorded stays: `task.*`, `repo.*`,
`secret.*`, `connection.*`, `webhook.*`, `workflow.*`, `model_provider.*`,
`mcp.*` (the controller's tools), and so on.

- **Merges** from the Merge button (`via: button`), the reconciler
  (`via: auto`) and a person's agent through the controller's `merge_pr`
  (`via: mcp`) are recorded. A merge the git host refuses has
  `success: false` and the host's answer as its reason.
- **Refused OAuth sign-ins** record `domain_not_allowed`, `invalid_state`,
  `missing_params`, `provider_error` or `auth_failed`, as applicable.
- Automatic workspace joins at sign-in are not separate entries; the
  sign-in itself is recorded.

Features added by later splits can use the same audit helpers and action
catalog. Their event instrumentation is added with those features.

## Who reads it

| Who                 | Reads                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| A workspace admin   | Their workspace's entries                                                                        |
| A deployment admin  | Every workspace's, and the deployment-wide ones (no workspace); they may narrow to one workspace |
| Members and viewers | Nothing: the Audit page, its export and its settings answer 403                                  |

Members still have the **Activity** feed of their workspace, which leaves out
sign-ins, API keys, tokens, merges and the audit's
own entries (`auth.*`, `api_key.*`, `*.token.*`,
`pr.merge*`, `auto_merge.*`, `audit.*`) and never shows client addresses. Merge details are restricted to admins along with the other sensitive audit entries.

A workspace admin's Activity feed (and upstream's action list,
`GET /api/optio/actions`, which now follows the same rule) also shows
upstream's older entries that have no workspace, but never the
deployment-wide audit entries: refused sign-ins with the name tried, the
sign-ins of people in no workspace, sign-in settings, deployment admins,
the audit's own settings and database restores (`database.restored`, with the
dump's name). Those are for deployment admins only.

## The Audit page

**Your menu → Audit** (shown to workspace and deployment admins).

- **Filters**: a person (what they did, and what was done to them: their
  membership; click a name in the list to narrow to it), an
  action group (Sign-in, API keys, Tokens, Workspace members, Merges,
  Settings, Secrets, Database restores) and/or action names (`workspace.member, pr.merge`: a name
  matches itself and the actions under it),
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
its start for `from`, its end for `to`, UTC), `userId`, `action`
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
effect at the next sweep. This also prunes pre-existing `optio_actions` rows,
which were not previously subject to retention. Export any older history before
enabling this version. A one-day retention also removes its own settings-change
entry after one day; keep an external SIEM copy when that history is required. The prune is the only thing that deletes audit
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
  "details": { "provider": "google", "via": "cli" }
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
  action: "workspace.member.add",
  details: { targetUserId },
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
`1793059202_audit_trail.sql` (`optio_actions.client_ip`, an index, the
`audit_settings` row).
