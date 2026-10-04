# Organization and personal scope, and in-app Google SSO

Optio is about to be rolled out to an organization. Its people sign in with
Google, share the organization's agents, secrets, connections and model
providers, and keep their own personal ones that nobody else can see. Today the
building blocks are there — `owner_user_id` on work, connections and model
providers, `scope = "user"` on secrets, auto-join by email domain — but they
don't yet add up to that experience, and sign-in is configured only by
environment variables.

This plan has two halves that ship as separate PRs: **scope** (one visibility
rule, applied everywhere, with one UI pattern) and **sign-in** (an in-app
setup flow for the organization's Google SSO).

**Status (2026-10-03):** implemented — see [scope.md](../scope.md) and
[sign-in.md](../sign-in.md) for the shipped behavior; this document keeps the
reasoning and the decisions.

## Vocabulary

| Word             | Meaning                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| **Organization** | A resource the workspace shares. `owner_user_id IS NULL`. Everyone in the workspace sees it.                  |
| **Personal**     | A resource one person owns. `owner_user_id = <them>`. Only that person sees it, uses it, or changes it.       |
| **Mine**         | The viewer's personal resources (the filter / section label). Pickers say **Just me**, as they already do.    |
| Workspace        | Stays the tenant unit. The organization gets one; "Organization" in the UI means "this workspace's".          |
| Deployment admin | A new, instance-wide role for the people who may change how everyone signs in. Separate from workspace roles. |

The request used "global" for the personal level; this plan uses **personal**
because "global" already means _instance-wide_ in the secrets code
(`scope = "global"`, `workspace_id IS NULL`).

## Starting point

What exists, what's missing, and what's broken (verified in code):

| Resource                            | Owner column             | Who may create org / personal | List hides others' personal?                                                                                                                    | Notes                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets                             | `scope=user` + `user_id` | admin / member                | **No** — `GET /api/secrets` returns every row in the workspace, including other people's personal names, and misses instance-wide `global` rows | **Personal secrets can't be decrypted at run time**: the route stores them with the workspace in the AES-GCM AAD, every reader rebuilds the AAD without it (`routes/secrets.ts:205` vs `secret-service.ts:561`). They silently land in `missing`. |
| Connections                         | yes                      | admin / member                | Members yes, **admins see everyone's**                                                                                                          | `GET /api/repos/:id/connections` and the assignment routes ignore the owner.                                                                                                                                                                      |
| Model providers                     | yes                      | admin / member                | Members yes, admins see everyone's (name only)                                                                                                  | Fine otherwise.                                                                                                                                                                                                                                   |
| Work (tasks, scheduled Tasks, Jobs) | yes                      | member / member               | **No** — everyone sees everyone's                                                                                                               | `/api/tasks/:id/{cancel,retry,force-redo,run-now}` skip the owner check Job runs have.                                                                                                                                                            |
| Persistent agents                   | yes                      | member / member               | **No**                                                                                                                                          | Inter-agent `send` / `broadcast` can wake a personal agent.                                                                                                                                                                                       |
| MCP servers                         | **none**                 | admin only                    | n/a                                                                                                                                             |                                                                                                                                                                                                                                                   |
| Prompts                             | **none**                 | member                        | n/a                                                                                                                                             | `prompt_templates.name` is unique across the whole instance.                                                                                                                                                                                      |
| Skills                              | **none**                 | member                        | n/a                                                                                                                                             | `GET/PATCH/DELETE /:id` don't check the workspace.                                                                                                                                                                                                |
| Sign-in                             | —                        | —                             | —                                                                                                                                               | Env vars only. No domain restriction. Every new user becomes admin of a fresh workspace, and any workspace admin can write instance-wide secrets.                                                                                                 |

There is no shared "organization's or mine" predicate; each service re-types
it (five places), and the web app fetches `/api/auth/me` in seven components
with four different admin checks.

## The rule

One sentence, enforced in one place: **a personal resource is visible to and
usable by its owner alone; an organization resource is visible to everyone in
the workspace, changed by whoever the resource's role rule already allows.**

Consequences:

- Lists return `owner_user_id IS NULL OR owner_user_id = me` for members, and
  every row for workspace admins. Fetching someone else's personal resource by
  id is a 404 for a member (its existence is theirs) and a read-only row for an
  admin; changing, running or using it is a 403 for everyone but the owner.
- Workspace admins see everything **read-only**: others' personal items appear
  in their lists under **Other people's**, named with their owner, and open as
  read-only pages. Admins can't use, edit or run them (a personal item runs with
  its owner's credentials); they can delete them, for offboarding. Secret values
  are never shown to anyone, admins included.
- Personal work (a Job, a scheduled Task, a persistent agent, a Repo Task) is
  visible only to its owner and, read-only, to admins — in the Work list,
  Overview, Inbox, Activity, recent runs, and WebSocket updates. Cost analytics
  keep counting it in the workspace totals (numbers, not rows).
- A personal persistent agent accepts messages from its owner and from agents
  its owner owns. Organization agents talk to organization agents.
- A personal resource can only be picked by work the same person owns
  (already true for providers, secrets, connections; extends to MCP servers and
  prompts).
- Deleting a user cascades their personal connections and providers today but
  **orphans their work into the organization** (`on delete set null`). Change
  work to cascade too, so nothing silently starts running as the organization.

## UI / UX

### One scope switch on every list page

Every page that lists a scoped resource gets the same control, in the same
place (the page header, where the Work list's view switcher sits):

```
┌─────────────────────────────────────────────────────────────────┐
│ 🔑 Secrets                                   [ + New secret ]   │
│ 12 secrets · 8 organization · 4 mine                            │
│                                                                 │
│  ( All 12 ) ( Organization 8 ) ( Mine 4 )          [ search ]   │
│                                                                 │
│  ORGANIZATION                                                   │
│  ├ ANTHROPIC_API_KEY            all repos                       │
│  ├ SLACK_BOT_TOKEN              acme/app                        │
│  └ …                                                            │
│                                                                 │
│  MINE                                                           │
│  ├ MY_NOTION_TOKEN                                              │
│  └ …                                                            │
└─────────────────────────────────────────────────────────────────┘
```

- `Segmented` (the existing component) with counts: **All · Organization ·
  Mine**, plus **Other people's** for workspace admins. **All** is the default
  and is **sectioned** — one `Panel` per scope with the uppercase headers the
  Overview already uses — so every scope is visible at a glance without a chip
  on every row. The other segments are flat lists. The choice goes in the URL
  (`?owner=org|mine|others`) so links carry it.
- The segment you're on becomes the default owner of **+ New** (on Mine, the
  form opens on Just me; on Organization, on Organization, disabled with a
  reason for non-admins where the resource needs one). On All, the default is
  Organization for admins and Just me for everyone else.
- An empty Mine section says what personal means for that resource in one
  line ("Secrets only you can see and only your work can use.").

Shipped as `components/ui/owner-segments.tsx` (`OwnerSegments`) plus
`components/ui/scoped-list.tsx` (`ScopedList`: rows in, sectioned or flat
rendering out), used by Secrets, Connections, Model providers, MCP servers and
Prompts. The Secrets page's hand-rolled version is replaced.

### One chip

`OwnerChip` (`components/ui/owner-chip.tsx`): a small primary-tinted **Mine**
tag. Organization rows carry no chip (they're the norm). It appears only where
rows from both scopes mix without sections: search results, the Work list,
picker menus in the New work form, detail-page headers (replacing the ad-hoc
`RunsAsBadge`, whose "Runs as <name>" only ever shows the viewer's own name once
personal work is owner-only).

### Forms: one Owner row

The **Organization / Just me** `Segmented` the forms already use stays, with
one label everywhere — **Owner** — and one helper sentence per resource
("Just me: only you can see or use it. Organization: everyone in the
workspace."). The New work form's Owner row (today labeled "Runs as" and hidden
unless a personal provider or secret exists) is **always shown** for pod work
and keeps its current auto-switch: picking something personal flips the owner
to Just me with the note explaining why. Editing someone else's personal work
can no longer happen (it isn't visible), so the read-only banner goes.

### Work list

The Work list keeps its views (Active · Recurring · Agents · History). Since
personal work is now owner-only, every row you see is the organization's or
yours. Personal rows get the **Mine** chip, `WorkRow` gains `owner`, and the
toolbar gets a compact **Mine** toggle (`?owner=mine`) next to search. No second
segmented control.

### Navigation

- **Secrets moves into Library** (Prompts · Repos · Machines · Connections ·
  Secrets). Every member now has personal secrets to manage; it's no longer an
  admin page.
- The user menu's **Admin** section shows only for workspace admins (today
  everyone sees it), and gains **Sign-in** when the viewer is a deployment
  admin.
- One `useCurrentUser()` hook (`hooks/use-current-user.ts`, a small Zustand
  store filled once) exposing `userId`, `isAdmin`, `isDeploymentAdmin`,
  `authDisabled`, replacing the seven ad-hoc `/api/auth/me` fetches and their
  four disagreeing admin checks.

### Mobile

iOS and Android already have Secrets, Connections and Model providers screens
with a scope picker. The API change (others' personal items disappear) applies
to them at once; a follow-on pass gives them the same All / Organization / Mine
segments and the Mine chip, and regenerates the shared types.

## Sign-in: the organization's Google SSO, configured in the app

### What the admin experiences

**First install.** The deployer installs the chart with `publicUrl` set and no
OAuth provider. The chart prints how to read the one-time **setup token** from
the API's log. Opening the app shows the setup wizard, now starting with a
**Sign-in** step:

```
┌────────────────────────────────────────────────────────────────┐
│  Sign-in                                                       │
│  How your organization signs in to Optio.                      │
│                                                                │
│  Setup token      [ ••••••••••••••••••••••••••••••••••••• ]    │
│                   From the API log: kubectl logs … | grep …    │
│                                                                │
│  Google OAuth client                                           │
│   Redirect URI to register   https://optio.acme.com/api/auth/google/callback  [copy] │
│   Client ID        [ 1234-abc.apps.googleusercontent.com ]     │
│   Client secret    [ ••••••••••••••• ]                         │
│                                                                │
│  Who may sign in                                               │
│   (•) Only people from these Google Workspace domains          │
│       [ acme.com ]                                             │
│   ( ) Anyone with a Google account                             │
│                                                                │
│  Organization                                                  │
│   Name  [ Acme ]       People from acme.com join it as members. │
│                                                                │
│                              [ Save and sign in with Google ]  │
└────────────────────────────────────────────────────────────────┘
```

Saving stores the client, the allowed domains and the organization name, then
starts the Google sign-in. The first person through becomes the **deployment
admin** and an admin of the organization workspace (the "Default" workspace is
renamed and gets the auto-join domains). Everyone else from `acme.com` who
signs in lands in that workspace as a member. The setup token stops working the
moment a deployment admin exists.

**Afterwards.** Settings → Access → **Sign-in** becomes an editable card for
deployment admins: the same fields, a test button, **Deployment admins** (add /
remove by email), and the other providers shown read-only as "set by the
environment". Non-deployment-admins see the status only.

### How it works

- **Storage**: a new table `auth_provider_configs` (`provider` pk, `client_id`,
  encrypted `client_secret` with iv / tag and AAD `auth_provider|<provider>`
  — the model-provider credential pattern — `allowed_domains` jsonb,
  `display_name`, `enabled`, `updated_by`, `updated_at`). Not the `secrets`
  table: global secrets reach repo pods and are writable by any workspace
  admin.
- **Precedence**: DB config over env, per provider. `getEnabledProviders`
  becomes async and reads the DB (logins are rare; no cache to invalidate
  across replicas). Google's provider class takes its config from a lookup
  instead of `process.env` getters. Only Google is editable in-app in this
  pass; GitHub, GitLab and OIDC keep their env path, and the table is
  provider-generic so they can follow.
- **Domain enforcement**: `OAuthUser` gains `hostedDomain` (Google userinfo's
  `hd`). After `fetchUser`, the callback rejects a sign-in whose `hd` _and_
  verified-email domain aren't allowed (`/login?error=domain_not_allowed`), and
  the authorize URL passes `hd=` when exactly one domain is allowed (a hint
  only). The CLI's PKCE login shares the callback, so it's covered.
- **Deployment admin**: `users.deployment_admin boolean not null default false`;
  `requireDeploymentAdmin` preHandler for `/api/auth/config/*` and
  `/api/auth/deployment-admins`. Recovery hatch: `OPTIO_DEPLOYMENT_ADMINS`
  (emails) grants it at sign-in.
- **Bootstrap mode**: auth enabled, no provider enabled anywhere, no deployment
  admin yet. `GET /api/auth/providers` adds `setupRequired: true`; the web
  login page sends people to `/setup`; `PUT /api/auth/config/google` accepts
  `X-Optio-Setup-Token` equal to `OPTIO_SETUP_TOKEN` (chart value
  `auth.setupToken`; when unset the API generates one at boot and logs it;
  `NOTES.txt` prints the `kubectl logs` command). The response to
  `/api/auth/providers` stays additive — web, CLI, iOS and Android all read it.
- **Helm**: `optio.validateRequired` keeps requiring `publicUrl` but no longer
  requires a provider; a checksum annotation on the API deployment so changed
  auth values roll the pods.
- **Also fixed on the way**: the CLI's `optio login` without `--provider`
  sends a `{name, displayName}` object where the API wants a string.

## Backend work

### Phase 0 — fixes that block the rollout (own PR, first)

1. Personal secrets: store with `workspace_id NULL` (AAD `name|user|global`,
   matching every reader) and migrate existing `scope='user'` rows by
   re-encrypting. Integration test that a personal secret stored through the
   route is resolved by `resolvePodSecrets`.
2. `GET /api/secrets`: one query — `(scope <> 'user' AND (workspace_id = ws OR
workspace_id IS NULL)) OR (scope = 'user' AND user_id = me)` — no more
   leaked names, no more missing globals, no duplicates. Delete of a global
   secret stops passing the workspace.
3. `/api/tasks/:id/{cancel,retry,force-redo,run-now}` go through
   `workChangeError(…, "run")` like Job runs do.

### Phase 1 — one predicate, applied everywhere

- `services/ownership.ts`: `visibleTo(actor)` → Drizzle `SQL` for a table's
  `ownerUserId` column, `assertVisible(row, actor)` → 404, and `workActor`
  moved here (absorbing `providerViewer`).
- Connections: list, get, `/api/repos/:id/connections`, assignments, `/test`.
  Model providers: drop the admin exception. Persistent agents: list, get,
  messages, turns, stats, internal `send` / `broadcast` (same-owner rule).
  Work: `listWork`, `resolveWork`, `/api/tasks*`, `/api/jobs*`,
  `/api/task-configs*`, recent runs, Overview, Inbox, Activity. WebSocket
  fan-out: task / run / agent updates carry `ownerUserId`; the server drops
  personal updates for other viewers.
- `WorkRow.owner: "organization" | "mine"`; `/api/work` projects it.
- `tasks.owner_user_id`, `work_definitions.owner_user_id`,
  `persistent_agents.owner_user_id` → `on delete cascade`.

### Phase 2 — new owners

- `mcp_servers.owner_user_id`, `prompt_templates.owner_user_id` (and
  `prompt_templates.name` unique per `(workspace_id, owner_user_id, name)`),
  `installed_skills.owner_user_id`, `custom_skills.owner_user_id`: all
  nullable, all through the same predicate, all pickable only by work of the
  same owner (`buildAgentEnvironment`). Members may create personal MCP
  servers and skills; organization MCP servers stay admin-only. The skills
  `/:id` routes get their missing workspace check.

### Phase 3 — web UI (as described above)

### Phase 4 — sign-in (own PR)

### Phase 5 — mobile parity, docs

`docs/model-providers.md` "Owners" section moves to a `docs/scope.md` that
states the rule; `CLAUDE.md` gets a paragraph; the site docs gain "Google
Workspace SSO" with the Cloud Console steps.

## Testing

| Tier         | What                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit         | `visibleTo` / `OwnerSegments` / `ScopedList` / the `hd` + domain decision / setup-token gate.                                                                                                                                                                                                                                                     |
| Integration  | Two users in one workspace: each resource type lists org + own only, 404 on the other's id, admin sees personal rows but gets 403 changing them, personal secret round-trips through the route, cascade on user delete, `auth_provider_configs` seal / open, DB-over-env provider precedence, bootstrap mode ends when a deployment admin exists. |
| Pipeline e2e | A personal Job with a personal secret runs and the secret reaches the pod; a second user can't start it (403) or see it (404).                                                                                                                                                                                                                    |
| Web e2e      | Each list page: segments, counts, sectioned All, `?owner=` round-trip, New defaults; the Sign-in wizard step renders in bootstrap mode (fake Google).                                                                                                                                                                                             |
| Live         | Deploy to the local cluster; sign-in configured through the wizard against a real Google OAuth client; one personal and one organization Job.                                                                                                                                                                                                     |

## Decisions (confirmed 2026-10-03)

1. **Admins see others' personal items read-only** (an "Other people's"
   section / segment; delete allowed for offboarding, use / edit / run never).
2. **Personal work becomes owner-only visible** to members (today everyone
   sees it).
3. **Scope reaches MCP servers, Prompts and Skills** in this pass.
4. **Sign-in is configured in-app with a setup token**, with env vars as the
   alternative.
5. **The All view is sectioned** rather than a flat list with chips.

## Out of scope

Invites by email (members must have signed in once; auto-join covers the
rollout), SCIM / group sync, per-team scopes between organization and
personal, SSO for GitHub / GitLab / OIDC configured in-app, instance-wide
secrets being writable by any workspace admin (noted; a deployment-admin gate
on `scope = "global"` writes is a natural follow-up).
