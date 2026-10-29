#!/usr/bin/env bash
# The offline kit (docs/air-gapped.md): everything that building,
# testing and deploying this Optio with no internet access needs and the
# source checkout doesn't carry. Run it on the connected side, in a checkout
# of the release:
#
#   scripts/offline/make-kit.sh <version> [options]      → release/kit-<version>/
#     --no-presets       leave out the language preset toolchains
#                        (scripts/offline/presets.txt)
#     --skip-toolchain   reuse the toolchain images already built for <version>
#                        (optio.local/toolchain/*:<version>)
#     --agent-clis <list>        all (default) or a comma-separated runtime list
#     --claude-code-version <v>  override the default 2.1.310
#     --preinstall-mcp-servers   include the built-in MCP server binaries
#     --opencode-install-method <script|npm>  default script
#     --out <dir>        another directory than release/kit-<version>
#     --force            replace an existing kit directory
#     --skip-scan        no SBOMs, scan or known-bad check (a trial kit; KIT.md
#                        says so)
#
# What it makes:
#   KIT.md                               what is in the kit and how to load it
#   offline/pnpm-offline-<version>.tgz   store/ (pnpm fetch, linux x64 glibc) and
#                                        pnpm.tgz (corepack pack): Dockerfile.web
#                                        describes the layout
#   offline/images/*.tar.gz              one image each (docker save, linux/amd64)
#   offline/images.txt                   <kit file> <original ref> <path under ${OPTIO_REGISTRY}>
#   offline/bin/                         helm, kubectl, buildctl, crane, and the
#                                        Node 26 linux x64 tarball
#   offline/charts/                      GitLab Runner's Helm chart
#   offline/sbom/, offline/scan/,        the supply-chain check (scripts/offline/kit-scan.sh):
#   offline/trivy-db.tgz                 an SBOM per image, npm packages and tools; Trivy's
#                                        reports and its database; the known-bad list
#                                        (scripts/offline/known-bad.txt). A match fails the kit.
#   offline/SHA256SUMS                   cd offline && sha256sum -c SHA256SUMS
#
# The images: base/… (the third-party images the Dockerfiles, the chart and
# the CI start from, pinned below; node and ubuntu also tagged
# <tag>-<version>), toolchain/…:<version> (the toolchain stages
# of Dockerfile.api, images/base.Dockerfile, images/dind.Dockerfile and the
# presets, built here). scripts/offline/load-kit.sh pushes them offline and
# builds build/pnpm-offline and build/ci-node there.
#
# Needs: docker with BuildKit (`docker buildx`, or a standalone `buildx` on
# PATH / in $BUILDX; the builder is $BUILDX_BUILDER, default `default`, which
# must see local images), curl, sha256sum, and the internet: Docker Hub, the
# npm registry (NPM_CONFIG_REGISTRY points pnpm fetch at a mirror) and the
# tools' release downloads (cached in release/.kit-cache).
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$PWD"

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

# ── Pinned: what the kit carries besides this source's own images ──
# node:26-slim and ubuntu:24.04 are the Dockerfiles' defaults (read below).
# The full node:26 has the Node of NODE_SLIM_IMAGE on the same Debian: the API
# build stages (NODE_IMAGE) and build/ci-node start from it.
NODE_IMAGE_REF="docker.io/library/node:26.12.1-bookworm@sha256:5c4012d11d9857c42713ba511fbc19645cac1706bb710d51d42b0d301dff7f88"
# <path under ${OPTIO_REGISTRY}> <original reference>. One line per image; a
# new one here is in the next kit. The chart's defaults (postgresql, redis,
# utilityImage, agent.envoyProxy), the CI's job images and services, BuildKit
# (its buildctl is copied into offline/bin), and GitLab Runner with its helper
# for the Kubernetes executor (docs/examples/ci/README.md, "Install the
# runner"; the version the harness tests). A runner should match your
# GitLab's major.minor: change these two lines and RUNNER_CHART_* below
# together.
THIRD_PARTY=(
  "base/postgres:16.15 docker.io/library/postgres:16.15@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97"
  "base/redis:7.4.11-alpine docker.io/library/redis:7.4.11-alpine@sha256:57e4255cc971b1c8d6f8a6ca283ac01bc3ecdd914273ef6bfaede87aaecd6541"
  "base/busybox:1.36 docker.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662"
  "base/envoy:v1.31.10 docker.io/envoyproxy/envoy:v1.31.10@sha256:caa5b411be1633b90023592a34a7e010c933d6e60206c758f631485e53006865"
  "base/postgres:16-alpine docker.io/library/postgres:16-alpine@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36"
  "base/redis:7-alpine docker.io/library/redis:7-alpine@sha256:57e4255cc971b1c8d6f8a6ca283ac01bc3ecdd914273ef6bfaede87aaecd6541"
  "base/buildkit:v0.33.1-rootless docker.io/moby/buildkit:v0.33.1-rootless@sha256:f8a833b2de9d68e27f0815e4a737abdfaf8a2e4c615650557df11025101557b4"
  "base/k8s:1.34.12 docker.io/alpine/k8s:1.34.12@sha256:d50424976a0a888d2531f13035dce45c004ec2b6f877f233005ba35c0d61be5d"
  "base/gitlab-runner:alpine-v19.4.1 docker.io/gitlab/gitlab-runner:alpine-v19.4.1@sha256:4da99e249eb79dc86a27af77b5c5d6cc46445c802b29294441081ae27410159a"
  "base/gitlab-runner-helper:alpine3.21-x86_64-v19.4.1 docker.io/gitlab/gitlab-runner-helper:alpine3.21-x86_64-v19.4.1@sha256:a63132ac2775a9cb41a276f1d87bddcacaa7af77b6c6ead33c3a1a1e668c4a94"
)
# The supply-chain check's scanners (scripts/offline/kit-scan.sh), in the kit
# too, so the operator can scan again with no network: Syft writes the SBOMs,
# Trivy scans them. A new version: the tag and its index digest together.
SYFT_IMAGE="docker.io/anchore/syft:v1.54.1@sha256:3eb5379ba7b409c3f4069b686110527af0c47df993fa5c10d13e7cf34f49b1aa"
TRIVY_IMAGE="docker.io/aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa"
THIRD_PARTY+=(
  "base/syft:v1.54.1 $SYFT_IMAGE"
  "base/trivy:0.75.0 $TRIVY_IMAGE"
)
# The image buildctl comes from (one of the above, so the binary is pinned by its digest).
BUILDKIT_IMAGE="docker.io/moby/buildkit:v0.33.1-rootless@sha256:f8a833b2de9d68e27f0815e4a737abdfaf8a2e4c615650557df11025101557b4"
# Tools for offline/bin: version and the SHA-256 of the download (from each
# project's published checksums). A new version needs its new checksum.
HELM_VERSION=v3.22.0
HELM_SHA256=1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb
KUBECTL_VERSION=v1.34.12
KUBECTL_SHA256=90b7b9058ffeb5c10710bb1c73f541eaf426fb1b4e87df435db669de9a2564a2
CRANE_VERSION=v0.22.1
CRANE_SHA256=0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0
NODE_VERSION=v26.12.1
NODE_SHA256=6170b2d474e1c626f43cff3adc118df9fe3b573258a4fc3d850c8dbc6b079bbd
# GitLab Runner's Helm chart (offline/charts): 0.93.x is runner 19.4 (its
# appVersion 19.4.0; the values in gitlab-ci.md set the 19.4.1 image above).
RUNNER_CHART_VERSION=0.93.0
RUNNER_CHART_SHA256=a8932d04c94724aa93e3147811696e3512df9cbaa5901818d2b3872b0f02f0a9
# The language presets the toolchains cover: scripts/offline/presets.txt, which
# scripts/offline/build-images.sh --presets reads too.
mapfile -t PRESETS < <(sed -e 's/#.*//' -e 's/[[:space:]]//g' -e '/^$/d' scripts/offline/presets.txt)
[ "${#PRESETS[@]}" -gt 0 ] || { echo "scripts/offline/presets.txt lists no preset" >&2; exit 1; }
PLATFORM=linux/amd64

VERSION=""
WITH_PRESETS=1
SKIP_TOOLCHAIN=0
AGENT_CLIS="${AGENT_CLIS:-all}"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.310}"
PREINSTALL_MCP_SERVERS="${PREINSTALL_MCP_SERVERS:-0}"
OPENCODE_INSTALL_METHOD="${OPENCODE_INSTALL_METHOD:-script}"
OUT=""
FORCE=0
SCAN=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-presets) WITH_PRESETS=0 ;;
    --skip-toolchain) SKIP_TOOLCHAIN=1 ;;
    --agent-clis) AGENT_CLIS="${2:?--agent-clis needs a list}"; shift ;;
    --claude-code-version) CLAUDE_CODE_VERSION="${2:?--claude-code-version needs a version}"; shift ;;
    --preinstall-mcp-servers) PREINSTALL_MCP_SERVERS=1 ;;
    --opencode-install-method) OPENCODE_INSTALL_METHOD="${2:?--opencode-install-method needs script or npm}"; shift ;;
    --out) OUT="${2:?--out needs a directory}"; shift ;;
    --out=*) OUT="${1#*=}" ;;
    --force) FORCE=1 ;;
    --skip-scan) SCAN=0 ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [ -n "$VERSION" ]; then echo "One version only (got $VERSION and $1)" >&2; exit 2; fi
      VERSION="$1"
      ;;
  esac
  shift
done
if [ -z "$VERSION" ]; then usage >&2; exit 2; fi
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; then
  echo "Version must be a semantic version, e.g. 1.0.0 (got $VERSION)" >&2
  exit 2
fi

for tool in docker curl sha256sum tar gzip git; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing: $tool" >&2; exit 1; }
done
if docker buildx version >/dev/null 2>&1; then
  BUILDX=(docker buildx)
elif command -v "${BUILDX:-buildx}" >/dev/null 2>&1; then
  BUILDX=("${BUILDX:-buildx}")
else
  echo "BuildKit is required: install the docker buildx plugin, or put a standalone buildx on PATH (or in \$BUILDX)." >&2
  exit 1
fi
# The docker driver: the dind and preset toolchains start from the agent
# toolchain built just before, which only it sees as a local image.
BUILD=("${BUILDX[@]}" build --builder "${BUILDX_BUILDER:-default}" --platform "$PLATFORM" --load)

# The node:26-slim and ubuntu:24.04 the Dockerfiles default to: one pinned
# reference each, in every Dockerfile that names it.
arg_default() { # <file> <arg name>
  sed -n "s/^ARG $2=\(.*\)$/\1/p" "$1" | head -n1
}
NODE_SLIM_REF="$(arg_default Dockerfile.api NODE_SLIM_IMAGE)"
UBUNTU_REF="$(arg_default images/base.Dockerfile UBUNTU_IMAGE)"
[ -n "$NODE_SLIM_REF" ] && [ -n "$UBUNTU_REF" ] || { echo "No NODE_SLIM_IMAGE / UBUNTU_IMAGE default in the Dockerfiles" >&2; exit 1; }
for f in Dockerfile.web images/base.Dockerfile Dockerfile.agent; do
  if [ "$(arg_default "$f" NODE_SLIM_IMAGE)" != "$NODE_SLIM_REF" ]; then
    echo "$f and Dockerfile.api default to different NODE_SLIM_IMAGEs; make them one" >&2
    exit 1
  fi
done
if [ "$(arg_default Dockerfile.agent UBUNTU_IMAGE)" != "$UBUNTU_REF" ]; then
  echo "Dockerfile.agent and images/base.Dockerfile default to different UBUNTU_IMAGEs; make them one" >&2
  exit 1
fi
for ref in "$NODE_SLIM_REF" "$UBUNTU_REF"; do
  case "$ref" in *@sha256:*) ;; *) echo "$ref is not pinned by digest" >&2; exit 1 ;; esac
done

OUT="${OUT:-release/kit-$VERSION}"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  if [ "$FORCE" = 1 ]; then rm -rf "$OUT"; else
    echo "$OUT exists; pass --force to replace it" >&2
    exit 1
  fi
fi
mkdir -p "$OUT/offline/images" "$OUT/offline/bin" "$OUT/offline/charts" release
# Release output never belongs in git (.dockerignore keeps it out of images).
[ -f release/.gitignore ] || printf '*\n' > release/.gitignore
OUT="$(cd "$OUT" && pwd)"
OFF="$OUT/offline"
CACHE="$ROOT/release/.kit-cache"
mkdir -p "$CACHE"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

COMMIT="$(git rev-parse HEAD)"
CHART_VERSION="$(sed -n 's/^version: *//p' helm/optio/Chart.yaml | head -n1)"
if [ "$CHART_VERSION" != "$VERSION" ]; then
  echo "WARNING: helm/optio/Chart.yaml is at ${CHART_VERSION:-?}, not $VERSION" >&2
fi
DIRTY=0
if [ -n "$(git status --porcelain)" ]; then
  DIRTY=1
  echo "WARNING: the working tree has uncommitted changes; the toolchains and the" >&2
  echo "         pnpm store are made from it, not from $COMMIT alone (KIT.md says so)." >&2
fi

step() { echo; echo "##### $*"; }

# images.txt rows, and one kit file per image (two paths may share one).
IMAGES_TXT="$OFF/images.txt"
: > "$IMAGES_TXT"
declare -A SAVED=()
kit_file() { # <path under the registry> → images/<name>.tar.gz
  printf 'images/%s.tar.gz' "$(printf '%s' "$1" | tr '/:@' '---')"
}
save_image() { # <path under the registry> <local or pinned reference>
  local path="$1" ref="$2" key file
  key="${ref##*@}"
  if [ -n "${SAVED[$key]:-}" ]; then
    file="${SAVED[$key]}"
  else
    file="$(kit_file "$path")"
    echo "  $ref → offline/$file"
    # Layers in docker save are mostly compressed already: a fast gzip.
    docker save --platform "$PLATFORM" "$ref" | gzip -1 > "$OFF/$file"
    SAVED[$key]="$file"
  fi
  printf '%s %s %s\n' "$file" "$ref" "$path" >> "$IMAGES_TXT"
}

# ── 1. Toolchain images: the third-party part of every image this source builds ──
TOOLCHAIN_LOCAL="optio.local/toolchain"
toolchain() { # <name> <dockerfile> [build args...]
  local name="$1" file="$2"
  shift 2
  local ref="${TOOLCHAIN_LOCAL}/${name}:${VERSION}"
  if [ "$SKIP_TOOLCHAIN" = 1 ]; then
    docker image inspect "$ref" >/dev/null 2>&1 || { echo "Not built: $ref (drop --skip-toolchain)" >&2; exit 1; }
    echo "  reusing $ref"
    return
  fi
  echo
  echo "=== $ref  ($file${*:+ $*}, AGENT_CLIS=$AGENT_CLIS)"
  "${BUILD[@]}" -f "$file" --build-arg AGENT_CLIS="$AGENT_CLIS" --build-arg CLAUDE_CODE_VERSION="$CLAUDE_CODE_VERSION" --build-arg PREINSTALL_MCP_SERVERS="$PREINSTALL_MCP_SERVERS" --build-arg OPENCODE_INSTALL_METHOD="$OPENCODE_INSTALL_METHOD" -t "$ref" "$@" "$ROOT"
}
TOOLCHAINS=(agent api dind)
step "Toolchain images (${TOOLCHAIN_LOCAL}/*:${VERSION})"
toolchain agent images/base.Dockerfile --target agent-toolchain
toolchain api Dockerfile.api --target api-toolchain
toolchain dind images/dind.Dockerfile --target dind-toolchain \
  --build-arg BASE_IMAGE="${TOOLCHAIN_LOCAL}/agent:${VERSION}"
if [ "$WITH_PRESETS" = 1 ]; then
  for preset in "${PRESETS[@]}"; do
    toolchain "$preset" "images/$preset.Dockerfile" --build-arg BASE_IMAGE="${TOOLCHAIN_LOCAL}/agent:${VERSION}"
    TOOLCHAINS+=("$preset")
  done
fi

# ── 2. Base and third-party images ──
step "Base and third-party images (${PLATFORM})"
# The three base images twice: under their plain tag, and under one with
# this kit's version, which the offline builds use (build-images.sh --offline,
# .gitlab-ci.yml, build/ci-node): a later kit moves the plain tags, so an
# older release still builds on the bases it was made with.
ALL_THIRD_PARTY=(
  "base/node:26-slim $NODE_SLIM_REF"
  "base/node:26 $NODE_IMAGE_REF"
  "base/ubuntu:24.04 $UBUNTU_REF"
  "base/node:26-slim-$VERSION $NODE_SLIM_REF"
  "base/node:26-$VERSION $NODE_IMAGE_REF"
  "base/ubuntu:24.04-$VERSION $UBUNTU_REF"
  "${THIRD_PARTY[@]}"
)
for row in "${ALL_THIRD_PARTY[@]}"; do
  read -r path ref <<< "$row"
  docker pull -q --platform "$PLATFORM" "$ref" > /dev/null
done
slim_node="$(docker run --rm --network none --platform "$PLATFORM" "$NODE_SLIM_REF" node --version)"
full_node="$(docker run --rm --network none --platform "$PLATFORM" "$NODE_IMAGE_REF" node --version)"
if [ "$slim_node" != "$full_node" ]; then
  echo "Node toolchain versions differ: $full_node versus $slim_node; update NODE_IMAGE_REF" >&2
  exit 1
fi
for row in "${ALL_THIRD_PARTY[@]}"; do
  read -r path ref <<< "$row"
  save_image "$path" "$ref"
done
step "Toolchain images → offline/images"
for name in "${TOOLCHAINS[@]}"; do
  save_image "toolchain/${name}:${VERSION}" "${TOOLCHAIN_LOCAL}/${name}:${VERSION}"
done
# What the agent toolchain carries, for KIT.md.
tool_version() { timeout 60 docker run --rm --network none --entrypoint "$1" "${TOOLCHAIN_LOCAL}/agent:${VERSION}" "${@:2}" 2>/dev/null | head -n1 || true; }
AGENT_TOOLS="claude $(tool_version claude --version); opencode $(tool_version opencode --version); glab $(tool_version glab --version | sed 's/^glab //'); node $(tool_version node --version)"

# ── 3. The pnpm store ──
# In NODE_SLIM_IMAGE, so the platform packages pnpm picks (Next's SWC, turbo,
# esbuild: linux x64 glibc) are the ones the image builds and node:26 CI jobs need.
step "pnpm store (pnpm fetch in $NODE_SLIM_REF)"
STORE_DIR="$WORK/pnpm-offline"
SRC_DIR="$WORK/pnpm-src"
mkdir -p "$STORE_DIR" "$SRC_DIR"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$SRC_DIR/"
if [ -f .npmrc ]; then cp .npmrc "$SRC_DIR/"; fi
docker run --rm --platform "$PLATFORM" --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e COREPACK_HOME=/tmp/corepack -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  ${NPM_CONFIG_REGISTRY:+-e NPM_CONFIG_REGISTRY="$NPM_CONFIG_REGISTRY"} \
  ${NPM_CONFIG_REGISTRY:+-e COREPACK_NPM_REGISTRY="$NPM_CONFIG_REGISTRY"} \
  -v "$SRC_DIR:/work" -v "$STORE_DIR:/out" -w /work "$NODE_SLIM_REF" bash -euo pipefail -c '
    npm install --prefix /tmp/tooling corepack@0.36.0 >/dev/null
    export PATH=/tmp/tooling/node_modules/.bin:$PATH
    mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin && export PATH=/tmp/bin:$PATH
    pm="$(node -p "require(\"./package.json\").packageManager")"
    corepack pack "$pm" -o /out/pnpm.tgz >/dev/null
    pnpm fetch --ignore-scripts --store-dir /out/store
    echo "$pm" > /out/PNPM_VERSION'
cat > "$STORE_DIR/README.txt" << README
The npm packages of Optio ${VERSION} (pnpm-lock.yaml at ${COMMIT}), for an
install with no registry, fetched for linux x64 (glibc) in ${NODE_SLIM_REF}.

  store/      a pnpm content-addressable store (pnpm fetch)
  pnpm.tgz    $(cat "$STORE_DIR/PNPM_VERSION") for corepack (corepack pack)

  corepack install -g --cache-only pnpm.tgz
  pnpm install --offline --frozen-lockfile --store-dir <here>/store

The image builds take it as the named context pnpm-offline (Dockerfile.web),
and scripts/offline/load-kit.sh pushes it as build/pnpm-offline:${VERSION}.
README
PNPM_TGZ="$OFF/pnpm-offline-${VERSION}.tgz"
tar -C "$STORE_DIR" --owner=0 --group=0 --numeric-owner -czf "$PNPM_TGZ" .
echo "Wrote offline/$(basename "$PNPM_TGZ") ($(du -h "$PNPM_TGZ" | cut -f1))"

# ── 4. Tools for the jump host and the CI (offline/bin) ──
step "Tools (offline/bin)"
fetch() { # <url> <sha256> → path in the cache
  local url="$1" sum="$2" file
  file="$CACHE/$(basename "$url")"
  if [ ! -f "$file" ] || ! printf '%s  %s\n' "$sum" "$file" | sha256sum -c --status; then
    curl -fsSL --retry 3 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  printf '%s  %s\n' "$sum" "$file" | sha256sum -c --status || {
    echo "Checksum mismatch: $url (expected $sum)" >&2
    exit 1
  }
  printf '%s' "$file"
}
f="$(fetch "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" "$HELM_SHA256")"
tar -xzf "$f" -C "$WORK" linux-amd64/helm
install -m 0755 "$WORK/linux-amd64/helm" "$OFF/bin/helm"
f="$(fetch "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" "$KUBECTL_SHA256")"
install -m 0755 "$f" "$OFF/bin/kubectl"
f="$(fetch "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz" "$CRANE_SHA256")"
tar -xzf "$f" -C "$WORK" crane
install -m 0755 "$WORK/crane" "$OFF/bin/crane"
f="$(fetch "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" "$NODE_SHA256")"
cp "$f" "$OFF/bin/"
f="$(fetch "https://gitlab-charts.s3.amazonaws.com/gitlab-runner-${RUNNER_CHART_VERSION}.tgz" "$RUNNER_CHART_SHA256")"
cp "$f" "$OFF/charts/"
cid="$(docker create --platform "$PLATFORM" "$BUILDKIT_IMAGE")"
docker cp "$cid:/usr/bin/buildctl" "$OFF/bin/buildctl" > /dev/null
docker rm "$cid" > /dev/null
chmod 0755 "$OFF/bin/buildctl"
BUILDCTL_VERSION="$("$OFF/bin/buildctl" --version | awk '{print $3}')"
echo "helm $HELM_VERSION, kubectl $KUBECTL_VERSION, crane $CRANE_VERSION, buildctl $BUILDCTL_VERSION, node $NODE_VERSION, gitlab-runner chart $RUNNER_CHART_VERSION"

# ── 5. The supply-chain check: SBOMs, the scan and its database, the known-bad list ──
# A match on the known-bad list stops here (exit 1): no KIT.md, no checksums.
if [ "$SCAN" = 1 ]; then
  step "Supply chain (scripts/offline/kit-scan.sh)"
  scripts/offline/kit-scan.sh "$OUT" --syft-image "$SYFT_IMAGE" --trivy-image "$TRIVY_IMAGE"
fi

# ── 6. KIT.md and the checksums ──
step "KIT.md and offline/SHA256SUMS"
size() { du -sh "$1" | cut -f1; }
{
  echo "# Optio offline kit ${VERSION}"
  echo
  echo "Made $(date -u +%Y-%m-%dT%H:%MZ) from \`${COMMIT}\` ,"
  echo "toolchains with CLIs \`${AGENT_CLIS}\`, platform ${PLATFORM}."
  echo "How it is used: docs/air-gapped.md in the source."
  if [ "$DIRTY" = 1 ]; then
    echo
    echo "**Made from a working tree with uncommitted changes**: a trial kit, which may"
    echo "not match any commit. Don't carry it in."
  fi
  if [ "$SCAN" = 0 ]; then
    echo
    echo "**Not scanned** (make-kit.sh --skip-scan): no SBOMs, vulnerability scan or"
    echo "known-bad check. Don't carry it in."
  fi
  echo
  echo "## Load it (offline, on a jump host that reaches your registry)"
  echo
  echo '```bash'
  echo "(cd offline && sha256sum -c SHA256SUMS)"
  echo "export OPTIO_REGISTRY=registry.example.com/optio OPTIO_KIT_DIR=\$PWD"
  echo "<source>/scripts/offline/load-kit.sh --dry-run"
  echo "<source>/scripts/offline/load-kit.sh               # --ca-file, --username/--password-stdin: --help"
  echo '```'
  echo
  echo "Then build with no network: \`scripts/offline/build-images.sh <tag> --offline --push\`"
  echo "(or the pipeline, with OPTIO_TOOLCHAIN_VERSION=${VERSION})."
  echo
  echo "## Files"
  echo
  echo "| File | Size | What |"
  echo "| --- | ---: | --- |"
  echo "| \`offline/pnpm-offline-${VERSION}.tgz\` | $(size "$PNPM_TGZ") | every npm package of the workspace and $(cat "$STORE_DIR/PNPM_VERSION") (README.txt offline); pushed as \`build/pnpm-offline:${VERSION}\` |"
  echo "| \`offline/images/\` | $(size "$OFF/images") | the images below, one \`docker save\` each |"
  echo "| \`offline/images.txt\` | | \`<kit file> <original ref> <path under \${OPTIO_REGISTRY}>\` |"
  echo "| \`offline/bin/helm\` | $(size "$OFF/bin/helm") | Helm ${HELM_VERSION} |"
  echo "| \`offline/bin/kubectl\` | $(size "$OFF/bin/kubectl") | kubectl ${KUBECTL_VERSION} |"
  echo "| \`offline/bin/crane\` | $(size "$OFF/bin/crane") | crane ${CRANE_VERSION} (load-kit.sh pushes with it) |"
  echo "| \`offline/bin/buildctl\` | $(size "$OFF/bin/buildctl") | buildctl ${BUILDCTL_VERSION} (BuildKit's client, as in \`base/buildkit\`) |"
  echo "| \`offline/bin/node-${NODE_VERSION}-linux-x64.tar.xz\` | $(size "$OFF/bin/node-${NODE_VERSION}-linux-x64.tar.xz") | Node ${NODE_VERSION} for a jump host or a laptop |"
  echo "| \`offline/charts/gitlab-runner-${RUNNER_CHART_VERSION}.tgz\` | $(size "$OFF/charts/gitlab-runner-${RUNNER_CHART_VERSION}.tgz") | GitLab Runner's Helm chart (docs/examples/ci/README.md, \"Install the runner\") |"
  if [ "$SCAN" = 1 ]; then
    echo "| \`offline/sbom/\` | $(size "$OFF/sbom") | an SBOM (CycloneDX JSON) per image, for the npm packages and the tools; \`digests.txt\`: each image's digests |"
    echo "| \`offline/scan/\` | $(size "$OFF/scan") | Trivy's report per SBOM, \`KNOWN-BAD.md\`, \`SUMMARY.md\` (below) |"
    echo "| \`offline/trivy-db.tgz\` | $(size "$OFF/trivy-db.tgz") | Trivy's vulnerability database, for a scan offline |"
  fi
  echo "| \`offline/SHA256SUMS\` | | \`cd offline && sha256sum -c SHA256SUMS\` |"
  echo
  echo "## Images"
  echo
  echo "| Path under \`\${OPTIO_REGISTRY}\` | From | Kit file | Size |"
  echo "| --- | --- | --- | ---: |"
  while read -r file ref path; do
    echo "| \`$path\` | \`$ref\` | \`$file\` | $(size "$OFF/$file") |"
  done < "$IMAGES_TXT"
  echo "| \`build/pnpm-offline:${VERSION}\` | made by load-kit.sh | \`pnpm-offline-${VERSION}.tgz\` | |"
  echo "| \`build/ci-node:${VERSION}\` | made by load-kit.sh: \`base/node:26-${VERSION}\` + pnpm + \`/pnpm-offline/store\` | | |"
  echo
  echo "Agent toolchain: ${AGENT_TOOLS}."
  if [ "$SCAN" = 1 ]; then
    echo
    echo "## Supply chain"
    echo
    cat "$OFF/scan/SUMMARY.md"
    echo
    echo "Scan it again offline, with no network: with this database, or a newer one carried"
    echo "in, and the source's known-bad list (docs/air-gapped.md, \"The supply-chain check\"):"
    echo
    echo '```bash'
    echo "<source>/scripts/offline/kit-scan.sh . --offline                  # → rescan-<date>/"
    echo "<source>/scripts/offline/kit-scan.sh . --offline --db trivy-db-<date>.tgz"
    echo '```'
  fi
  echo
  echo "The source (with its git history) is not in the kit: carry the checkout or"
  echo "a \`git bundle\` beside it (docs/air-gapped.md)."
} > "$OUT/KIT.md"
(cd "$OFF" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort | xargs -d '\n' sha256sum > SHA256SUMS)

step "Done: $OUT ($(size "$OUT"))"
(cd "$OUT" && find . -type f | LC_ALL=C sort | xargs -d '\n' du -h)
