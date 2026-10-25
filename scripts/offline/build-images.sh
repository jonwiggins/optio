#!/usr/bin/env bash
# Build Optio's images from this checkout:
#
#   <prefix>api:<version>              Dockerfile.api
#   <prefix>web:<version>              Dockerfile.web
#   <prefix>agent-base:<version>       images/base.Dockerfile
#   <prefix>agent-dind:<version>       images/dind.Dockerfile
#   <prefix>agent-<preset>:<version>   with --presets: each name in scripts/offline/presets.txt
#
#   scripts/offline/build-images.sh <version> [options]
#     --presets                 also the language presets
#     --only <names>            some of api,web,agent-base,agent-dind,agent-<preset>
#     --agent-clis <list>        all (default) or a comma-separated runtime list
#     --claude-code-version <v>  override the default 2.1.112
#     --preinstall-mcp-servers   include the built-in MCP server binaries
#     --opencode-install-method <script|npm>  default script
#     --prefix <p>              image name prefix (default optio.local/optio-;
#                               <registry>/optio- with --push and --registry)
#     --platform <p>            e.g. linux/amd64 (default: the builder's;
#                               linux/amd64 with --offline)
#     --push                    push the images instead of loading them into docker
#     --insecure                the registry speaks plain HTTP (a test registry)
#     --builder <name>          the buildx builder (default: the current one)
#     --buildkit-host <addr>    build with buildctl against this BuildKit (default
#                               $BUILDKIT_HOST): no docker needed; implies --push
#     --manifest <file>         also write the manifest there (TSV)
#
#   With no network, from the offline kit in your registry (load-kit.sh):
#     --offline                 every build runs with --network none and starts
#                               from the kit's images (base/node:22-slim-<toolchain
#                               version>, …: the kit's own tags of the bases)
#     --registry <r>            the kit's registry (default $OPTIO_REGISTRY):
#                               <r>/base/…, <r>/toolchain/…, <r>/build/pnpm-offline
#     --toolchain-prefix <p>    where the toolchain images are (default <r>/toolchain/)
#     --toolchain-version <v>   the kit's version (default $OPTIO_TOOLCHAIN_VERSION,
#                               else <version>)
#     --pnpm-offline <src>      the pnpm store: a directory (an unpacked
#                               pnpm-offline-<v>.tgz) or an image (default
#                               <r>/build/pnpm-offline:<toolchain version>)
#     --web-offline <dir>       only the web image with no network, from an
#                               unpacked store (the others as without --offline)
#
# Builders: `docker buildx`, a standalone `buildx` on PATH (or in $BUILDX), or
# buildctl (the kit's offline/bin/buildctl; $BUILDCTL) with --buildkit-host.
# Without --offline the builds download (apt, npm, release files) as upstream's
# do. With --offline, optio-agent-dind is two builds: images/base.Dockerfile on
# toolchain/dind as <prefix>agent-dind-base, then images/dind.Dockerfile on it.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$PWD"

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

# scripts/offline/presets.txt (make-kit.sh reads it too); ruby and dart are built by images/build.sh only.
mapfile -t PRESET_NAMES < <(sed -e 's/#.*//' -e 's/[[:space:]]//g' -e '/^$/d' scripts/offline/presets.txt)
VERSION=""
PRESETS=0
ONLY=""
AGENT_CLIS="${AGENT_CLIS:-all}"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.112}"
PREINSTALL_MCP_SERVERS="${PREINSTALL_MCP_SERVERS:-0}"
OPENCODE_INSTALL_METHOD="${OPENCODE_INSTALL_METHOD:-script}"
PREFIX=""
PLATFORM=""
PUSH=0
INSECURE=0
BUILDER=""
BUILDKIT_HOST="${BUILDKIT_HOST:-}"
MANIFEST=""
OFFLINE=0
REGISTRY="${OPTIO_REGISTRY:-}"
TOOLCHAIN_PREFIX=""
TOOLCHAIN_VERSION="${OPTIO_TOOLCHAIN_VERSION:-}"
PNPM_SRC=""
WEB_OFFLINE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --presets) PRESETS=1 ;;
    --only) ONLY="${2:?--only needs names}"; shift ;;
    --only=*) ONLY="${1#*=}" ;;
    --agent-clis) AGENT_CLIS="${2:?--agent-clis needs a list}"; shift ;;
    --claude-code-version) CLAUDE_CODE_VERSION="${2:?--claude-code-version needs a version}"; shift ;;
    --preinstall-mcp-servers) PREINSTALL_MCP_SERVERS=1 ;;
    --opencode-install-method) OPENCODE_INSTALL_METHOD="${2:?--opencode-install-method needs script or npm}"; shift ;;
    --prefix) PREFIX="${2:?--prefix needs a value}"; shift ;;
    --prefix=*) PREFIX="${1#*=}" ;;
    --platform) PLATFORM="${2:?--platform needs a value}"; shift ;;
    --platform=*) PLATFORM="${1#*=}" ;;
    --push) PUSH=1 ;;
    --insecure) INSECURE=1 ;;
    --builder) BUILDER="${2:?--builder needs a name}"; shift ;;
    --builder=*) BUILDER="${1#*=}" ;;
    --buildkit-host) BUILDKIT_HOST="${2:?--buildkit-host needs an address}"; shift ;;
    --buildkit-host=*) BUILDKIT_HOST="${1#*=}" ;;
    --manifest) MANIFEST="${2:?--manifest needs a file}"; shift ;;
    --manifest=*) MANIFEST="${1#*=}" ;;
    --offline) OFFLINE=1 ;;
    --registry) REGISTRY="${2:?--registry needs a value}"; shift ;;
    --registry=*) REGISTRY="${1#*=}" ;;
    --toolchain-prefix) TOOLCHAIN_PREFIX="${2:?--toolchain-prefix needs a value}"; shift ;;
    --toolchain-prefix=*) TOOLCHAIN_PREFIX="${1#*=}" ;;
    --toolchain-version) TOOLCHAIN_VERSION="${2:?--toolchain-version needs a value}"; shift ;;
    --toolchain-version=*) TOOLCHAIN_VERSION="${1#*=}" ;;
    --pnpm-offline) PNPM_SRC="${2:?--pnpm-offline needs a directory or an image}"; shift ;;
    --pnpm-offline=*) PNPM_SRC="${1#*=}" ;;
    --web-offline) WEB_OFFLINE="${2:?--web-offline needs a directory}"; shift ;;
    --web-offline=*) WEB_OFFLINE="${1#*=}" ;;
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
REGISTRY="${REGISTRY%/}"
if [ -n "$BUILDKIT_HOST" ]; then PUSH=1; fi
if [ -z "$PREFIX" ]; then
  if [ "$PUSH" = 1 ] && [ -n "$REGISTRY" ]; then PREFIX="$REGISTRY/optio-"; else PREFIX="optio.local/optio-"; fi
fi
if [ "$PUSH" = 1 ] && [ "${PREFIX%%/*}" = optio.local ]; then
  echo "--push needs a registry: --registry <r> (or OPTIO_REGISTRY) or --prefix <registry>/optio-" >&2
  exit 2
fi

# What to build, in order (agent-dind and the presets after agent-base).
NAMES=(api web agent-base agent-dind)
if [ "$PRESETS" = 1 ]; then for p in "${PRESET_NAMES[@]}"; do NAMES+=("agent-$p"); done; fi
if [ -n "$ONLY" ]; then
  IFS=',' read -r -a wanted <<< "$ONLY"
  for name in "${wanted[@]}"; do
    case " api web agent-base agent-dind ${PRESET_NAMES[*]/#/agent-} " in *" $name "*) ;; *)
      echo "--only: unknown image $name" >&2; exit 2 ;; esac
  done
  NAMES=("${wanted[@]}")
fi

# ── Where an offline build starts from ──
if [ "$OFFLINE" = 1 ]; then
  [ -n "$REGISTRY" ] || { echo "--offline needs the kit's registry: --registry <r> or OPTIO_REGISTRY" >&2; exit 2; }
  [ -n "$WEB_OFFLINE" ] && { echo "--web-offline is for one image; --offline already builds the web image offline" >&2; exit 2; }
  TOOLCHAIN_VERSION="${TOOLCHAIN_VERSION:-$VERSION}"
  TOOLCHAIN_PREFIX="${TOOLCHAIN_PREFIX:-$REGISTRY/toolchain/}"
  case "$TOOLCHAIN_PREFIX" in */) ;; *) TOOLCHAIN_PREFIX="$TOOLCHAIN_PREFIX/" ;; esac
  PNPM_SRC="${PNPM_SRC:-$REGISTRY/build/pnpm-offline:$TOOLCHAIN_VERSION}"
  PLATFORM="${PLATFORM:-linux/amd64}"
fi
if [ -n "$WEB_OFFLINE" ]; then PNPM_SRC="$WEB_OFFLINE"; fi
PNPM_DIR=""
if [ -n "$PNPM_SRC" ] && [ -d "$PNPM_SRC" ]; then
  [ -d "$PNPM_SRC/store" ] && [ -f "$PNPM_SRC/pnpm.tgz" ] || {
    echo "$PNPM_SRC: expected store/ and pnpm.tgz (an unpacked pnpm-offline-<version>.tgz)" >&2
    exit 2
  }
  PNPM_DIR="$(cd "$PNPM_SRC" && pwd)"
fi

# ── The builder ──
if [ -n "$BUILDKIT_HOST" ]; then
  BUILDCTL="${BUILDCTL:-buildctl}"
  command -v "$BUILDCTL" >/dev/null 2>&1 || { echo "buildctl not found (set BUILDCTL, e.g. <kit>/offline/bin/buildctl)" >&2; exit 1; }
  BACKEND=buildctl
elif docker buildx version >/dev/null 2>&1; then
  BUILDX=(docker buildx)
  BACKEND=buildx
elif command -v "${BUILDX:-buildx}" >/dev/null 2>&1; then
  BUILDX=("${BUILDX:-buildx}")
  BACKEND=buildx
else
  echo "BuildKit is required: the docker buildx plugin, a standalone buildx on PATH (or in \$BUILDX)," >&2
  echo "or buildctl with --buildkit-host / BUILDKIT_HOST." >&2
  exit 1
fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PUSH_OPTS="push=true"
if [ "$INSECURE" = 1 ]; then PUSH_OPTS="push=true,registry.insecure=true"; fi

BUILT=()
declare -A DIGEST=()
# build <ref> <dockerfile> [--arg K=V]... [--target T]
build() {
  local ref="$1" file="$2"
  shift 2
  local offline_fonts=0
  if [ "$OFFLINE" = 1 ] || [ -n "$WEB_OFFLINE" ]; then offline_fonts=1; fi
  local args=("AGENT_CLIS=$AGENT_CLIS" "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION" "PREINSTALL_MCP_SERVERS=$PREINSTALL_MCP_SERVERS" "OPENCODE_INSTALL_METHOD=$OPENCODE_INSTALL_METHOD" "OPTIO_VERSION=$VERSION" "OPTIO_OFFLINE_FONTS=$offline_fonts") target="" meta="$WORK/meta.json"
  while [ $# -gt 0 ]; do
    case "$1" in
      --arg) args+=("$2"); shift ;;
      --target) target="$2"; shift ;;
    esac
    shift
  done
  local pnpm_ctx=""
  if [ -n "$PNPM_SRC" ]; then
    for kv in "${args[@]}"; do [ "$kv" = PNPM_OFFLINE=1 ] && pnpm_ctx=1; done
  fi
  local offline=0
  if [ "$OFFLINE" = 1 ] || [ -n "$pnpm_ctx" ]; then offline=1; fi
  local note=""
  if [ "$offline" = 1 ]; then note=", no network"; fi
  echo
  echo "=== ${ref}  (${file}${target:+ --target $target}, AGENT_CLIS=${AGENT_CLIS}${note})"
  rm -f "$meta"
  if [ "$BACKEND" = buildx ]; then
    local cmd=("${BUILDX[@]}" build ${BUILDER:+--builder "$BUILDER"} -f "$file" -t "$ref" --metadata-file "$meta")
    for kv in "${args[@]}"; do cmd+=(--build-arg "$kv"); done
    [ -n "$target" ] && cmd+=(--target "$target")
    [ -n "$PLATFORM" ] && cmd+=(--platform "$PLATFORM")
    [ "$offline" = 1 ] && cmd+=(--network none)
    if [ -n "$pnpm_ctx" ]; then
      if [ -n "$PNPM_DIR" ]; then cmd+=(--build-context "pnpm-offline=$PNPM_DIR")
      else cmd+=(--build-context "pnpm-offline=docker-image://$PNPM_SRC"); fi
    fi
    if [ "$PUSH" = 1 ]; then
      cmd+=(--output "type=image,name=$ref,$PUSH_OPTS")
    else
      cmd+=(--load)
    fi
    "${cmd[@]}" "$ROOT"
  else
    local cmd=("$BUILDCTL" --addr "$BUILDKIT_HOST" build --progress=plain --frontend dockerfile.v0
      --local "context=$ROOT" --local "dockerfile=$(dirname "$ROOT/$file")" --opt "filename=$(basename "$file")"
      --metadata-file "$meta"
      --output "type=image,name=$ref,$PUSH_OPTS")
    for kv in "${args[@]}"; do cmd+=(--opt "build-arg:$kv"); done
    [ -n "$target" ] && cmd+=(--opt "target=$target")
    [ -n "$PLATFORM" ] && cmd+=(--opt "platform=$PLATFORM")
    [ "$offline" = 1 ] && cmd+=(--opt force-network-mode=none)
    if [ -n "$pnpm_ctx" ]; then
      if [ -n "$PNPM_DIR" ]; then cmd+=(--local "pnpm-offline=$PNPM_DIR" --opt context:pnpm-offline=local:pnpm-offline)
      else cmd+=(--opt "context:pnpm-offline=docker-image://$PNPM_SRC"); fi
    fi
    "${cmd[@]}"
  fi
  DIGEST[$ref]="$(sed -n 's/.*"containerimage.digest": *"\([^"]*\)".*/\1/p' "$meta" 2>/dev/null | head -n1)"
  BUILT+=("$ref")
}

ref_of() { printf '%s%s:%s' "$PREFIX" "$1" "$VERSION"; }
BASE="$(ref_of agent-base)"
OFFLINE_ARGS=()
if [ "$OFFLINE" = 1 ]; then
  # The base images under the kit's own tags (make-kit.sh): a later kit moves the plain ones.
  OFFLINE_ARGS=(--arg PNPM_OFFLINE=1 --arg "NODE_SLIM_IMAGE=$REGISTRY/base/node:22-slim-$TOOLCHAIN_VERSION")
  echo "Offline: base images from $REGISTRY/base/ (*-${TOOLCHAIN_VERSION}), toolchains ${TOOLCHAIN_PREFIX}*:${TOOLCHAIN_VERSION}, pnpm store $PNPM_SRC"
fi
agent_offline_args() { # <toolchain name>
  printf '%s\n' --arg "UBUNTU_IMAGE=$REGISTRY/base/ubuntu:24.04-$TOOLCHAIN_VERSION" --arg "AGENT_TOOLCHAIN_IMAGE=${TOOLCHAIN_PREFIX}$1:${TOOLCHAIN_VERSION}"
}
for name in "${NAMES[@]}"; do
  ref="$(ref_of "$name")"
  case "$name" in
    api)
      if [ "$OFFLINE" = 1 ]; then
        build "$ref" Dockerfile.api "${OFFLINE_ARGS[@]}" --arg "NODE_IMAGE=$REGISTRY/base/node:22-$TOOLCHAIN_VERSION" \
          --arg "API_TOOLCHAIN_IMAGE=${TOOLCHAIN_PREFIX}api:${TOOLCHAIN_VERSION}"
      else build "$ref" Dockerfile.api; fi
      ;;
    web)
      if [ "$OFFLINE" = 1 ]; then build "$ref" Dockerfile.web "${OFFLINE_ARGS[@]}"
      elif [ -n "$WEB_OFFLINE" ]; then build "$ref" Dockerfile.web --arg PNPM_OFFLINE=1
      else build "$ref" Dockerfile.web; fi
      ;;
    agent-base)
      if [ "$OFFLINE" = 1 ]; then
        mapfile -t extra < <(agent_offline_args agent)
        build "$ref" images/base.Dockerfile "${OFFLINE_ARGS[@]}" "${extra[@]}"
      else build "$ref" images/base.Dockerfile; fi
      ;;
    agent-dind)
      if [ "$OFFLINE" = 1 ]; then
        layers="$(ref_of agent-dind-base)"
        mapfile -t extra < <(agent_offline_args dind)
        build "$layers" images/base.Dockerfile "${OFFLINE_ARGS[@]}" "${extra[@]}"
        build "$ref" images/dind.Dockerfile --arg "BASE_IMAGE=$BASE" --arg "DIND_TOOLCHAIN_IMAGE=$layers"
      else build "$ref" images/dind.Dockerfile --arg "BASE_IMAGE=$BASE"; fi
      ;;
    agent-*)
      preset="${name#agent-}"
      if [ "$OFFLINE" = 1 ]; then
        mapfile -t extra < <(agent_offline_args "$preset")
        build "$ref" images/base.Dockerfile "${OFFLINE_ARGS[@]}" "${extra[@]}"
      else build "$ref" "images/$preset.Dockerfile" --arg "BASE_IMAGE=$BASE"; fi
      ;;
  esac
done

# The manifest; with the images in the local docker, their sizes and what the
# agent image carries (for the release notes).
LOCAL=0
if [ "$PUSH" = 0 ] && command -v docker >/dev/null 2>&1; then LOCAL=1; fi
TOOLS=""
if [ "$LOCAL" = 1 ] && docker image inspect "$BASE" >/dev/null 2>&1; then
  tool_version() { timeout 60 docker run --rm --network none --entrypoint "$1" "$BASE" "${@:2}" 2>/dev/null | head -n1 || true; }
  TOOLS="claude $(tool_version claude --version); opencode $(tool_version opencode --version); glab $(tool_version glab --version | sed 's/^glab //'); node $(tool_version node --version)"
fi
manifest() {
  printf 'image\tid_or_digest\tsize_mb\tagent_clis\n'
  for ref in "${BUILT[@]}"; do
    if [ "$LOCAL" = 1 ]; then
      docker image inspect --format "{{.Id}}|{{.Size}}" "$ref" | {
        IFS='|' read -r id size
        printf '%s\t%s\t%s\t%s\n' "$ref" "$id" "$((size / 1000000))" "$AGENT_CLIS"
      }
    else
      printf '%s\t%s\t-\t%s\n' "$ref" "${DIGEST[$ref]:--}" "$AGENT_CLIS"
    fi
  done
  if [ -n "$TOOLS" ]; then printf '# agent-base tools: %s\n' "$TOOLS"; fi
}

echo
if [ "$OFFLINE" = 1 ]; then note=", built with no network"; else note=""; fi
echo "=== Manifest (version ${VERSION}, agent_clis ${AGENT_CLIS}${note})"
if command -v column >/dev/null 2>&1; then manifest | column -t -s $'\t'; else manifest; fi
if [ -n "$MANIFEST" ]; then
  mkdir -p "$(dirname "$MANIFEST")"
  manifest > "$MANIFEST"
  echo "Wrote $MANIFEST"
fi
