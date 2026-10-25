# Remote workspaces: an agent working in a hosted development workspace

Optio can start a piece of work **in a remote workspace** — a workspace a
provider hosts, made from your template, image or repository. Optio creates
(or starts) the workspace, the workspace pairs itself with Optio as a
machine, and the agent runs there the way work runs on a paired laptop
([optio-local.md](optio-local.md)): in that environment, with its tools and
network. The workspace needs only Node.js 20+, git, curl and the agent CLI;
Optio brings its own CLI.

Four providers, each one a connection type:

| Provider                                                    | A workspace is    | Made from    | How it pairs                                                      |
| ----------------------------------------------------------- | ----------------- | ------------ | ----------------------------------------------------------------- |
| [Coder](https://coder.com)                                  | a Coder workspace | a template   | its startup script, with the bundle in the template's parameters  |
| [Daytona](https://www.daytona.io)                           | a sandbox         | a snapshot   | the start script, run by Optio through the sandbox's toolbox      |
| [E2B](https://e2b.dev)                                      | a sandbox         | a template   | the start script, run by Optio through the sandbox's envd         |
| [GitHub Codespaces](https://github.com/features/codespaces) | a codespace       | a repository | its dev container's postStartCommand, with the bundle in a secret |

Nothing of this is on until someone adds a connection (Settings →
Integrations → Remote workspaces). Without one, the New work form's
"A remote workspace" only says how to add one.

## How it fits

- A remote workspace is a **machine** (`local_hosts`, `origin` = the
  provider's id). The Optio Local daemon (`optio local up`) runs in it,
  connects out to Optio, and runs work in the workspace's checkout.
  Everything Optio Local offers — terminals, agent sessions, headless runs,
  transcripts, usage — works unchanged.
- A **connection** (`remote_workspace_connections`) is one provider account:
  the provider, its API's URL (blank = the provider's own, except Coder's,
  which a site runs itself), a token (sealed on the row; only its last four
  characters are ever shown), a CA bundle for a private CA, an optional
  organization, the default template and its parameters, the checkout, a
  TTL, and whether a workspace is deleted rather than stopped when the work
  ends. There is one per provider for the organization (a workspace admin
  adds it), one per provider per team (its team admins), and one per
  provider per person (with their own token). Work uses the one it names,
  else the person's, else their team's, else the organization's. A person
  sees the organization's, their teams' (while they are in the team) and
  their own.
- **New work → Where → A remote workspace** (next to Optio pod and My
  machine): the connection, then **New** (the template, its parameters, an
  optional name) or **Existing** (one of the token's workspaces, running or
  stopped), and the checkout. A Task also takes the **Repository** (the
  PR's repo, sent as `where.repoUrl` and as the `repo_url` parameter). Optio
  then:
  1. mints a personal access token for the work's owner (`api_keys`, named
     `<provider>:<workspace>`, expiring an hour after the connection's TTL),
     pre-registers the machine (`local_hosts`, the checkout as its one
     directory) and makes the **pairing bundle**: `OPTIO_SERVER`,
     `OPTIO_TOKEN`, `OPTIO_LOCAL_HOST_ID`;
  2. creates the workspace (or starts an existing one) and hands it the
     bundle the provider's way (below). An existing workspace that is
     already running and paired is used as it is: no new token, no restart,
     and Optio leaves it running afterwards;
  3. creates the work at once as Local work on that machine (`run_target:
"local"`, `local_host_id`, `local_dir` = the checkout) and keeps the
     launch on the row (`remote_workspace_launch`). The run **parks** until
     the workspace's daemon says hello, as a run on an offline laptop does.
     A watcher (every 30 s) fails the parked run with the reason when the
     workspace fails, or when it hasn't paired within
     `OPTIO_REMOTE_WORKSPACE_START_TIMEOUT_MS` (15 minutes);
  4. when the work is done, stops the workspace — or deletes it with "Delete
     when the work ends" — revokes the pairing token and marks the machine
     offline: a Job when its run ends, a Task when it is **completed, failed
     or cancelled**, each only while no other run uses the workspace and no
     other Task there is still open. A Task that opened a merge request may
     still resume there (CI failure, review feedback), so its workspace stays
     up; the watcher stops a paired workspace nothing ran in for
     `OPTIO_REMOTE_WORKSPACE_IDLE_STOP_MS` (2 hours) instead.
- **Re-runs, retries and resumes** go to the same machine, which is usually
  stopped by then. At dispatch, a run whose machine is an offline remote
  workspace starts it again with a fresh bundle and parks until the daemon's
  hello. A workspace already starting is left to come up (one dispatcher
  wakes it); one that is gone at the provider is made again from the launch.
- **Work on a trigger or a schedule** is saved with its launch and no
  machine (the connection must exist then); its workspace is made when it
  first fires and pinned on the definition, so later firings wake that one.
- The daemon learns its identity from the environment:
  `OPTIO_LOCAL_HOST_ID` (the pre-registered machine, matched by id, not by
  hostname) and `OPTIO_LOCAL_HOSTNAME` (the machine's name in Optio).
- **The agent policy** ([agent-policy.md](agent-policy.md)): Claude Code's
  managed settings and OpenCode's managed config reach the workspace as
  `optio_claude_managed_settings` / `optio_opencode_managed_config` (a Coder
  template's parameters) or `OPTIO_CLAUDE_MANAGED_SETTINGS` /
  `OPTIO_OPENCODE_MANAGED_CONFIG` (the start script's environment), and are
  written read-only to `/etc/claude-code/managed-settings.json` and
  `/etc/opencode/opencode.json`, the tier a repo's own settings can't
  override. Blank = no rules (an earlier start's files go).

## The providers

### Coder

|                       |                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connection            | the Coder URL; a **session token** (`coder tokens create`); the organization's ID (blank = the token user's default)                                                                                                     |
| Templates             | the organization's templates; a template's **rich parameters** as a form                                                                                                                                                 |
| A workspace           | `POST /api/v2/users/me/workspaces` with the template's active version, the connection's default parameters under the work's own, and the TTL (`ttl_ms`)                                                                  |
| The bundle            | as rich parameter values `optio_server`, `optio_token`, `optio_host_id` (and `optio_checkout_dir`), only those the template declares — Coder refuses others; a template without `optio_token` is refused with the reason |
| Start / stop / delete | `POST /api/v2/workspaces/{id}/builds` with `transition: start` (and the mutable parameters), `stop` or `delete`                                                                                                          |
| Existing workspaces   | the token user's (`owner:me`); one Optio paired as another person's machine stays theirs                                                                                                                                 |
| Default checkout      | `/home/coder/repo`                                                                                                                                                                                                       |

The template's startup script installs the CLI and starts the daemon when
Optio filled the parameters:

```sh
if [ -n "${OPTIO_TOKEN:-}" ]; then
  curl -fsSL "${OPTIO_SERVER}/api/cli/install.sh" | sh      # ~/.optio/bin/optio (Node 20+)
  export OPTIO_LOCAL_HOST_ID OPTIO_LOCAL_HOSTNAME="${CODER_WORKSPACE_NAME}"
  nohup ~/.optio/bin/optio --server "$OPTIO_SERVER" --api-key "$OPTIO_TOKEN" local up \
    --no-remote-dirs --dir "${OPTIO_CHECKOUT_DIR:-/home/coder/repo}" --name "$OPTIO_LOCAL_HOSTNAME" \
    > /tmp/optio-local.log 2>&1 &
fi
```

with the Terraform parameters `optio_server`, `optio_token` (ephemeral,
`mutable = true`) and `optio_host_id` passed into the agent's `env`, and
`optio_checkout_dir` when the checkout isn't `/home/coder/repo`. A
`repo_url` parameter, by convention, is the repo to clone: a Task passes its
repository there. The policy parameters above are `mutable = true` too.
[`examples/coder/optio-workspace/`](../examples/coder/optio-workspace) is a
complete Kubernetes template, including a private CA for the workspace.

### Daytona

|                       |                                                                                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection            | the Daytona API (blank = `https://app.daytona.io/api`); an **API key** with sandbox write and delete permissions; optionally the organization's ID (sent as `X-Daytona-Organization-ID`)                                                             |
| Templates             | the organization's active **snapshots** (`GET /snapshots`); parameters: `repo_url` and `target` (the region)                                                                                                                                         |
| A workspace           | `POST /sandbox` with the snapshot, the name, the label `optio-host-id`, and the TTL as `autoStopInterval` in minutes (blank = 0, never: Optio stops it when the work ends)                                                                           |
| The bundle            | Optio waits until the sandbox is `started`, then runs the start script through its toolbox (`POST {toolboxProxyUrl}/{sandboxId}/process/execute`), the bundle in the command's environment — never in the sandbox's own `env`, which the API returns |
| Start / stop / delete | `POST /sandbox/{id}/start`, `POST /sandbox/{id}/stop`, `DELETE /sandbox/{id}`; a started sandbox gets the start script again with a fresh bundle                                                                                                     |
| Existing workspaces   | the organization's sandboxes (`GET /sandbox`); Daytona sandboxes have no owner, so any of them may be picked (one paired as another person's machine stays theirs)                                                                                   |
| Default checkout      | `/home/daytona/repo`                                                                                                                                                                                                                                 |

Daytona counts the auto-stop interval from the sandbox's last activity.
The snapshot's image needs Node.js 20+, git, curl and the agent CLI, and
root or passwordless `sudo` when the agent policy has rules.
[`examples/daytona/`](../examples/daytona) has an image for a snapshot.

### E2B

|                       |                                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection            | the E2B API (blank = `https://api.e2b.app`); an **API key**                                                                                                                                                                       |
| Templates             | the team's templates with a ready build (`GET /v2/templates`); parameter: `repo_url`                                                                                                                                              |
| A workspace           | `POST /v2/sandboxes` with the template, `timeout` = the TTL in seconds (blank = 1 hour) and `autoPause: true` — at the end of its time a sandbox is paused, not killed — and the name in its metadata                             |
| The bundle            | the start script, run through the sandbox's envd (`process.Process/Start`, a Connect server-streaming call to `https://49983-{sandboxID}.{domain}` with the sandbox's `envdAccessToken`), the bundle in the process's environment |
| Start / stop / delete | `POST /v2/sandboxes/{id}/connect` (resumes a paused sandbox), `POST /sandboxes/{id}/pause`, `DELETE /sandboxes/{id}`; a resumed sandbox gets the start script again (its earlier daemon is stopped first: its token was revoked)  |
| Existing workspaces   | the team's running and paused sandboxes (`GET /v2/sandboxes`); no owner, as Daytona                                                                                                                                               |
| Default checkout      | `/home/user/repo`                                                                                                                                                                                                                 |

E2B's own plans cap a sandbox's time (one hour on Hobby, 24 on Pro): set
the connection's TTL to the longest run. E2B answers no "who am I" for an
API key, so Test lists a template to prove the key and shows no account.
[`examples/e2b/`](../examples/e2b) has a template, built with E2B's SDK.

### GitHub Codespaces

|                       |                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection            | GitHub's REST API (blank = `https://api.github.com`); a **personal access token** with the `codespace` scope (classic), or, fine-grained: Codespaces (write), Codespaces lifecycle admin (write) and Codespaces metadata (read) on the repositories, and Codespaces user secrets (write); optionally an organization, whose repositories the template list shows |
| Templates             | **repositories** (the token's, or the organization's); parameters: the branch (`ref`), the repository's machine types and dev container configurations. A Task's codespace is made for its own repository                                                                                                                                                        |
| A workspace           | `POST /repos/{owner}/{repo}/codespaces` with the branch, machine, dev container, the name as `display_name`, and the TTL as `idle_timeout_minutes` (5 minutes to 4 hours; blank = 4 hours)                                                                                                                                                                       |
| The bundle            | sealed (libsodium's sealed box, the user's Codespaces public key) into a **Codespaces user secret** named for the codespace, `OPTIO_PAIRING_<NAME>`, visible to its repository only. The dev container's `postStartCommand` reads it and runs the start script. Optio deletes the secret once the daemon said hello, and when the pairing ends                   |
| Start / stop / delete | the secret first, then `POST /user/codespaces/{name}/start` (a running codespace is stopped first: secrets reach a codespace when it starts); `POST …/stop`; `DELETE /user/codespaces/{name}`                                                                                                                                                                    |
| Existing workspaces   | the token user's codespaces (`GET /user/codespaces`)                                                                                                                                                                                                                                                                                                             |
| Default checkout      | `/workspaces/<repository>`                                                                                                                                                                                                                                                                                                                                       |

A Codespaces connection is **a person's own**: GitHub hands the user's
secrets to every codespace of that user and repository, so one connection
can't serve several people. GitHub stops a codespace after its idle timeout
of no terminal or editor activity — a running agent doesn't count — at most
4 hours. A new codespace's name is known only once GitHub accepted it, so
Optio writes its secret right after the create, while GitHub still
provisions it; one that came up before its secret doesn't pair, the start
timeout fails the run with the reason, and a re-run (a restart) picks the
secret up. [`examples/codespaces/`](../examples/codespaces) has the dev
container configuration.

## The start script

Daytona, E2B and Codespaces workspaces run the same POSIX script
(`services/remote-workspaces/start-script.ts`; also served, public, at
`GET /api/cli/workspace-start.sh`). With `OPTIO_SERVER`, `OPTIO_TOKEN` and
`OPTIO_LOCAL_HOST_ID` in its environment it:

1. writes the agent policy (above) as root or with `sudo -n` — and stops,
   without starting the daemon, when rules can't be written;
2. stops an earlier start's daemon (its token is revoked by now);
3. clones `OPTIO_REPO_URL` into `OPTIO_CHECKOUT_DIR` when that directory is
   empty (the image's or provider's git credentials apply);
4. installs the CLI from the server (`/api/cli/install.sh`) and starts
   `optio local up --no-remote-dirs --dir <checkout> --name <name>`,
   detached, logging to `/tmp/optio-local.log`.

Without the bundle it does nothing. Daytona and E2B run it as
`nohup sh -c "$OPTIO_START_SCRIPT" >>/tmp/optio-local.log 2>&1 &` with the
script and the bundle in the environment, so the command line carries no
secret.

The CLI is served by the API itself, unauthenticated and rate-limited, so a
workspace needs nothing from outside the network: `GET /api/cli/install.sh`
(downloads from `$OPTIO_SERVER`, default the server it came from; installs
into `$OPTIO_HOME`, default `~/.optio`) and `GET /api/cli/optio-cli.tgz` —
`apps/cli` bundled into one `dist/optio.js` with its two native-side
dependencies, `ws` and `node-pty` with a Linux `pty.node`, built by
`scripts/build-cli-tarball.sh` in the API image (`Dockerfile.api`,
stage `cli-build`) at `/app/static/optio-cli.tgz` (`OPTIO_CLI_TARBALL`
points elsewhere).

## Reaching the provider

Every call goes through the outbound URL guard: a provider inside the
network must be allowed (`OPTIO_OUTBOUND_ALLOWED_HOSTS`, or the in-cluster
allowance), with the connection's CA (`caPem`; "Skip TLS verification" for
testing only), and no redirect is followed (the token travels in a header).
Daytona's toolbox and E2B's envd answer on their own hosts
(`toolboxProxyUrl`, `49983-<id>.<domain>`), which the guard vets as well.
The workspace itself must reach Optio at `PUBLIC_URL` / `PUBLIC_API_URL`:
that is where its daemon connects.

## In the web app

- **Settings → Integrations → Remote workspaces**
  (`components/settings/remote-workspace-connections.tsx`): the visible
  connections with their provider and whose each is (Organization / Team /
  Private); **Add connection** (the provider, name, URL, token, CA,
  "Skip TLS verification" with a warning, who it's for) saves and tests it.
  The token is write-only: a blank token field on Edit keeps it. Once a test
  reached the provider, Edit offers the organization, the default template
  and its parameters, the checkout, the TTL in hours and "Delete the
  workspace when the work ends".
- **New work → Where → A remote workspace**
  (`components/remote-workspaces/`): the connection (yours first, then a
  team's, then the organization's), New or Existing, the template (snapshot,
  repository) and its parameters, the checkout, and for a Task the
  Repository. It sends `runTarget: "local"` with `where.remoteWorkspace`,
  whatever starts the work. An edit keeps a saved remote workspace but
  doesn't move saved work that runs elsewhere onto one. With it, Then can't
  be "Wait for me".
- **Machines**: a remote workspace's machine carries its provider and name,
  and **Stop workspace** (E2B: **Pause workspace**) through the connection
  that started it; that also revokes its pairing token, as unpairing does.

## The API

Optio's routes (`apps/api/src/routes/remote-workspaces.ts`):

| Route                                                              |                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `GET /api/remote-workspaces/providers`                             | the providers and their words                                                    |
| `GET`, `POST /api/remote-workspaces/connections`                   | list (`?provider=`), add (`provider`, `name`, `url`, `token`, `owner`, …)        |
| `PATCH`, `DELETE /api/remote-workspaces/connections/:id`           | change, remove                                                                   |
| `POST …/:id/test`                                                  | sign in with the stored token (a failure is `ok: false` with the reason)         |
| `GET …/:id/templates`, `GET …/:id/templates/:versionId/parameters` | the templates, a template's parameters (`setByOptio` marks the ones Optio fills) |
| `GET …/:id/workspaces`, `POST …/:id/workspaces/:wsId/stop`         | the token's workspaces; stop one                                                 |

`/api/coder/connections` and the routes under it, from when Coder was the
only provider, answer the same (their list is the Coder connections, and a
connection added there is a Coder one); they are left out of the OpenAPI
document. A piece of work asks for a workspace with `where.remoteWorkspace`
in `POST /api/work` (`provider`, `connectionId`, `workspaceId` or
`templateId` / `templateVersionId`, `parameters`, `name`, `checkoutDir`);
`where.coder` is the same with `provider: "coder"`. A host in
`GET /api/local/hosts` carries `origin` (the provider), `remoteWorkspaceId`,
`remoteWorkspaceName` and `remoteWorkspaceConnectionId`. Every change to a
connection is in the audit trail (`remote_workspace_connection.create`,
`.update`, `.delete`; never the token).

## Settings

| Variable                                   | Default    |                                                                                   |
| ------------------------------------------ | ---------- | --------------------------------------------------------------------------------- |
| `OPTIO_REMOTE_WORKSPACE_START_TIMEOUT_MS`  | 15 minutes | how long a workspace may take to pair before its parked runs fail                 |
| `OPTIO_REMOTE_WORKSPACE_IDLE_STOP_MS`      | 2 hours    | a paired workspace nothing ran in for this long is stopped                        |
| `OPTIO_REMOTE_WORKSPACE_WATCH_INTERVAL_MS` | 30 seconds | the watcher's period (one instance at a time, the `remote-workspace-watch` lease) |

Each is also read under its earlier name, `OPTIO_CODER_START_TIMEOUT_MS`,
`OPTIO_CODER_IDLE_STOP_MS` and `OPTIO_CODER_WATCH_INTERVAL_MS`.

Monitoring ([observability.md](observability.md#prometheus-endpoint-and-dashboard)):
`optio_remote_workspaces_starting` and
`optio_remote_workspace_start_wait_seconds` (gauges),
`optio_remote_workspace_start_failures_total` (counter) and
`optio_remote_workspace_start_seconds` (histogram, until the daemon's first
hello), each by `provider`; credential health checks each connection's token
(kind `remote_workspace`; the expiry where the provider says: Coder's key,
GitHub's `github-authentication-token-expiration` header, Daytona's API key).

## What the implementations were checked against

Each provider follows its published API reference. The tests run against
stand-ins, not the live services: Coder's REST calls against a stand-in
fetch (`remote-workspace-service.test.ts`, `.int.test.ts`), and the
Daytona, E2B and GitHub Codespaces clients against in-process fakes of
those APIs (`apps/api/src/test-utils/fake-daytona.ts`, `fake-e2b.ts`,
`fake-github-codespaces.ts`):

- Coder: its REST API reference (`https://coder.com/docs/reference/api`).
- Daytona: the API's and the toolbox's OpenAPI documents
  (`https://www.daytona.io/docs/openapi.json`, `toolbox-openapi.json`).
- E2B: `spec/openapi.yml` and `spec/envd/process/process.proto` in
  github.com/e2b-dev/E2B, and how its JS SDK addresses envd (the host, the
  headers, the Connect envelopes).
- GitHub: the REST reference for codespaces, codespaces machines and
  Codespaces user secrets (API version 2022-11-28), and "Encrypting secrets
  for the REST API" — the sealed box is checked byte for byte against
  another implementation's output (`sealed-box.test.ts`).
