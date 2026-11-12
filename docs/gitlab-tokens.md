# GitLab tokens

GitLab calls accept personal, project, group and OAuth access tokens through
`Authorization: Bearer`. A workspace admin adds the workspace's own token per
GitLab server under **Workspace Settings → GitLab**; it is used for that
workspace's work only (see [Per-workspace GitLab credentials](workspace-gitlab.md)).
A person may add their own `GITLAB_TOKEN` secret. The older personal
`GITLAB_USER_ACCESS_TOKEN` name remains supported. The deployment's
`GITLAB_TOKEN` serves the founding workspace only, unless the operator sets
`OPTIO_GITLAB_SHARE_DEPLOYMENT_CREDENTIALS=true`.

For multiple GitLab servers, `GITLAB_TOKEN_<HOST>` precedes `GITLAB_TOKEN` at
the existing lookup scopes. `<HOST>` is the uppercase host and port with
punctuation replaced by underscores, such as
`GITLAB_TOKEN_GIT_EXAMPLE_COM_8443`. The environment accepts the same names.
Server operations skip personal tokens.

The git credential helper requests a token for the asking host using the
work owner's signed credential scope. The API answers GitLab hosts named by
`GITLAB_HOSTS`, the workspace's own servers, or (where the workspace may use
the deployment's GitLab) the setup wizard's `GITLAB_HOST` secret, plus
`gitlab.com`; an unknown host receives no token. The legacy unscoped endpoint continues to
answer GitHub alone. A workspace member who loses execution access cannot
refresh credentials through an old helper key.

GitLab repository work requires a GitLab token rather than a GitHub token.
Project and group access-token bot users supply their GitLab commit identity
when no explicit identity is configured; personal tokens retain the default
agent identity. Set `GIT_BOT_NAME` and `GIT_BOT_EMAIL`, or Helm
`agent.git.botName` and `agent.git.botEmail`, to choose an identity explicitly.
Empty values preserve the existing GitHub App bot / Optio Agent default.
