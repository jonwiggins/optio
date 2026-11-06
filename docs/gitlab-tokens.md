# GitLab tokens

GitLab calls accept personal, project, group and OAuth access tokens through
`Authorization: Bearer`. Add a `GITLAB_TOKEN` secret for the person, workspace
or deployment that owns the work. The older personal
`GITLAB_USER_ACCESS_TOKEN` name remains supported.

For multiple GitLab servers, `GITLAB_TOKEN_<HOST>` precedes `GITLAB_TOKEN` at
the existing lookup scopes. `<HOST>` is the uppercase host and port with
punctuation replaced by underscores, such as
`GITLAB_TOKEN_GIT_EXAMPLE_COM_8443`. The environment accepts the same names.
Server operations skip personal tokens.
To keep the deployment's own tokens to repositories a deployment admin
allowed, see [repo-access.md](repo-access.md).

The git credential helper requests a token for the asking host using the
work owner's signed credential scope. The API answers GitLab hosts named by
`GITLAB_HOSTS` or the setup wizard's `GITLAB_HOST` secret, plus `gitlab.com`;
an unknown host receives no token. The legacy unscoped endpoint continues to
answer GitHub alone. A workspace member who loses execution access cannot
refresh credentials through an old helper key.

GitLab repository work requires a GitLab token rather than a GitHub token.
Project and group access-token bot users supply their GitLab commit identity
when no explicit identity is configured; personal tokens retain the default
agent identity. Set `GIT_BOT_NAME` and `GIT_BOT_EMAIL`, or Helm
`agent.git.botName` and `agent.git.botEmail`, to choose an identity explicitly.
Empty values preserve the existing GitHub App bot / Optio Agent default.
