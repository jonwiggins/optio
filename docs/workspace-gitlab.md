# Per-workspace GitLab credentials

Each workspace signs in to GitLab with its own credentials. A workspace admin
adds GitLab servers under **Workspace Settings → GitLab**; the token saved
there is used for that workspace's work only, and no other workspace — and
no deployment-level caller — can use it.

## Model

| What                         | Where                                                                                     | Who changes it                    |
| ---------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| A workspace's GitLab servers | `workspace_gitlab_servers` (workspace, host, account, default), unique per workspace+host | Workspace admin                   |
| A workspace's token          | `secrets`: scope `workspace`, name `GITLAB_TOKEN_<HOST>`, `workspace_id` set              | Workspace admin (through the API) |
| A person's token             | `secrets`: scope `user`, `GITLAB_TOKEN_<HOST>` / `GITLAB_TOKEN`                           | That person                       |
| The deployment's token       | `secrets`: scope `global` `GITLAB_TOKEN[_<HOST>]`, or the API's environment               | Deployment admin / operator       |
| Hosts credentials may go to  | `gitlab.com` + `GITLAB_HOSTS` / `OPTIO_GITLAB_HOSTS`                                      | Operator                          |

A workspace's token is sealed like every secret (AES-256-GCM) with the
workspace id in its AAD, so a row read as another workspace's does not open,
and it is re-sealed by encryption key rotation with the rest. Removing a
server deletes its token; deleting a workspace deletes its servers.

`GET /api/workspace/gitlab` lists the servers (never a token) to every
member; `POST /api/workspace/gitlab/servers`, `PATCH` / `DELETE
/api/workspace/gitlab/servers/:id` are workspace-admin only and act on the
caller's current workspace. A save checks the token against the server's
`/api/v4/user` (through the outbound guard) before anything is stored, and
records who it signs in as.

## Which token work gets

For GitLab host `H` (the repository's host, else the workspace's default
server) and work in workspace `W`, the first of:

1. the person's own token (`GITLAB_TOKEN_<H>`, `GITLAB_TOKEN`, the legacy
   `GITLAB_USER_ACCESS_TOKEN`) — skipped for server operations (PR watching,
   reviews, issue sync, repository detection);
2. `W`'s own: its server's token for `H`, then a `GITLAB_TOKEN` saved as
   `W`'s workspace secret;
3. the deployment's (`GITLAB_TOKEN_<H>`, then `GITLAB_TOKEN`), following the
   rule for every deployment row ([scope](scope.md#the-deployments-own)):
   the founding workspace and callers with no workspace read the global
   secrets and then the API's environment; any other workspace reads only a
   global secret a deployment admin shares with every workspace (Settings →
   Deployment secrets, or `PUT /api/secrets/:name/deployment-default`). The
   environment can't be shared.

So a workspace's token never serves another workspace, and the deployment's
never overrides a workspace's own. Every server-side caller passes the
workspace of the task, review, repository or session it acts for
(`getGitPlatformForRepo(url, { workspaceId })`). Pods get the same
resolution (`applyGitAccess`), and the signed git credential helper answers
a host only when it is `gitlab.com`, in `GITLAB_HOSTS`, one of the
workspace's own servers, or — where the workspace may use the deployment's
GitLab — the setup wizard's deployment-wide `GITLAB_HOST`. A `GITLAB_HOST`
a workspace saves as its own secret is never trusted: that would let a
workspace admin name a host its members' personal tokens are handed to.
`GITLAB_TOKEN_<HOST>` secrets never go into a repo pod's setup env; git
sign-in delivers each for its own host only.

## Hosts

A workspace may only add a host the operator allows credentials to go to:
`gitlab.com` or one listed in `GITLAB_HOSTS`. A workspace admin therefore
can't point the API or the credential helper at a server of their choosing,
and a person's generic `GITLAB_TOKEN` is never sent to a host the operator
did not list. For HTTPS on another port, list the exact `host:port`.

## Upgrading

Before this change the deployment's `GITLAB_TOKEN` / `GITLAB_HOST` served
every workspace, and a workspace could not have its own. After it:

- nothing changes on upgrade for secrets that exist: the workspace-scoped
  configuration migration shares every existing deployment secret, so other
  workspaces keep the deployment's `GITLAB_TOKEN` until a deployment admin
  stops sharing it (Settings → Deployment secrets: the "Deployment · every
  workspace" tag). A deployment `GITLAB_TOKEN` saved afterwards starts
  unshared;
- a workspace's own server always comes before the deployment's, so a team
  can move to its own token without waiting for the share to end;
- a `GITLAB_TOKEN` set only in the API's environment serves the founding
  workspace alone from now on: store it as a deployment secret to share it.

The setup wizard's GitLab step now saves the running workspace's own server.
With sign-in turned off (no workspace) it still saves the deployment's
`GITLAB_TOKEN` / `GITLAB_HOST`.

GitLab Issues ticket providers (Settings → Tickets) are per workspace too
([scope](scope.md)). What stays deployment-wide: the operator's host list
(`GITLAB_HOSTS`) and the signed webhook receiver's `GITLAB_WEBHOOK_SECRET`.
