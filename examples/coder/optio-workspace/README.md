# optio-workspace: a Coder template Optio can run work in

A Kubernetes [Coder](https://coder.com) template whose workspaces pair
themselves with Optio as a machine (docs/remote-workspaces.md, "Coder").
Pick **Where → A remote workspace** in New work and Optio creates one from this template (or starts
one of yours), the agent works in its checkout, and the workspace stops — or
is deleted — when the work is done (a Task once it is completed, failed or
cancelled; one that waits on its merge request stops after two idle hours and
starts again when the Task resumes).

```
optio-workspace/
  main.tf     # the template: parameters, the agent's startup script, a pod with a home volume
  README.md
```

## What a workspace does when it starts

1. With `git_token` set, git asks for credentials for the repo's host and
   gets the token from the environment (nothing is written to disk).
   Without one, git uses the workspace's own credentials — Coder external
   auth, or SSH.
2. Clones `repo_url` into `optio_checkout_dir` (`/home/coder/repo`) once;
   the home volume keeps it across restarts.
3. When Optio filled `optio_token`: installs the Optio CLI from the Optio
   server itself (`curl -fsSL $OPTIO_SERVER/api/cli/install.sh | sh`, into
   `~/.optio`) and runs the daemon in the background:

   ```sh
   optio --server "$OPTIO_SERVER" --api-key "$OPTIO_TOKEN" \
     local up --no-remote-dirs --dir "$CHECKOUT" --name "$OPTIO_LOCAL_HOSTNAME" \
     > /tmp/optio-local.log 2>&1 &
   ```

   `OPTIO_LOCAL_HOST_ID` tells the daemon the machine Optio registered for
   the workspace; `--name` (the workspace's name, `OPTIO_LOCAL_HOSTNAME`) is
   its name in Optio. `--no-remote-dirs` keeps Optio from adding
   directories; the checkout is offered with `--dir`.

A workspace someone makes by hand gets blank `optio_*` parameters and is a
plain workspace: nothing is installed and nothing pairs.

## Parameters

| Parameter            | Who sets it | Notes                                                                                                 |
| -------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `cpu`, `memory`      | you         | The pod's limits                                                                                      |
| `home_disk_size`     | you         | The home volume, in GiB (fixed after create)                                                          |
| `repo_url`           | you / Optio | HTTPS URL to clone. A Task in Optio passes its repository here                                        |
| `git_token`          | you         | Optional. Visible to the workspace's owner and template admins in Coder — prefer Coder external auth  |
| `optio_server`       | Optio       | The Optio API as the workspace reaches it                                                             |
| `optio_token`        | Optio       | A personal access token minted for this workspace (`coder:<name>`); `ephemeral`, so no build keeps it |
| `optio_host_id`      | Optio       | The machine Optio registered for the workspace                                                        |
| `optio_checkout_dir` | Optio       | Where the repo is checked out; the agent works there                                                  |

Optio sends only the parameters a template declares, and refuses a template
without `optio_token`. For an existing workspace it can only change mutable
parameters, so every `optio_*` parameter here is `mutable = true`.

## The image

The default, `codercom/enterprise-node:ubuntu`, has Node.js, git and curl.
The agent CLI must be on `PATH` too — `claude` (Claude Code) and/or
`opencode`, as for a paired laptop (docs/optio-local.md) — so in practice
you build an image from it with the CLI installed and pass it as `image`.
Optio's own agent image (`optio-agent-base`, which the Optio package already
carries) has all of them. In a cluster with no internet access, mirror the
image into your registry (`image_pull_secret` when it needs a login); the
Optio CLI needs nothing from outside, since the Optio API serves it.

## A private CA

When Coder, Optio, the git server or the model gateway have certificates
from an internal CA, every TLS client in the workspace has to trust it, from
the first second: the Coder agent's download (`curl $CODER_URL/bin/...` in
the agent's init script) and the agent itself, `curl $OPTIO_SERVER/api/cli/install.sh`,
`git clone`, and Node (the Optio daemon, Claude Code). Name the CA with
`ca_configmap` — a ConfigMap in the workspaces' namespace with the PEM under
`ca.crt` (`ca_configmap_key`) — or give the PEM itself in `ca_pem` (each
workspace then gets a ConfigMap with it; the provisioner needs to create
ConfigMaps there). Then, as in Optio's own agent pods:

- an init container (`ca-bundle`, the workspace image) writes
  `/etc/optio/ca/bundle.crt` — the image's CA bundle with the internal CA
  appended, so public CAs keep working where they are reachable — and
  `/etc/optio/ca/internal.crt`, the internal CA alone;
- `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE`,
  `PIP_CERT`, `CARGO_HTTP_CAINFO` and `AWS_CA_BUNDLE` point at the bundle and
  `NODE_EXTRA_CA_CERTS` at the internal CA — for the container's command, so
  the Coder agent, its startup script and everything they start have them.

Names like `optio.example.com` resolve through the cluster's DNS, as for
any pod: the template adds no host aliases.

## Template variables

Set when the template is pushed (`--variable name=value`):

| Variable            | Default                           | Notes                                                              |
| ------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `namespace`         | (required)                        | Where workspaces are created; the provisioner needs rights there   |
| `image`             | `codercom/enterprise-node:ubuntu` | The workspace image (above)                                        |
| `image_pull_secret` | none                              | A docker-registry Secret in `namespace` to pull `image` with       |
| `storage_class`     | the cluster's default             | The home volume's storage class                                    |
| `use_kubeconfig`    | `false`                           | `~/.kube/config` on the provisioner instead of its service account |
| `ca_configmap`      | none                              | A ConfigMap with an internal CA to trust (above)                   |
| `ca_configmap_key`  | `ca.crt`                          | Its key                                                            |
| `ca_pem`            | none                              | Or the CA's PEM itself                                             |

## Push it

```sh
coder templates push optio-workspace -d examples/coder/optio-workspace \
  --variable namespace=coder \
  --variable image=registry.example.com/dev/optio-workspace:1 \
  --variable ca_configmap=private-ca   # only with an internal CA
```

The Terraform providers it needs are `coder/coder` and
`hashicorp/kubernetes`. A provisioner without internet installs them from a
filesystem mirror configured on the provisioner (see Coder's offline installation documentation).

Then in Optio, **Settings → Integrations → Remote workspaces → Add
connection → Coder**: the Coder URL, a session token (`coder tokens create`), the CA bundle when
Coder's certificate is from a private CA, and — after **Test** — this
template as the default, with default parameters and how long a workspace
may run.

The Optio server must be reachable from the workspace pods at the address
Optio puts in `optio_server` (the API's `PUBLIC_API_URL`, else
`PUBLIC_URL`), and the Coder host must be allowed by Optio's
outbound policy (`OPTIO_OUTBOUND_ALLOWED_HOSTS`).

## When it doesn't pair

- In the workspace: `cat /tmp/optio-local.log`. The startup script's own
  output is on the workspace's page in Coder.
- `curl -fsSL $OPTIO_SERVER/api/cli/install.sh` failing means the pod can't
  reach Optio at that address. `SSL certificate problem` (curl), `unable to
get local issuer certificate` (Node) or an agent that never connects means
  the internal CA isn't trusted: set `ca_configmap` or `ca_pem` (A private CA).
- The run in Optio fails with the reason when the build fails, or when the
  workspace hasn't paired within 15 minutes (`OPTIO_CODER_START_TIMEOUT_MS`).
