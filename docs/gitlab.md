# GitLab

Optio supports GitLab.com and self-managed GitLab servers for repository work,
merge requests, pipelines, webhooks and issues.

## GitLab instances in Settings

A deployment admin can add servers under **Settings → Integrations → GitLab
instances**. Each instance has a display name and an HTTPS base URL, including
any non-default port and relative URL root, for example
`https://git.example.com:8443/gitlab`. Add the URL of the GitLab installation,
without `/api/v4` or a project path. One instance may use each host and port;
GitLab namespaces below that installation can contain any number of subgroups.

An optional **CA certificate (PEM)** trusts that instance's private certificate
authority. Certificate and hostname verification remain enabled. API requests
use an undici Agent scoped to the instance, and authenticated requests cannot
follow redirects. Repository pods receive a URL-scoped Git `sslCAInfo` setting
before cloning. The GitLab CLI receives the same instance API prefix and a
[per-host CA setting](https://docs.gitlab.com/cli/connection/#use-self-signed-certificates);
other hosts keep their existing certificate trust. Running pods
receive the updated certificate on their next run; recreate a pod if its initial
clone failed before the instance was configured. SSH clones retain SSH's normal
host-key verification.

The optional **Default token** is encrypted at rest with the same AES-GCM
mechanism as other Optio secrets, bound to the instance's row. The API returns
only whether a token is saved. Leaving the field blank on edit preserves it;
**Remove saved token** clears it. Changing a URL requires entering the token
again or removing it, so an existing credential is never silently sent to a new
server. Project or group access tokens are useful defaults for automated work;
grant only the API and repository permissions the work needs. Personal and OAuth
access tokens are also supported; Optio does not automatically refresh tokens
entered here.

**Test connection** tests the form before saving. It requests both
`GET <base URL>/api/v4/version` and `/user`, and shows the version and token's
username. API permission errors and certificate failures are reported without
returning tokens or response bodies. Testing or saving a server is restricted
to deployment admins; signed-in users can read the server names and URLs for
repository selection. In a deployment with multiple API replicas, changes reach
all replicas within five seconds.

Saved instances participate in repository platform detection, API base URL
construction, automatic webhook registration and repair, the Add repository
browser's instance switch, GitLab issue providers, and pod git credential
lookup. For an issue provider, enter the instance's host or full base URL in
its **GitLab host** field; Optio uses the instance base URL, CA and default
token when the provider has no explicit token. Existing outbound URL policies
still apply to issue-provider requests.

Tokens resolve at the work's team scope first (for team work), otherwise at the
person's scope, then from the instance default, then the existing workspace /
global secrets and environment. At each existing scope,
`GITLAB_TOKEN_<HOST>` precedes `GITLAB_TOKEN`; `<HOST>` is the uppercase host
and port with punctuation replaced by underscores, such as
`GITLAB_TOKEN_GIT_EXAMPLE_COM_8443`. An instance default is used only for its
own exact host and port.

## Environment and Helm configuration

No instance is added automatically, and an empty app-managed list leaves
existing GitLab configuration in effect. `GITLAB_HOSTS` (or its
`OPTIO_GITLAB_HOSTS` alias), `GITLAB_HOST`, host-qualified tokens and
`GITLAB_TOKEN` continue to work. Servers named by environment variables or the
setup wizard's `GITLAB_HOST` secret appear in the list as **From the deployment
· read only**; edit them in their original configuration. Existing CA bundles
continue to use `NODE_EXTRA_CA_CERTS` on the API and the chart's Git CA settings
in pods. Instance changes require no Helm upgrade or API restart.

To remove an app-managed instance, choose **Remove**. Its encrypted default
token and instance-specific API CA dispatcher are removed as well. Repositories
and issue providers remain configured; add replacement host/token/trust
configuration before starting more work against that server.
