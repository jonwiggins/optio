# Air-gapped installations

These optional scripts prepare dependencies and build Optio images without
internet access. Deployment packages follow in #zarf-rancher.
Normal builds download dependencies and use the complete agent toolchain;
none of the steps below runs automatically.

## Private registry mirror

Mirror each image you enable, then set its chart value. For example:

```yaml
api:
  image: { repository: registry.example.com/optio/api, tag: "1.0.0" }
web:
  image: { repository: registry.example.com/optio/web, tag: "1.0.0" }
agent:
  image:
    repository: registry.example.com/optio/agent-base
    prefix: registry.example.com/optio/agent-
    tag: "1.0.0"
  imagePullPolicy: IfNotPresent
postgresql:
  image: { repository: registry.example.com/base/postgres, tag: "16.15" }
redis:
  image: { repository: registry.example.com/base/redis, tag: "7.4.11-alpine" }
```

Also mirror `agent.envoyProxy.image` when using the secret proxy and
any custom repository images. Configure
`imagePullSecrets` for private image pulls and the container runtime's registry trust:
image pulls happen before a pod can mount a CA.

Runtime connections, package installs and repository setup commands also need
reachable services or mirrored dependencies.

## Offline bundle

On a connected Linux amd64 host with Docker BuildKit, curl, git, gzip, sha256sum
and tar:

```bash
scripts/offline/make-kit.sh 1.0.0 --out /media/kit-1.0.0
# Optional smaller toolchain, with preinstalled MCP servers:
# --agent-clis claude-code,opencode --opencode-install-method npm --preinstall-mcp-servers
```

The bundle contains digest-pinned base and toolchain images, a Linux x64 glibc
pnpm store matching `pnpm-lock.yaml`, a Corepack pnpm archive, Helm, kubectl,
crane, BuildKit's client, Node, an optional runner chart, image SBOMs and Trivy
reports/database. `KIT.md` records the source revision, tool choices and
contents. The source checkout is transferred separately, for example with
`git bundle create optio.bundle --all`. Keep it at the revision in `KIT.md`.
A dependency or toolchain change requires a new bundle.

The scanner checks `scripts/offline/known-bad.txt`; a listed package or digest
fails bundle creation. Vulnerabilities are reported for review in
`offline/scan/SUMMARY.md`. `--skip-scan` is available for trial bundles and is
recorded in `KIT.md`. Verify and optionally sign the bundle using your normal
artifact process before transferring it.

On a host that reaches the destination registry:

```bash
(cd /media/kit-1.0.0/offline && sha256sum -c SHA256SUMS)
export OPTIO_KIT_DIR=/media/kit-1.0.0
export OPTIO_REGISTRY=registry.example.com/optio
scripts/offline/load-kit.sh --dry-run
scripts/offline/load-kit.sh --ca-file /path/to/registry-ca.pem
# For a login: --username USER --password-stdin (provide the password on stdin).
scripts/offline/build-images.sh 1.0.0 --offline --presets --push
```

Loading uses crane by default and needs no Docker daemon. It publishes the
images plus `build/pnpm-offline:1.0.0` and `build/ci-node:1.0.0`, made from the
bundle's files. Building supports Docker buildx or `--buildkit-host` with
buildctl. `--toolchain-version` lets an application rebuild reuse a compatible
bundle. The built images use `optio-api`, `optio-web`, and `optio-agent-*` names;
set the chart repositories accordingly. Read each script's `--help` for
individual image selection, alternate prefixes and manifest output.

Run `scripts/offline/check-offline-build.sh /media/kit-1.0.0` on a disposable
build host to prove that every build step works on a Docker internal network.
It creates a temporary registry and BuildKit daemon, then cleans them up.
Re-scan after transfer without internet access:

```bash
scripts/offline/kit-scan.sh /media/kit-1.0.0 --offline
# Or provide a newer transferred database with --db /media/trivy-db.tgz.
```

## Image build arguments

| Argument                                                                 | Default                        | Purpose                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_CLIS`                                                             | `all`                          | Complete toolchain, or a comma list: `claude-code,codex,pi,copilot,cursor,gemini,openclaw,opencode`. API and compatibility images install the listed runtimes they support. GitHub, GitLab and AWS utilities remain available.   |
| `CLAUDE_CODE_VERSION`                                                    | `2.1.112`                      | Override Claude Code's Bun compatibility pin (the compatibility image keeps its unpinned default). Later releases need testing with your nodes' kernels, especially Linux 7 or newer.                                            |
| `PREINSTALL_MCP_SERVERS`                                                 | `0`                            | On the base agent image, `1` installs pinned Filesystem and PostgreSQL MCP servers and marks the image with `OPTIO_MCP_PREINSTALLED=1`. Configure server commands explicitly; automatic connection selection follows separately. |
| `OPENCODE_INSTALL_METHOD`                                                | `script`                       | Base agent image: `npm` installs the pinned OpenCode npm package, useful with a package mirror.                                                                                                                                  |
| `OPTIO_OFFLINE_FONTS`                                                    | `0`                            | Web build: `1` uses vendored OFL fonts. Otherwise `next/font/google` downloads the usual Google fonts. Also works as an environment variable for `pnpm --filter @optio/web build`.                                               |
| `NODE_SLIM_IMAGE`                                                        | upstream's pinned Node 26 slim | Override the Node base with a mirrored or digest-pinned reference.                                                                                                                                                               |
| `NODE_IMAGE`                                                             | empty                          | API dependency stage: optionally use a full Node image; empty retains the slim base.                                                                                                                                             |
| `UBUNTU_IMAGE`                                                           | upstream's pinned Ubuntu 24.04 | Agent base and compatibility image: mirrored or digest-pinned base.                                                                                                                                                              |
| `PNPM_OFFLINE`                                                           | `0`                            | `1` installs from the named `pnpm-offline` context containing `store/` and `pnpm.tgz`.                                                                                                                                           |
| `API_TOOLCHAIN_IMAGE` / `AGENT_TOOLCHAIN_IMAGE` / `DIND_TOOLCHAIN_IMAGE` | empty                          | Reuse the matching prebuilt third-party stage; the normal path builds it from apt/npm/downloads.                                                                                                                                 |

For an individual web build with a transferred store:

```bash
mkdir -p /tmp/optio-pnpm
tar xzf /media/kit-1.0.0/offline/pnpm-offline-1.0.0.tgz -C /tmp/optio-pnpm
docker buildx build -f Dockerfile.web --network none \
  --build-arg PNPM_OFFLINE=1 --build-arg OPTIO_OFFLINE_FONTS=1 \
  --build-arg NODE_SLIM_IMAGE=registry.example.com/optio/base/node:26-slim-1.0.0 \
  --build-context pnpm-offline=/tmp/optio-pnpm -t optio-web:1.0.0 .
```

Custom MCP servers can be baked into an image, vendored in a repository, or
installed from a mirror. Agent environment variables include
`NPM_CONFIG_REGISTRY`, `PIP_INDEX_URL` and `UV_DEFAULT_INDEX` (uv does not use
`PIP_INDEX_URL`). Pin packages and select a preset containing the needed
interpreter. The REST and controller MCP bridges are bundled independently of
`PREINSTALL_MCP_SERVERS`.

## CLI archive

With Linux dependencies installed and node-pty compiled, run
`scripts/build-cli-tarball.sh /tmp/optio-cli.tgz` to create a standalone CLI
archive. This is a manual artifact; the API image and routes do not publish it.
