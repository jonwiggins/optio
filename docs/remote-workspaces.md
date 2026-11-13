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

Remote workspaces are off by default. A deployment admin enables them in
Settings → Access → Remote workspaces, or sets `OPTIO_REMOTE_WORKSPACES=true`.
The saved switch overrides the environment. If the database cannot be read,
provider operations are refused, including when the environment says on.
That includes stopping or deleting a workspace when its work ends: switching
remote workspaces off (or a database blip) leaves workspaces Optio already
started running until their TTL. With the switch off their pairing tokens are
still revoked; stop them at the provider if they should not wait for the TTL.
Only members and admins may use the provider template/workspace pickers.

**Coder trust boundary:** pairing currently uses a full-scope personal access
token, expiring after the workspace TTL plus one hour. Coder rich parameters
and Terraform state can expose it to whoever controls the connection's Coder
account or infrastructure. On an organization Coder connection, those operators
can act as the member who starts work, including accessing private work and
secrets. Use a private connection unless every member trusts those operators.
Revoking the pairing token ends that access. Personal work on a trigger or
a schedule mints this token for the work's owner each time it fires,
unattended, with the same full scope. Organization work has no owner, and any
workspace admin may edit it, so a Job or a scheduled Task that belongs to the
organization can't run in a remote workspace at all: saving one is refused,
and a firing of one saved earlier fails with the reason instead of minting
anyone's token. A Task someone starts now mints for that person. The daemon
reads `OPTIO_TOKEN` from the environment; do not pass it in process
arguments.

Private connections are visible only to their owner: even workspace admins
cannot read another person's private connection. This is stricter than the
admin read-only visibility described for other resources in [scope.md](scope.md).

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
  adds it), and one per provider per person (with their own token). Work
  uses the one it names, else the person's, else the organization's. A person
  sees the organization's and their own.
- **New work → Where → A remote workspace** (next to Optio pod and My
  machine): the connection, then **New** (the template, its parameters, an
  optional name) or **Existing** (one of the token's workspaces, running or
  stopped), and the checkout. A Task also takes the **Repository** (the
  PR's repo, sent as `where.repoUrl` and as the `repo_url` parameter). Optio
  then:
  1. mints a personal access token for the work's owner, or for the person
     starting organization work now (`api_keys`, named
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
  Only personal work may do this (see the Coder trust boundary above).
- The daemon learns its identity from the environment:
  `OPTIO_LOCAL_HOST_ID` (the pre-registered machine, matched by id, not by
  hostname) and `OPTIO_LOCAL_HOSTNAME` (the machine's name in Optio).

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
  nohup ~/.optio/bin/optio --server "$OPTIO_SERVER"  local up \
    --no-remote-dirs --dir "${OPTIO_CHECKOUT_DIR:-/home/coder/repo}" --name "$OPTIO_LOCAL_HOSTNAME" \
    > /tmp/optio-local.log 2>&1 &
fi
```

with the Terraform parameters `optio_server`, `optio_token` (ephemeral,
`mutable = true`) and `optio_host_id` passed into the agent's `env`, and
`optio_checkout_dir` when the checkout isn't `/home/coder/repo`. A
`repo_url` parameter, by convention, is the repo to clone: a Task passes its
repository there.
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
Node.js 20+, git, curl (or wget) and tar.
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

1. stops an earlier start's daemon (its token is revoked by now);
2. clones `OPTIO_REPO_URL` into `OPTIO_CHECKOUT_DIR` when that directory is
   empty (the image's or provider's git credentials apply);
3. installs the CLI from the server (`/api/cli/install.sh`) and starts
   `optio local up --no-remote-dirs --dir <checkout> --name <name>`,
   detached, logging to `/tmp/optio-local.log`.

Without the bundle it does nothing. Daytona and E2B run it as
`nohup sh -c "$OPTIO_START_SCRIPT" >>/tmp/optio-local.log 2>&1 &` with the
script and the bundle in the environment, so the command line carries no
secret.

The CLI is served by the API itself, unauthenticated and rate-limited, so a
workspace needs nothing from outside the network: `GET /api/cli/install.sh`
(downloads from `$OPTIO_SERVER`, default the server it came from; installs
into `$OPTIO_HOME`, default `~/.optio`) and `GET /api/cli/optio-cli.tgz`.
The same downloads install the CLI on a developer's own computer
([optio-local.md](optio-local.md#cli)).

### The CLI bundles

Each bundle is `apps/cli` bundled into one `dist/optio.js` with its two
native-side dependencies, `ws` and `node-pty`, built by
`scripts/build-cli-tarball.sh [--platform linux|darwin|win32]` in the API
image (`Dockerfile.api`, stage `cli-build`) into `/app/static/`:

| Bundle                 | Route                               | node-pty's native part                                      | Moved by                   |
| ---------------------- | ----------------------------------- | ----------------------------------------------------------- | -------------------------- |
| `optio-cli.tgz`        | `GET /api/cli/optio-cli.tgz`        | `pty.node` compiled in the image, for the image's CPU       | `OPTIO_CLI_TARBALL`        |
| `optio-cli-darwin.tgz` | `GET /api/cli/optio-cli-darwin.tgz` | node-pty's own prebuilds, macOS x64 and arm64               | `OPTIO_CLI_TARBALL_DARWIN` |
| `optio-cli-win32.tgz`  | `GET /api/cli/optio-cli-win32.tgz`  | node-pty's own prebuilds, Windows x64 and arm64 (no `.pdb`) | `OPTIO_CLI_TARBALL_WIN32`  |

The macOS and Windows bundles need no compiler and no network: the prebuilt
binaries are part of node-pty's npm package, so they come from the same
lockfile install (and the same offline pnpm store) as everything else. The
build can't run them on Linux, so it checks that their script parses and
that every file node-pty loads on that OS is present; the Linux bundle is
also run. `install.sh` picks the macOS bundle when `uname -s` is `Darwin`
and sends Git Bash, MSYS and Cygwin shells to `install.ps1`, which
downloads the Windows bundle with `Invoke-WebRequest`, unpacks it with
Windows' own `tar.exe` (Windows 10 1803 or later) and writes
`~\.optio\bin\optio.cmd`. `GET /api/cli/downloads` says which bundles are
present (`{ "bundles": { "linux": true, "darwin": true, "win32": true } }`),
for the pairing guide. A missing bundle answers 404 with the command that
builds it.

Not built: a Linux bundle for the other CPU (`pty.node` is compiled for the
image's own architecture; a multi-arch image build serves each architecture
its own), and a bundle for any OS node-pty ships no binary for.

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
  organization's), New or Existing, the template (snapshot,
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
