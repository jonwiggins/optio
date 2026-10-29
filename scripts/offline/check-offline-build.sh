#!/usr/bin/env bash
# Build Optio from an offline kit with no network, on the connected side: what
# the first build inside does, tried before the kit is carried in, so a
# download line or a lockfile change the kit lacks shows up here
# (docs/air-gapped.md).
#
#   scripts/offline/check-offline-build.sh <kit dir> [options]
#     --only <names>   the images (build-images.sh --only; default
#                      api,web,agent-base,agent-dind)
#     --keep           leave the network and the containers for a look (the
#                      next run removes them)
#
# Steps, all on a docker network made with --internal (no route out):
#   1. a scratch registry (registry:2.8.3) and rootless BuildKit (the kit's
#      base/buildkit image, loaded from the kit)
#   2. in a container of the kit's base/node:26: a check that the internet
#      can't be reached, scripts/offline/load-kit.sh into the scratch registry,
#      then scripts/offline/build-images.sh <kit version> --offline with the
#      kit's buildctl
#   3. the containers and the network are removed
#
# Needs docker and the registry image (pulled once, by digest, with internet
# access). The source is this checkout, as it is on disk. A full run takes
# about as long as the pipeline's builds (10 to 20 minutes, more without a
# layer cache) and up to about 8 GB of memory.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$PWD"

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }
die() { echo "ERROR: $*" >&2; exit 1; }

REGISTRY_IMAGE="docker.io/library/registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"
NAME=optio-offline-check
KIT=""
ONLY="api,web,agent-base,agent-dind"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:?--only needs names}"; shift ;;
    --only=*) ONLY="${1#*=}" ;;
    --keep) KEEP=1 ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [ -n "$KIT" ]; then echo "One kit only (got $KIT and $1)" >&2; exit 2; fi
      KIT="$1"
      ;;
  esac
  shift
done
[ -n "$KIT" ] || { usage >&2; exit 2; }
KIT="$(cd "$KIT" && pwd)"
OFF="$KIT/offline"
[ -f "$OFF/images.txt" ] || die "$KIT is not a kit (no offline/images.txt)"
command -v docker >/dev/null 2>&1 || die "docker is needed"
shopt -s nullglob
tgzs=("$OFF"/pnpm-offline-*.tgz)
shopt -u nullglob
[ "${#tgzs[@]}" = 1 ] || die "expected one offline/pnpm-offline-<version>.tgz, found ${#tgzs[@]}"
KIT_VERSION="$(basename "${tgzs[0]}" .tgz)"
KIT_VERSION="${KIT_VERSION#pnpm-offline-}"

# kit_image <path under the registry>: docker load its kit file, print the image.
kit_image() {
  local file loaded
  file="$(awk -v p="$1" '$3 == p { print $1; exit }' "$OFF/images.txt")"
  [ -n "$file" ] && [ -f "$OFF/$file" ] || die "the kit has no $1 (offline/images.txt)"
  loaded="$(docker load -i "$OFF/$file" | sed -n 's/^Loaded image\( ID\)\{0,1\}: //p' | head -n1)"
  [ -n "$loaded" ] || die "docker load -i offline/$file loaded nothing"
  printf '%s' "$loaded"
}

cleanup() {
  docker rm -f "$NAME-registry" "$NAME-buildkitd" "$NAME-run" >/dev/null 2>&1 || true
  docker network rm "$NAME" >/dev/null 2>&1 || true
  rm -rf "${WORK:-}"
}
cleanup
WORK="$(mktemp -d)"
if [ "$KEEP" = 1 ]; then
  trap 'rm -rf "$WORK"; echo "Kept: network $NAME, containers $NAME-registry and $NAME-buildkitd"' EXIT
else
  trap cleanup EXIT
fi

echo "Kit:    $KIT (version $KIT_VERSION)"
echo "Source: $ROOT"
echo "Images: $ONLY"

echo
echo "=== 1. The network (--internal), a scratch registry and BuildKit"
docker image inspect "$REGISTRY_IMAGE" >/dev/null 2>&1 || docker pull -q "$REGISTRY_IMAGE" >/dev/null
BUILDKIT_IMAGE="$(kit_image "$(awk '$3 ~ /^base\/buildkit:/ { print $3; exit }' "$OFF/images.txt")")"
NODE_IMAGE="$(kit_image base/node:26)"
docker network create --internal "$NAME" >/dev/null
docker run -d --name "$NAME-registry" --network "$NAME" --network-alias registry "$REGISTRY_IMAGE" >/dev/null
cat >"$WORK/buildkitd.toml" <<'TOML'
[registry."registry:5000"]
  http = true
  insecure = true
TOML
chmod 644 "$WORK/buildkitd.toml"
# Rootless BuildKit in a container, as the pipeline's build jobs run it.
docker run -d --name "$NAME-buildkitd" --network "$NAME" --network-alias buildkitd \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  -v "$WORK/buildkitd.toml:/etc/buildkit/buildkitd.toml:ro" \
  "$BUILDKIT_IMAGE" --addr tcp://0.0.0.0:1234 --oci-worker-no-process-sandbox \
  --config /etc/buildkit/buildkitd.toml >/dev/null
echo "registry: $REGISTRY_IMAGE; BuildKit: $BUILDKIT_IMAGE; runner: $NODE_IMAGE"

echo
echo "=== 2. load-kit.sh and build-images.sh --offline, from inside"
cat >"$WORK/run.sh" <<'RUN'
set -euo pipefail
export PATH=/kit/offline/bin:$PATH BUILDCTL=/kit/offline/bin/buildctl
if getent hosts registry.npmjs.org >/dev/null 2>&1 && timeout 10 bash -c 'exec 3<>/dev/tcp/registry.npmjs.org/443' 2>/dev/null; then
  echo "ERROR: this container reaches registry.npmjs.org; the check needs no route out" >&2
  exit 1
fi
echo "no route out (registry.npmjs.org unreachable)"
for _ in $(seq 1 30); do buildctl --addr tcp://buildkitd:1234 debug workers >/dev/null 2>&1 && break; sleep 2; done
buildctl --addr tcp://buildkitd:1234 debug workers >/dev/null || { echo "ERROR: BuildKit did not start" >&2; exit 1; }
scripts/offline/load-kit.sh --kit /kit --registry registry:5000/optio --insecure
scripts/offline/build-images.sh "$KIT_VERSION" --offline --registry registry:5000/optio --insecure \
  --buildkit-host tcp://buildkitd:1234 --only "$ONLY"
RUN
chmod 644 "$WORK/run.sh"
status=0
docker run --rm --name "$NAME-run" --network "$NAME" --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e KIT_VERSION="$KIT_VERSION" -e ONLY="$ONLY" \
  -v "$KIT:/kit:ro" -v "$ROOT:/src:ro" -v "$WORK/run.sh:/run.sh:ro" -w /src \
  "$NODE_IMAGE" bash /run.sh || status=$?
if [ "$status" != 0 ]; then
  echo >&2
  echo "The offline build failed (above). BuildKit's log, last lines:" >&2
  docker logs --tail 20 "$NAME-buildkitd" >&2 2>&1 || true
  echo "A RUN step that downloads belongs in a toolchain stage, a lockfile change needs a new kit (docs/air-gapped.md)." >&2
  exit "$status"
fi

echo
echo "Offline build of $ONLY from kit $KIT_VERSION: ok"
