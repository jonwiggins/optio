# GitLab repositories and issues

On **Repositories → Add Repository**, a configured GitLab token or saved
GitLab host makes the GitLab choice available next to GitHub. Select GitLab
to search the projects your token can access, or paste a project URL and
validate it. The selected platform is saved with the repository, so a
self-managed GitLab hostname does not need to contain the word `gitlab`.
Known public hosts retain their own platform.

The browser lists the setup wizard's `GITLAB_HOST`, then the self-managed
hosts in `GITLAB_HOSTS`, then the hosts of GitLab repositories the workspace
already has, then `gitlab.com` when `GITLAB_HOSTS` names it (or when there is
no other host). With more than one, the picker shows a button per server:
click one to list its projects, searched with that server's token
(`GITLAB_TOKEN_<HOST>`, else `GITLAB_TOKEN`). The first is listed by default.
Credentials
use the existing personal/workspace/deployment lookup and host-qualified
tokens described in [GitLab tokens](gitlab-tokens.md). The deployment operator
must list a custom destination in `GITLAB_HOSTS` before stored credentials
are used. Private destinations also require the existing outbound policy
configuration (`OPTIO_OUTBOUND_ALLOWED_HOSTS`). Validation without a supplied
token retains the deployment-admin requirement.

Work's branch field searches the selected repository's platform, putting
the default branch first. A typed branch name still works when the platform
cannot list branches. GitLab change-request badges show **MR**, and
repository icons use the saved platform.

Under **Settings → Tickets**, choose **GitLab Issues**, enter a host and
access token, then either a project path (`group/project`) or a group path
(`group/subgroup`). A group's issues keep their individual project paths,
including when reading their comments or adding Optio's task link.

For HTTPS on a non-default port, deployment operators must list the exact host and port,
for example `GITLAB_HOSTS=git.corp.example:8443`. A bare hostname can identify the platform
but does not authorize sending credentials to every port on that host. MR/API requests and
the signed git helper both preserve this exact host:port identity.
