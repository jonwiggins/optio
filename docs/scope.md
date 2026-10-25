# Organization, team and private scope

Every resource a workspace holds — secrets, connections, model providers, MCP
servers, skills, prompts, and work of every kind (Tasks, scheduled Tasks,
Jobs, persistent agents) — belongs to the **organization**, to a **team**, or
to one **person**:

| Scope            | Columns                                             | Who sees it                                                | Who changes it                                                                    |
| ---------------- | --------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Organization** | `owner_user_id IS NULL`                             | Everyone in the workspace                                  | Each resource's own role rule (admin or member)                                   |
| **Team**         | `owner_team_id = <team>`, `owner_user_id` = creator | The team's members; workspace **admins** read-only         | The team's admins (its members, for kinds every member may change); admins delete |
| **Private**      | `owner_user_id = <user>`                            | Its owner; workspace **admins** read-only, named with them | Its owner alone; admins may **delete** (offboarding)                              |

One rule, one place: `apps/api/src/services/ownership.ts`.

- `visibleOwner(column, actor, teamColumn?)` — the `WHERE` term lists use:
  everything for an admin, otherwise `owner IS NULL OR owner = me`, plus the
  actor's teams' rows when the table has a team column.
- `canSee(owner, actor, ownerTeam?)` — the row form; a member fetching someone
  else's private row gets a **404** (its existence is theirs), an admin a
  read-only row; a team row is its members'.
- `canChange(owner, actor, orgRule, action, team?)` — a private row is its
  owner's; a team row its team admins' (its members' too for a kind whose
  organization rows every member may change, `orgNeeds: "member"`); `delete`
  is also open to admins. Changing, running or using someone else's private
  resource is a **403** for everyone but the owner, admins included.
- `usableBy(column, workOwner, teamColumn?, workTeam?)` / `canUse` — what a
  piece of work may be given: the organization's rows, plus its owner's own
  private rows — or, for a team's work, plus the team's rows (never its
  creator's private ones). Organization work never uses anything private.
- `ownerColumnsForNew(owner, actor)` — the body's
  `owner: "workspace" | "me" | "team:<id>"` decides a new row's scope (a team
  the actor must be an active member of); `ownerForNew` is the user-only form.
- `withOwnerNames(rows)` — private rows carry `ownerName`, team rows
  `ownerTeamName`, so a list can say whose they are.

`work-ownership.ts` keeps the work-specific rules (an owner's work runs with
their secrets / providers / connections; `owner: "me"`; making work personal;
a team's work runs with the team's secrets).

**Teams** are the third scope: a team row keeps its creator in
`owner_user_id`, so code that doesn't know about teams treats it as the
creator's private row — it fails closed, never open. Today work, prompts,
secrets (a team's `GITLAB_TOKEN` among them) and ticket providers can be a
team's; connections, model providers, MCP servers and skills carry the column
but their services don't read it yet. See `docs/teams.md`.

**Work visibility.** In a workspace whose work visibility is `teams` (an
opt-in: Workspace settings, or the deployment's `OPTIO_WORK_VISIBILITY_DEFAULT`), work narrows
further: a member sees their own, their teams' and what they created, and the
organization's other work is an admin's to see (`work-visibility.ts`,
`docs/teams.md` → Who sees whose work). Resources keep the rule below.

## What follows from it

- **Private work** (`tasks`, `work_definitions`, `persistent_agents`) is
  visible only to its owner — in the Work list, the per-kind lists and detail
  endpoints, recent runs, and the events socket (`/ws/events` drops private
  events for other viewers, looking up whose a frame's work is when the
  frame doesn't say, and drops frames from workspaces the viewer isn't in)
  — and read-only to admins. Cancel / retry / run now / review are the
  owner's alone. The analytics (`/api/analytics/*`, costs included) count
  only the work the viewer may see; an admin's count it.
- **A private persistent agent** accepts messages from its owner and from the
  owner's other private agents; the organization's agents reach only the
  organization's (`/api/internal/persistent-agents/send|broadcast`).
- **A personal GitLab token** is the secret `GITLAB_TOKEN` at user scope
  (Settings → My tokens): the owner's work reaches GitLab with it instead of
  the organization's; a team's work uses the team's.
- **Private secrets** (`scope = "user"`) are stored without a workspace, so
  every reader's lookup (by user alone) decrypts them. `GET /api/secrets`
  returns the organization's (instance-wide `global` rows and this
  workspace's repo-scoped rows), the caller's own, and — for an admin —
  members' private secrets by name. An admin deletes someone's with
  `DELETE /api/secrets/:name?scope=user&userId=<owner>`.
- **MCP servers, skills and prompts** have an `owner_user_id` too. Members may
  add private ones; the organization's MCP servers still need an admin. A
  prompt's name is unique per scope (`prompt_templates_scope_name_key`), not
  across the instance.
- `buildAgentEnvironment` gives a pod the organization's connections, MCP
  servers and skills plus its owner's private ones; `GET /api/work/environment`
  marks the private items (`private: true`).

## The UI

One vocabulary everywhere: pickers say **Organization / Private**, and
**Team** (with a select of the viewer's teams) where a resource can be a
team's; lists are **sectioned** Organization / Private / Other people's (the
last for admins); a chip says **Private** (or **Private · Name** for someone
else's).

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
