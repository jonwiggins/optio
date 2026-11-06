# Shared git token only for allowed repositories

By default the deployment's own git credentials are the last fallback for every
repository: the GitHub App installation token, the deployment's `GITHUB_TOKEN`,
`GITLAB_TOKEN` and `GITLAB_TOKEN_<HOST>` secrets, and the API's `GITHUB_TOKEN` /
`GITLAB_TOKEN` environment. Any workspace admin can add a repository on a listed
git host, and agents then read and push it with those credentials. With the
default `workspaces.creation: everyone`, everyone who signs in can be a workspace
admin.

An organization whose repositories follow need-to-know rules can turn on
**Settings → Access → Shared git token → Allowed repos only** (or
`OPTIO_SHARED_GIT_TOKEN_RESTRICTED=true`, Helm `sharedGitToken.restricted: true`;
the app setting wins, "Follow the deployment" removes it). Then the deployment's
credentials are used for a repository only when a deployment admin listed it for
the workspace doing the work. Each line of the list is a workspace slug and a
pattern:

```
platform gitlab.example.com/platform/*
team-a   gitlab.example.com/team-a/app
ops      *
```

`host/group/repo` is one repository, `host/group/*` everything below the group
(`host/*` the whole host), `*` every repository. Matching ignores case, the
scheme, a port and `.git`; a URL with `.` or `..` segments, escapes or a query
never matches.

Everything else uses credentials the git host itself authorizes:

- a person's own token (a private `GITHUB_TOKEN` or `GITLAB_TOKEN` secret, or
  the GitHub token from signing in with the GitHub App) for their own work and
  for adding a repository;
- a repository secret (`GITHUB_TOKEN` / `GITLAB_TOKEN` saved on the repository
  in the workspace) for its runs.

With the switch on:

- **Adding a repository** that only the shared token could open is refused, with
  a message saying to add your own token or ask a deployment admin.
- **Runs, reviews and sessions** (clone, push, the git credential helper) never
  receive the shared token for a repository that isn't allowed; a run that
  requires a GitHub token and has no other fails with the same message.
- **API calls to the git host** (pull requests, merge requests, branches, CI
  status, comments) and the background sweeps that make them (PR watcher,
  external PR reviews, auto-merge) use the shared token only for allowed
  repositories. A call that names no repository or no workspace never uses it,
  so the repository picker can't list with it (it says so; paste the URL or
  browse with your own token).

The allowlist is kept in the app (`GET` / `PUT
/api/deployment-settings/shared-git-token`, deployment admins only). Changes reach every API replica within a few seconds.
A saved switch that can't be read follows the environment, so set the
environment too when the restriction must hold regardless. CodeCommit uses AWS
credentials and is not covered.
