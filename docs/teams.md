# Teams

A **team** is a group of people inside a workspace that owns things together:
a third scope next to the **organization** and one **person**
(`docs/scope.md`). What a team owns, its members see and use; its admins
change it. People create teams and ask to join; the identity provider's groups
can fill them. Code: `apps/api/src/services/team-service.ts` (teams, joining,
members, group sync), `services/ownership.ts` (the scope rule),
`routes/teams.ts`, the shapes in `packages/shared/src/types/team.ts`; web
`app/teams/` (the **Teams** page in the sidebar, and a team's page),
`components/teams/*`, `hooks/use-my-teams.ts`, and the **Team** option of
`components/ui/owner-picker.tsx`.

## Turning teams on

Teams are **off by default**: nobody is in a team, there is no Teams page or
Team choice in the pickers, and every `/api/teams/...` route answers 404, so
everything belongs to the organization or to one person. A deployment admin
turns them on under **Settings → Access → Teams** (or the deployment does:
`OPTIO_TEAMS_ENABLED=true`, chart `teams.enabled: true`; the app's choice
wins). Turning them off again keeps the teams and what they own: a team's
rows then read as their creators' (`teamMembershipsOf` returns no team, so
the scope rules fail closed), until teams are on again.

## A team

`teams` belongs to a workspace: a name (unique in the workspace, case
aside), a slug derived from it, a description, a join policy and who created
it. `team_members` holds each person's `role` (`admin` | `member`), `status`
(`active`, or a join request `requested` / `denied`), its `source` (`manual`:
added or approved in the app; `sso`: from a group mapping) and who decided it
when. `team_group_mappings` maps a group name to a role. Deleting the
workspace deletes its teams; deleting a team deletes its memberships and
mappings.

### Join policies

| `joinPolicy` | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `open`       | Anyone in the workspace can join — at once                        |
| `request`    | People ask to join; a team admin approves (the default)           |
| `closed`     | Members are added by an admin (or by SSO groups); asking is a 403 |

### Roles

- A **team admin** changes the team (name, description, join policy),
  decides join requests, adds people (by email — someone who has signed in
  once — or user id) and removes them, sets roles and group mappings, deletes
  the team, and manages the team's secrets. The creator is the first admin. A
  team keeps at least one: the last admin can't leave, be made a member or be
  removed (`assertNotLastAdmin`). Team admins also get the emails about the
  team's work (a merge request waiting, work that needs a person or failed),
  unless they turn "Your teams' work too" off (docs/notifications.md).
- A **member** sees and uses what the team owns, and runs and changes the
  team's work.
- A **workspace admin** may do everything a team admin may (`canManage`),
  and may delete any team resource (offboarding); a team resource they are
  not a member of is otherwise read-only to them.

### Who may do what

- Any member of the workspace creates a team (`POST /api/teams`) and becomes
  its first admin.
- Anyone in the workspace asks to join (`POST /api/teams/:id/join`): an
  `open` team admits at once, a `request` team records a request, a `closed`
  one refuses — unless the caller manages the team. A pending request can be
  withdrawn, and a member leaves, with `DELETE /api/teams/:id/join`.
- A team admin or a workspace admin approves or denies a request, adds and
  removes members, sets a member's role and the group mappings. Everyone else
  gets a 403 ("Only the team's admins (or a workspace admin) can do that").
- `GET /api/teams` lists the workspace's teams with the caller's standing
  (`myRole`, `myStatus`, `canManage`, `pendingCount` for those who manage);
  `GET /api/teams/:id` adds the active members — and, for those who manage
  it, the requests waiting and the group mappings.

## SSO group mappings

`PUT /api/teams/:id/groups` with `{ mappings: [{ groupName, role }] }` (up to
50; names are matched case-insensitively) says which identity-provider groups
fill the team. After every sign-in, `syncTeamsFromGroups` (called from
`completeSignIn` with the person's groups, in the organization workspace):

- the person joins every team whose mappings name one of their groups, with
  the mapped role — `admin` if any matching mapping says so — as an `sso`
  membership;
- `sso` memberships whose group no longer matches are removed;
- memberships made by hand (`manual`) are never touched, not even to change
  the role.

The groups come from the OIDC groups claim or the LDAP groups
(`docs/sign-in.md`); the Sign-in page's **Test** shows the names a person
carries, so they can be mapped as the provider spells them. The mapping rows
are group pickers: they suggest the LDAP directory's groups and the groups
seen at sign-in (`GET /api/auth/groups`, below) and take any name typed in
full. Group sync runs for every workspace a person's groups reach — the
organization workspace and the ones that open to their groups.

## Workspaces by group

A workspace can name the identity-provider groups whose members may be in it
(`workspaces.access_groups`, set when it is created or under Workspace
settings → Access → Groups; at most 50, stored lower-cased) and the role they
get (`access_groups_role`: member or viewer, never admin). Then
(`services/workspace-groups.ts`):

- on every sign-in, `joinWorkspacesByGroups` adds the person to each
  workspace one of their groups opens (`completeSignIn`, after the
  organization step) and fills that workspace's group-mapped teams;
- when an admin adds groups to a workspace (or creates one with them),
  `admitUsersByGroups` admits everyone who already signed in with one of
  them (`users.sso_groups`), so nobody has to sign in again;
- a workspace one of their groups opens but that they aren't in — they left
  it, or an admin removed them — is **discoverable**: the workspace menu
  lists it under **Discoverable** with **Join**
  (`GET /api/workspaces/discoverable`, `POST /api/workspaces/:id/join`; the
  server matches the person's own groups again, 403 when none opens it);
- a membership a group made (any of the three above) is marked
  (`workspace_members.joined_via_groups`). Signing in never takes one away,
  but the **directory sync** does, for people who sign in with LDAP: once
  none of their groups opens the workspace, they leave it and its
  group-mapped teams, unless an admin made them the workspace's admin or
  the workspace has no groups left ([directory-sync.md](directory-sync.md)).
  A membership added by hand, or made before this version, stays.

Nothing creates a workspace for a group: workspaces are made by people, and
a group only opens the ones that name it.

**Only a deployment admin** sets or changes a workspace's groups or their
role, at creation or later (`services/deployment-admin-gates.ts`): a group's
members join at once, so opening a workspace to one is the directory's
business, not one workspace admin's. Anyone else gets 403 "Only a deployment
admin opens a workspace to directory groups"; a request that repeats the
groups and role already there isn't refused. Workspace settings show the
groups read-only to other admins, and the change goes to the action log
(`workspace.access_groups`).

### Creating a workspace

Whoever creates a workspace becomes its admin. By default everyone signed in
may, as upstream (`workspaces.creation: everyone`). A deployment can let only
a **deployment admin** create one (`admins`): everyone else then gets into the
organization's workspace, and the ones their groups open, by signing in. A
deployment admin picks either under Settings → Access → Workspaces (stored in
`deployment_settings`, `services/deployment-settings.ts`), which wins over the
deployment's own value (`OPTIO_WORKSPACE_CREATION`, chart
`workspaces.creation`); "Follow the deployment" removes the saved choice.
`GET /api/deployment-settings` tells the web app whether to show **New
workspace** (`mayCreateWorkspace`); `PUT` is a deployment admin's. Being a
workspace's admin never reaches beyond it under `admins`: the **global**
secrets (the organization's `GITLAB_TOKEN` most runs push with, agent
sign-ins) are then a deployment admin's too, whatever workspace the request
comes from (403 "Only a deployment admin changes organization-wide secrets";
the Organization owner for a secret or an agent credential is offered to
deployment admins only). Under `everyone`, any workspace admin writes them.

The group pickers (workspace groups, admin / required groups under Settings →
Sign-in, team mappings, the first-setup admin group) search
`GET /api/auth/groups?q=&limit=` (anyone signed in): with the LDAP provider
configured, the directory's groups whose `cn` contains `q`
(`ldapSearchGroups`, bound as the service account, under the group base DN —
the user base DN when none is set — at most 50), merged with the groups
Optio has seen (`users.sso_groups`, team mappings, workspaces' groups, the
providers' admin and required groups). When the directory can't be searched
the answer carries `ldapError` and the seen groups; a name typed in full is
always taken (an OIDC group, or one nobody has signed in with yet).

First setup: the wizard's Sign-in step asks for the **Admin group(s)** up
front — the provider's `adminGroups`, saved with it — whose members are
admitted as deployment admins and admins of the organization workspace every
time they sign in.

## Who sees whose work

A workspace's **work visibility** (`workspaces.work_visibility`, Workspace
settings → Access → Work visibility; admins change it) picks the rule for
Tasks, scheduled Tasks, Jobs, Job runs and persistent agents
(`services/work-visibility.ts`):

- **teams** — a member sees their own work, their teams' work and what they
  created (organization work included, when they started it); nothing else.
  The organization's other work, other people's and other teams' are an
  admin's to see. "Other people's" never appears for a member.
- **organization** — the default (`visibleOwner`): the organization's work
  is everyone's, a person's their own, a team's its members'.

`NULL` means the deployment's default, `OPTIO_WORK_VISIBILITY_DEFAULT` — the
chart's `workspaces.workVisibility`, `organization` by default (and without
the variable). Admins see everything in both modes.
`visibleWork(ownerCol, teamCol, createdByCol, actor)` is the SQL form,
`canSeeWork(row, actor)` the row form; the auth plugin (and the controller's
own token check) put the mode and the person's teams on the Actor once per
request, and `/api/auth/me` returns it as `workVisibility`. Secrets,
connections, prompts and the other resources keep the scope rule alone. The
events socket drops a frame about the organization's work for a member in
teams mode unless the frame says they created it. The usage leaderboard is
not narrowed by the mode yet.

**Outbound webhooks** (Webhooks page, `/api/webhooks`) follow the same rule:
a hook speaks for the person who created it (`services/webhook-audience.ts`).
It receives events only for work in its own workspace, and there only for
work its creator may see (`canSeeWork` with their role, teams and the
workspace's mode); a creator who left the workspace gets nothing. A hook with
no workspace (made before workspaces existed) receives only while its creator
is a deployment admin. Changing, testing or deleting a hook and reading its
deliveries (which carry the payloads) is its creator's or a workspace
admin's (a deployment admin's for a hook with no workspace), so nobody can
point someone else's hook at their own address. Anyone else in the workspace
still sees the hook on the Webhooks page and its own page, without the
controls and with its deliveries hidden.

## Ownership: the third scope

| Scope        | Columns                                               | Who sees it                                    | Who changes it                                                                    |
| ------------ | ----------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| Organization | both null                                             | Everyone in the workspace                      | The kind's own role rule (admin or member)                                        |
| Team         | `owner_team_id` = the team, `owner_user_id` = creator | The team's members; workspace admins read-only | Team admins (members, for kinds every member may change); workspace admins delete |
| Private      | `owner_user_id` = the person                          | Its owner; workspace admins read-only          | Its owner; workspace admins delete                                                |

**The fail-closed rule.** A team row keeps its creator in `owner_user_id`.
Code that doesn't know about teams — an older list, a path that reads only
the user column — treats it as the creator's private row: narrower than
meant, never wider. A team resource can't leak to the whole workspace by an
oversight.

The helpers in `services/ownership.ts`, with their team half:

- `actorOf(req)` carries `teamIds` and `adminTeamIds` — the caller's active
  memberships in the current workspace, set by the auth plugin.
- `visibleOwner(column, actor, teamColumn)`: an admin sees everything; a
  member the organization's rows, their own, and their teams'.
- `canSee(ownerUserId, actor, ownerTeamId)`: a team row is its members'
  (admins see it read-only).
- `canChange(ownerUserId, actor, orgRule, action, { ownerTeamId, orgNeeds })`:
  team admins change a team row; members too when the kind's organization
  rows are every member's to change (`orgNeeds: "member"`); `delete` is also
  a workspace admin's. `changeRefusal` words the 403.
- `usableBy` / `canUse`: a team's work uses the organization's rows plus the
  team's — not its creator's private ones; a person's work never uses a
  team's rows.
- `ownerColumnsForNew(owner, actor)`: the body's `owner: "team:<id>"` makes a
  new row the team's; the actor must be an active member (else a 403).
- `withOwnerNames(rows)`: a team row carries `ownerTeamName` (and the
  creator's `ownerName`).

## What can be a team's today

- **Work** — Tasks, scheduled Tasks, Jobs and persistent agents
  (`work-ownership.ts`): `owner: "team:<id>"` when creating it, or when
  handing it over (`ownerAfterUpdate`; the actor must be a member). The
  team's members see, run and change it; workspace admins may delete it. It
  runs with the **team's secrets**: `retrieveSecretWithFallback(…, teamId)`
  tries the team's secret first, then the organization's — never its
  creator's own (`pooled-agent-env.ts`, and `resolveSecretsForTask` for a
  pod's secrets). Personal work tries its owner's, then the organization's.
  A PR review is the team's when a team's work opened the PR and the review
  is the organization's or a member asked for it (`reviewOwnerTeam` in
  `workers/pr-review-worker.ts`). Work on a machine (`runsOn: "local"`) is always
  the machine's owner's, never a team's.
- **Prompts** (`prompt_templates.owner_team_id`): a team's prompts are every
  member's to change (`orgNeeds: "member"`).
- **Secrets** (`secrets.scope = "team"` with `team_id`; a team secret keeps
  its workspace): `GET /api/secrets` returns a team's secrets, by name, to
  its members — and every team's to a workspace admin. Creating or deleting
  one (`scope: "team"` + `teamId` in the body, or `?scope=team&teamId=` on
  delete) takes a team admin or a workspace admin; a plain member gets "Only
  the team's admins can change its secrets". The secret picker offers the
  viewer's teams' secrets (`listPickableSecrets`).
- **A GitLab token** (`GITLAB_TOKEN` at team scope, Teams → the team →
  Tokens): Optio reaches GitLab for the team's work with it — merge requests,
  pipelines, the pod's clone — instead of the organization's. The lookup
  (`git-token-service.ts` for the API, `git-access-env.ts` for pods) is the
  team's token for a team's work — then the workspace's / the organization's,
  never its creator's own; for anyone else's work the owner's own
  (`GITLAB_TOKEN` at user scope, Settings → My tokens; one saved under the
  older `GITLAB_USER_ACCESS_TOKEN` still counts), then the workspace's / the
  organization's; then the `GITLAB_TOKEN` env var. With more than one GitLab
  (gitlab.com and a self-managed one), a token saved as
  `GITLAB_TOKEN_<HOST>` — the host in capitals, other characters
  underscores: `git.example.com:8443` → `GITLAB_TOKEN_GIT_CORP_EXAMPLE_8443`
  — is used for that host only, ahead of the plain `GITLAB_TOKEN` at the same
  scope (and as an env var). A pod's git asks Optio for the token of the host
  it pushes to (`/api/internal/git-credentials?host=`), answered only for a
  host named as GitLab (gitlab.com, `GITLAB_HOSTS`, the setup wizard's
  `GITLAB_HOST`). Any GitLab token kind works — personal, project or group
  access tokens, OAuth — with the `api` scope; a project or group access
  token (its bot user) is the usual organization token. When the
  organization's token for a host is one, agents commit to that host's repos
  as its bot user unless `GIT_BOT_NAME` / `GIT_BOT_EMAIL` are set; a person's
  token leaves the default identity, so no commit is authored as them. The model
  gateway's token is stricter: exactly the owner's, with no fallback
  (`docs/model-gateway.md`).
- **A gateway key made by Optio, with a budget** (Teams → the team →
  Tokens → **Create team key**, when the gateway lets Optio make keys): on
  LiteLLM a LiteLLM team with the budget and a key bound to it, on OpenRouter
  and Portkey a key whose own limit is the budget, stored as the team's
  gateway token; the gateway refuses the team's model calls once the budget
  is spent. The team's admins and workspace admins create, rotate and revoke it
  and set the budget (a team admin may raise it up to the gateway's team
  budget, and may always rotate, change the period or lower it); its
  members see the budget on the team's page and on Usage → Teams, and the
  team's admins get an email at 80% and 100%
  ([model-gateway.md](model-gateway.md#keys-optio-makes)).
- **Ticket providers** (`ticket_providers.owner_team_id`, with
  `workspace_id` and `owner_user_id`): Settings → Tickets → Add provider has
  an owner picker. The organization's needs a workspace admin, a team's its
  team admins (`team:<id>`), a person's any member; changing, testing and
  re-enabling follow the same rule, and a workspace admin may also delete a
  team's or a person's. The list shows what the viewer may see, sectioned by
  owner. The tasks a provider's tickets become are its owner's — the team's
  work, created by the provider's creator — so a team's Jira fills the team's
  work with its secrets and tokens; a provider with an owner claims tickets
  under its own key, so two teams on one Jira project each get their task.
  Rows from before the columns (all null) stay the deployment's and sync as
  before. The setup wizard's provider is the organization's. What a ticket
  provider writes back on its tickets (comments, the work's link, statuses)
  and whether comments there resume the work is its **Round trip**, changed
  by the same people: [ticket-round-trip.md](ticket-round-trip.md).
- **A chat channel** (Teams → the team → Team channel): a chat service's
  incoming webhook the team's admins and workspace admins set, which
  hears about the team's own work (and, if ticked, its gateway budget and
  tokens) — never a member's own work or another team's
  ([notifications.md](notifications.md#a-teams-channel)).

## What can't yet

- **Connections, model providers, MCP servers and skills**: their rows have
  an `owner_team_id` column, but their services and routes don't read it, so
  such a row would be treated as its creator's private one (the fail-closed
  rule). Model providers refuse a `team:<id>` owner outright: a team's work
  uses the organization's providers with the team's token. The owner pickers
  that offer **Team** today are the work form, the Prompts page, Settings →
  Secrets, Coder connections and ticket providers (Jira, GitLab issues).
- A team lives in one workspace.

## Deleting a team

`DELETE /api/teams/:id` ("what it owns goes with it"): the memberships, the
group mappings, the team's **secrets** and **prompts** are deleted with it
(`ON DELETE CASCADE`). Its **work** — tasks, work definitions, persistent
agents — keeps its creator as owner and becomes their private work
(`ON DELETE SET NULL` on `owner_team_id`). A gateway key Optio made for it
is deleted on the gateway at the next key check (its row keeps the key's id,
`gateway_issued_keys.team_id` set to null).

## The UI

- Sidebar → **Teams** (`app/teams/page.tsx`, `useMyTeams`): the workspace's
  teams with the viewer's standing; join, ask to join or leave; **New team**
  (name, description, join policy).
- A team's page (`app/teams/[id]`): the members with their role chips, **Make
  admin** / **Remove** and the form that adds someone by email
  (`team-members.tsx`); the requests waiting; the team's settings and
  delete (`team-settings.tsx`); the SSO group mappings
  (`group-mappings-editor.tsx`) — for those who manage it.
- Owner pickers show **Organization / Private / Team** (a select of the
  viewer's teams) where a resource can be a team's; a team's row carries a
  **Team · Name** chip (`OwnerChip`).
- The workspace menu (`workspace-switcher.tsx`): **New workspace** opens a
  dialog with the name, **Accessible to groups** (`GroupsCombobox`) and the
  role they join as; **Discoverable** lists the workspaces the viewer's
  groups open, each with **Join**. Workspace settings → Access has the
  **Groups** and **Work visibility** blocks.
- Settings → My tokens and a team's **Tokens** have a **GitLab token** field
  (`gitlab-token-section.tsx`).
- A team's **Tokens** has **Create team key**, the team's gateway budget and
  what it has spent, **Set budget**, **Rotate** and **Revoke**
  (`team-gateway-key.tsx`) when the gateway lets Optio make keys; its paste
  field only when the gateway takes pasted keys. A member who doesn't manage
  the team sees the budget read-only (**Gateway budget**). Usage has a
  **Teams** panel (`team-usage-panel.tsx`).

## Endpoints

| Method | Path                                    | Who                                                         |
| ------ | --------------------------------------- | ----------------------------------------------------------- |
| GET    | `/api/teams`                            | anyone in the workspace                                     |
| POST   | `/api/teams`                            | any member (becomes the first admin)                        |
| GET    | `/api/teams/:id`                        | anyone in the workspace (more for those who manage it)      |
| PATCH  | `/api/teams/:id`                        | team admin or workspace admin                               |
| DELETE | `/api/teams/:id`                        | team admin or workspace admin                               |
| POST   | `/api/teams/:id/join`                   | anyone in the workspace (as the join policy allows)         |
| DELETE | `/api/teams/:id/join`                   | the member (not the last admin) or requester                |
| POST   | `/api/teams/:id/members/:userId/decide` | team admin or workspace admin (`{ decision }`)              |
| POST   | `/api/teams/:id/members`                | team admin or workspace admin (`{ userId \| email, role }`) |
| PATCH  | `/api/teams/:id/members/:userId`        | team admin or workspace admin (`{ role }`)                  |
| DELETE | `/api/teams/:id/members/:userId`        | team admin or workspace admin                               |
| PUT    | `/api/teams/:id/groups`                 | team admin or workspace admin (`{ mappings }`)              |
| GET    | `/api/gateway/teams/:id`                | the team's members, team admins, workspace admins           |
| POST   | `/api/gateway/teams/:id/key`            | team admin or workspace admin (a budget, optional)          |
| PUT    | `/api/gateway/teams/:id/budget`         | team admin or workspace admin (`{ maxBudget }`)             |
| DELETE | `/api/gateway/teams/:id/key`            | team admin or workspace admin                               |

Errors are `TeamError`s with their status (400, 403, 404, 409) and a sentence
for the person.

## Testing

`services/ownership.int.test.ts` covers the organization / private half of
the rule; there is no team-specific test file yet (`team-service.ts`,
`routes/teams.ts` and the group sync are untested).
