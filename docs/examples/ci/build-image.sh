#!/bin/sh
# Build one image from this source and push it to the chosen registry: the
# build stage of .gitlab-ci.yml. POSIX sh (the BuildKit image has no bash).
#
#   docs/examples/ci/build-image.sh <name> <dockerfile> [--arg KEY=VALUE]... [--context NAME=REF]...
#
#   <name>       optio-api, optio-web, optio-agent-base, optio-agent-dind or
#                optio-agent-<preset>: pushed as ${OPTIO_REGISTRY}/<name>:<tag>
#                for every tag in OPTIO_IMAGE_TAGS
#   <dockerfile> relative to the repository root (the build context)
#   --arg        a build arg; OPTIO_VERSION are always passed
#   --context    a named build context, e.g.
#                pnpm-offline=docker-image://${OPTIO_REGISTRY}/build/pnpm-offline:<kit version>
#
# The builder, whichever the job has:
#   buildctl-daemonless.sh   BuildKit rootless (moby/buildkit:rootless): a
#                            Kubernetes runner with no Docker daemon and no
#                            privileges (BUILDKITD_FLAGS, below)
#   docker buildx            a docker executor with a Docker daemon (dind)
#
# Variables:
#   OPTIO_REGISTRY           required; where the images go and the base images come from
#   OPTIO_IMAGE_TAGS         space-separated tags (default: $CI_COMMIT_SHORT_SHA,
#                            and for a tag release/<version> also <version>, first)
#   OPTIO_VERSION            baked into the image (default: the first tag)
#   OPTIO_REGISTRY_USER, OPTIO_REGISTRY_PASSWORD
#                            the registry login; default: the job token
#                            ($CI_REGISTRY_USER) when OPTIO_REGISTRY is in GitLab's registry
#   OPTIO_BUILD_NETWORK      none (default): RUN steps get no network, so a step
#                            that would download fails at once instead of
#                            timing out; sandbox: the builder's default network
#   OPTIO_BUILD_CACHE        BuildKit layer cache in the registry, under
#                            <this>/<name> (default ${OPTIO_REGISTRY}/cache; off: none)
#   OPTIO_BUILD_PLATFORM     e.g. linux/amd64 (default: the builder's)
#   OPTIO_BUILD_OUT          where <name>.json (the pushed digest) goes (default ci-out,
#                            or a temporary directory when the checkout is read-only)
#   OPTIO_CA_FILE            your CA: buildkitd trusts it for the registry (docs/examples/ci/lib.sh)
#   BUILDKITD_FLAGS          default --oci-worker-no-process-sandbox (no privileged pod)
set -eu

cd "$(dirname "$0")/../../.."
. docs/examples/ci/lib.sh

usage() { sed -n '2,/^set -eu/p' "$0" | sed '$d; s/^# \{0,1\}//'; }
case "${1:-}" in -h | --help) usage; exit 0 ;; esac
[ $# -ge 2 ] || { usage >&2; exit 2; }
NAME="$1"
FILE="$2"
shift 2
[ -f "$FILE" ] || die "no Dockerfile at $FILE"
: "${OPTIO_REGISTRY:?set OPTIO_REGISTRY (e.g. harbor.example.com/optio)}"
REGISTRY="${OPTIO_REGISTRY%/}"
REGISTRY_HOST="${REGISTRY%%/*}"
TAGS="${OPTIO_IMAGE_TAGS:-}"
if [ -z "$TAGS" ]; then
  TAGS="${CI_COMMIT_SHORT_SHA:-}"
  case "${CI_COMMIT_TAG:-}" in release/?*) TAGS="${CI_COMMIT_TAG#release/}${TAGS:+ $TAGS}" ;; esac
fi
[ -n "$TAGS" ] || die "set OPTIO_IMAGE_TAGS (or run in GitLab CI, which sets CI_COMMIT_SHORT_SHA)"
FIRST_TAG="${TAGS%% *}"
VERSION="${OPTIO_VERSION:-$FIRST_TAG}"
NETWORK="${OPTIO_BUILD_NETWORK:-default}"
CACHE="${OPTIO_BUILD_CACHE:-$REGISTRY/cache}"
OUT="${OPTIO_BUILD_OUT:-ci-out}"
# The BuildKit image runs as uid 1000, which may not own the checkout.
mkdir -p "$OUT" 2>/dev/null && [ -w "$OUT" ] || OUT="$(mktemp -d)"
OUT="$(cd "$OUT" && pwd)"
META="$OUT/$(printf '%s' "$NAME" | tr / -).json" # the pushed digest
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

optio_trust_ca

# ── Registry login: a Docker config both builders read ──
USER_NAME="${OPTIO_REGISTRY_USER:-}"
PASSWORD="${OPTIO_REGISTRY_PASSWORD:-}"
if [ -z "$USER_NAME" ] && [ -n "${CI_REGISTRY:-}" ] && [ "$REGISTRY_HOST" = "$CI_REGISTRY" ]; then
  USER_NAME="${CI_REGISTRY_USER:-}"
  PASSWORD="${CI_REGISTRY_PASSWORD:-}"
fi
if [ -n "$USER_NAME" ]; then
  export DOCKER_CONFIG="$WORK/docker"
  mkdir -p "$DOCKER_CONFIG"
  auth="$(printf '%s:%s' "$USER_NAME" "$PASSWORD" | base64 | tr -d '\n')"
  printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$REGISTRY_HOST" "$auth" >"$DOCKER_CONFIG/config.json"
fi

# ── The image names, the build args and the named contexts ──
NAMES=""
for tag in $TAGS; do NAMES="${NAMES:+$NAMES,}$REGISTRY/$NAME:$tag"; done
ARGS_FILE="$WORK/args" # one KEY=VALUE per line (values may hold spaces)
CONTEXTS_FILE="$WORK/contexts"
printf 'OPTIO_VERSION=%s\n' "$VERSION" >"$ARGS_FILE"
: >"$CONTEXTS_FILE"
while [ $# -gt 0 ]; do
  case "$1" in
    --arg) printf '%s\n' "${2:?--arg needs KEY=VALUE}" >>"$ARGS_FILE"; shift ;;
    --context) printf '%s\n' "${2:?--context needs NAME=REF}" >>"$CONTEXTS_FILE"; shift ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

section "$NAME ← $FILE"
echo "tags:     $TAGS"
echo "registry: $REGISTRY"
sed 's/^/arg:      /' "$ARGS_FILE"
sed 's/^/context:  /' "$CONTEXTS_FILE"

if command -v buildctl-daemonless.sh >/dev/null 2>&1; then
  # BuildKit rootless. buildkitd trusts your CA for the registry
  # (pushes and the base images it pulls); buildctl, which fetches registry
  # tokens, reads SSL_CERT_FILE (docs/examples/ci/lib.sh).
  CONFIG="$WORK/buildkitd.toml"
  : >"$CONFIG"
  if [ -n "${OPTIO_CA_FILE:-}" ]; then
    printf '[registry."%s"]\n  ca = ["%s"]\n' "$REGISTRY_HOST" "$OPTIO_CA_FILE" >>"$CONFIG"
  fi
  export BUILDKITD_FLAGS="${BUILDKITD_FLAGS:---oci-worker-no-process-sandbox} --config $CONFIG"
  set -- build --progress=plain --frontend dockerfile.v0 \
    --local context=. --local "dockerfile=$(dirname "$FILE")" --opt "filename=$(basename "$FILE")" \
    --output "type=image,\"name=$NAMES\",push=true" \
    --metadata-file "$META"
  while IFS= read -r kv; do set -- "$@" --opt "build-arg:$kv"; done <"$ARGS_FILE"
  while IFS= read -r kv; do set -- "$@" --opt "context:$kv"; done <"$CONTEXTS_FILE"
  if [ "$NETWORK" != sandbox ]; then set -- "$@" --opt "force-network-mode=$NETWORK"; fi
  if [ -n "${OPTIO_BUILD_PLATFORM:-}" ]; then set -- "$@" --opt "platform=$OPTIO_BUILD_PLATFORM"; fi
  if [ "$CACHE" != off ]; then
    set -- "$@" --import-cache "type=registry,ref=$CACHE/$NAME" \
      --export-cache "type=registry,ref=$CACHE/$NAME,mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true"
  fi
  buildctl-daemonless.sh "$@"
elif command -v docker >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1; then
  # A Docker daemon (dind): its own BuildKit. The daemon must trust the CA
  # itself (/etc/docker/certs.d/<registry>/ca.crt in the dind service;
  # docs/examples/ci/README.md). No registry cache with this driver.
  set -- buildx build --progress=plain --push -f "$FILE" --metadata-file "$META"
  for tag in $TAGS; do set -- "$@" -t "$REGISTRY/$NAME:$tag"; done
  while IFS= read -r kv; do set -- "$@" --build-arg "$kv"; done <"$ARGS_FILE"
  while IFS= read -r kv; do set -- "$@" --build-context "$kv"; done <"$CONTEXTS_FILE"
  if [ "$NETWORK" != sandbox ]; then set -- "$@" --network "$NETWORK"; fi
  if [ -n "${OPTIO_BUILD_PLATFORM:-}" ]; then set -- "$@" --platform "$OPTIO_BUILD_PLATFORM"; fi
  docker "$@" .
else
  die "no builder: run in moby/buildkit:rootless (buildctl-daemonless.sh) or with docker buildx"
fi

digest="$(sed -n 's/.*"containerimage.digest": *"\([^"]*\)".*/\1/p' "$META" | head -n1)"
echo
echo "pushed $REGISTRY/$NAME@${digest:-?} as: $TAGS"
