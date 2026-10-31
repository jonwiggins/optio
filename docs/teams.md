# Teams

A **team** is a group of people inside a workspace that owns work and
secrets together: a third scope next to the **organization** and one
**person** ([scope.md](scope.md)). Its members see, run and change its work;
its admins run the team.

Code: `apps/api/src/services/team-service.ts` (teams, joining, members, group
sync), `services/ownership.ts` (the scope rule with its team half),
`services/work-visibility.ts` (the optional "teams" work visibility),
`routes/teams.ts`, the shapes in `packages/shared/src/types/team.ts`; web
`app/teams/`, `components/teams/*`, `hooks/use-my-teams.ts`.

## Turning teams on

Teams are **off by default**. With them off nobody is in a team, there is no
Teams page or Team owner choice, every `/api/teams/...` route answers 404,
and the API's shapes are upstream's: `/api/auth/me` and the request's actor
carry no team fields. A deployment admin turns them on under **Settings →
Access → Teams**, or the deployment does with `OPTIO_TEAMS_ENABLED=true` (the
saved choice wins; "Follow the deployment" removes it).

Turning teams off again keeps the teams and what they own. A team's row keeps
its creator in `owner_user_id`, so while teams are off it reads as its
creator's private row, in the lists and the row checks alike: its creator
sees and changes it, the team's other members don't. It still runs as the
team's work (the team's secrets, never its creator's own), and its controller
token stops working until teams are on again.

## A team

`teams` belongs to a workspace: a name (unique in the workspace, case aside),
a slug, a description and a join policy. `team_members` holds each person's
`role` (`admin` | `member`), `status` (`active`, or a join request
`requested` / `denied`) and `source` (`manual`, or `sso` from a group
mapping). `team_group_mappings` maps a group to a role.

| `joinPolicy` | Meaning                                                     |
| ------------ | ----------------------------------------------------------- |
| `open`       | Anyone in the workspace joins at once                       |
| `request`    | People ask to join; a team admin approves (the default)     |
| `closed`     | Members are added by an admin or by groups; asking is a 403 |

Any member of the workspace creates a team and becomes its first admin. A team
admin, or a workspace admin, changes the team, decides join requests, adds
people (by email, someone who has signed in once) and removes them, sets
roles and group mappings, and deletes the team. A team keeps at least one
admin. Team changes go to the action log (`team.*`).

## Groups fill teams

`PUT /api/teams/:id/groups` with `{ mappings: [{ groupName, role }] }` says
which identity-provider groups fill the team. A mapping names a
**provider-qualified group** (the group pickers offer them; see
[sign-in.md](sign-in.md)): a bare name is refused, and the same group name
from another provider (a Bitbucket workspace slug, say) never fills the team.

At every sign-in whose provider reports groups, while teams are on, the
person joins each team of their workspaces whose mappings name one of their
groups (the strongest mapped role wins), and leaves the group-made
memberships whose group no longer matches. Memberships added by hand are
never touched, and a sign-in without a groups claim changes nothing.

## What a team owns

- **Work**: Tasks, scheduled Tasks, Jobs and persistent agents. The work form
  offers **Team** as an owner (`owner: "team:<id>"`, the caller a member).
  The team's members see, run and change it; workspace admins see it and may
  delete it. Subtasks and reviews of a team's task are the team's too.
- **Secrets and tokens** (`secrets.scope = "team"`, a team's page → Secrets
  and tokens; its admins and workspace admins change them, by name only).

A team's work runs as the team, never as the person who made it:

- secrets: the team's, then the workspace's and the organization's, never its
  creator's own (`retrieveSecretWithFallback`, `resolvePodSecrets`); its pod
  secrets are picked from the organization's and the team's;
- git: the team's `GITLAB_TOKEN` / `GITHUB_TOKEN`, else the organization's
  (the pod's git credential scope names the team, and is refused once its
  creator is no longer one of the team's active members);
- connections, MCP servers, skills, model providers and agent credentials:
  the organization's only, never its creator's private ones, even assigned to
  every repo or added by the work's own settings;
- pods of its own, apart from its creator's personal work;
- its controller token (docs/controller-mcp.md) acts for the team alone: it
  reaches the organization's work and the team's, not its creator's private
  work or their other teams', and anything it creates is the team's.

Deleting a team deletes its memberships, mappings and secrets; its work
becomes its creator's private work.

## Who sees whose work

A workspace admin may set **Work visibility** (Workspace settings → Access,
shown while teams are on):

- **organization** (the default; upstream's rule): the organization's work is
  everyone's, a person's their own, a team's its members'.
- **teams**: a member sees their own work, their teams' work and what they
  started; the organization's other work and other teams' are an admin's to
  see.

`null` follows the deployment's `OPTIO_WORK_VISIBILITY_DEFAULT`
(`organization` when unset). While teams are off the mode has no effect.
Secrets, connections, prompts and the other resources keep the scope rule.

## Not part of teams yet

Team-owned connections, MCP servers, skills, prompts and model providers;
team gateway keys and budgets; team-owned ticket providers; team chat
channels and team notification emails. Outbound webhooks are unchanged.
