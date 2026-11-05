# Organization and private scope

Every resource a workspace holds — secrets, connections, model providers, MCP
servers, skills, prompts, and work of every kind (Tasks, scheduled Tasks,
Jobs, persistent agents) — belongs either to the **organization** or to one
**person**:

| Scope            | Column                   | Who sees it                                                | Who changes it                                       |
| ---------------- | ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------- |
| **Organization** | `owner_user_id IS NULL`  | Everyone in the workspace                                  | Each resource's own role rule (admin or member)      |
| **Private**      | `owner_user_id = <user>` | Its owner; workspace **admins** read-only, named with them | Its owner alone; admins may **delete** (offboarding) |

One rule, one place: `apps/api/src/services/ownership.ts`.

- `visibleOwner(column, actor)` — the `WHERE` term lists use: everything for
  an admin, otherwise `owner IS NULL OR owner = me`.
- `canSee(owner, actor)` — the row form; a member fetching someone else's
  private row gets a **404** (its existence is theirs), an admin a read-only row.
- `canChange(owner, actor, orgRule, action)` — a private row is its owner's;
  `delete` is also open to admins. Changing, running or using someone else's
  private resource is a **403** for everyone but the owner, admins included.
- `usableBy(column, workOwner)` / `canUse` — what a piece of work may be given:
  the organization's rows, plus its owner's own private rows. Organization
  work never uses anything private.
- `ownerForNew(owner, actor)` — the body's `owner: "workspace" | "me"` decides
  a new row's scope.
- `withOwnerNames(rows)` — private rows carry `ownerName` so an admin's list
  can say whose they are.

`work-ownership.ts` keeps the work-specific rules (an owner's work runs with
their secrets / providers / connections; `owner: "me"`; making work personal).

## What follows from it

- **Private work** (`tasks`, `work_definitions`, `persistent_agents`) is
  visible only to its owner — in the Work list, the per-kind lists and detail
  endpoints, recent runs, and the events socket (`/ws/events` drops private
  events for other viewers) — and read-only to admins. Cancel / retry / run
  now / review are the owner's alone. Cost analytics count it in the
  workspace's totals.
- **A private persistent agent** accepts messages from its owner and from the
  owner's other private agents; the organization's agents reach only the
  organization's (`/api/internal/persistent-agents/send|broadcast`).
- **Private secrets** (`scope = "user"`) are stored without a workspace, so
  every reader's lookup (by user alone) decrypts them. `GET /api/secrets`
  returns the organization's (this workspace's own `workspace` and
  repo-scoped rows, and the deployment's `global` rows it reads — below), the
  caller's own, and — for an admin — members' private secrets by name. An
  admin deletes someone's with `DELETE /api/secrets/:name?scope=user&userId=<owner>`.
- **A workspace's own organization secret** is scope `workspace` (a workspace
  admin's): its agent key, its `GITLAB_TOKEN` / `GITLAB_TOKEN_<HOST>`, any key
  its work picks. Every lookup reads it before the deployment's of the same
  name (`retrieveSecretWithFallback`: the person's → the workspace's → the
  deployment's), it goes with the organization's secrets into setup
  (`resolveSecretsForSetup`), and an organization credential added from the
  Who section is stored here. A `global` secret never carries a workspace (#509).
- **Ticket providers** are a workspace's (its admins'): the provider list and
  its changes are scoped to the current workspace, the sweep matches a
  provider's tickets against its own workspace's repos only
  (`syncAllTickets`), and the Issues page and work-link statuses ask the
  workspace's own providers. Two workspaces can point at two Jiras.

## The deployment's own

A configuration row with **no workspace** — a `global` secret, a repo-scoped
secret saved before secrets had a workspace, a legacy connection, MCP server,
skill or installed skill, the agent-settings row — is the **deployment's**.
It is read by the founding workspace (the oldest; `foundingWorkspaceId`, the
rule `requireDeploymentAdmin` uses) and by callers with no workspace. Any
other workspace reads it only when a deployment admin shares it as a
**deployment default** (`deployment_default = true`); otherwise it resolves
inside the workspace and never silently falls through to whatever has no
workspace. One rule, one place: `apps/api/src/services/deployment-defaults.ts`
(`readsAllDeploymentRows`, `workspaceOrDeploymentDefault`, `mayReadRow`).

| Deployment row                                | Founding workspace | Any other workspace         |
| --------------------------------------------- | ------------------ | --------------------------- |
| Unshared (`deployment_default = false`)       | reads it           | doesn't see or get it (404) |
| Shared as a deployment default                | reads it           | reads it, after its own     |
| Picked by name by work (pod secret, `${{X}}`) | reads it           | never (shared or not)       |

- **Changing** a deployment row (PATCH / DELETE / test a connection, MCP
  server, skill or installed skill) takes deployment authority
  (`hasDeploymentAuthority`; `routes/deployment-rows.ts`): a workspace admin
  gets a 403, so nobody in workspace A changes what workspace B runs with.
- **Sharing**: `deploymentDefault: true | false` in the PATCH of a deployment
  connection, MCP server, skill or installed skill, and
  `PUT /api/secrets/:name/deployment-default` for a secret. Deployment admins
  only; a workspace's own row can't be shared (400).
- **Upgrading** changes nothing: migration `1794990300_workspace_scoped_config`
  shares every deployment row that exists when it runs (private and legacy
  `user:<id>` tokens excepted) and gives existing ticket providers the founding
  workspace. Rows a deployment admin saves afterwards start unshared.
- **A new configuration table** with a nullable `workspace_id` goes through
  these helpers from day one (a future plugins table included).
- Work elsewhere can't pick a `global` secret as a pod secret or name one in a
  connection's or MCP server's `${{NAME}}` (`mayUseDeploymentSecrets`), shared
  or not. A connection is assigned only to its own workspace's repos.
- **MCP servers, skills and prompts** have an `owner_user_id` too. Members may
  add private ones; the organization's MCP servers still need an admin. A
  prompt's name is unique per scope (`prompt_templates_scope_name_key`), not
  across the instance. Prompts with no workspace (the starter prompts, the
  deployment's defaults) are everyone's to read and only a deployment admin's
  to change. Work linked to a saved prompt (`promptTemplateId`) may use its
  own workspace's or the deployment's, the organization's or its owner's own
  (`promptUsableBy`), checked when it is saved and when it renders.
- `buildAgentEnvironment` gives a pod the organization's connections, MCP
  servers and skills plus its owner's private ones; `GET /api/work/environment`
  marks the private items (`private: true`).

## The UI

One vocabulary everywhere: pickers say **Organization / Private**; lists are
**sectioned** Organization / Private / Other people's (the last for admins);
a chip says **Private** (or **Private · Name** for someone else's).

- `apps/web/src/lib/owner.ts` — `ownerScope(row, viewerId)`, counts, filters.
- `hooks/use-current-user.ts` — one `useCurrentUser()` (`userId`, `isAdmin`,
  `isDeploymentAdmin`) in place of per-component `/api/auth/me` calls.
- `components/ui/owner-segments.tsx` (`OwnerSegments`, `useOwnerFilter` →
  `?owner=`), `scoped-list.tsx` (`ScopedList`), `owner-picker.tsx`
  (`OwnerPicker`), `owner-chip.tsx` (`OwnerChip`). The Secrets page is the
  exemplar; Connections, Model providers, MCP servers, Skills, Prompts, the
  Work list and the New work form use the same pieces. "+ New" opens on the
  scope being viewed.
- iOS and Android group their Secrets, Connections and Model providers screens
  the same way and tag private Work rows.

## Testing

`apps/api/src/services/ownership.int.test.ts` — two members and an admin in
one workspace, every resource kind, the secret round trip through the route,
and the boot-time heal of private secrets saved before the fix.
`apps/api/src/services/workspace-scoped-config.int.test.ts` — two workspaces
and the founding one: lists and pods for every configuration kind, secrets,
assignments, and changing / sharing a deployment row over HTTP;
`apps/api/src/db/workspace-scoped-config-migration.int.test.ts` — the upgrade.
