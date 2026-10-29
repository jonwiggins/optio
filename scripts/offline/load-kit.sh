#!/usr/bin/env bash
# Load the offline kit into your registry (docs/air-gapped.md).
# Inside, on a jump host that reaches the registry; no docker needed: the
# kit's own crane (offline/bin/crane) does the pushing.
#
#   scripts/offline/load-kit.sh [options]
#     --kit <dir>          the kit, the directory that holds offline/
#                          (default $OPTIO_KIT_DIR)
#     --registry <r>       where the images go (default $OPTIO_REGISTRY),
#                          e.g. harbor.example.com/optio
#     --ca-file <pem>      the CA that signed the registry's certificate
#                          (default $OPTIO_CA_FILE)
#     --username <u>       log in as <u> with the password on stdin
#     --password-stdin     (with --username). Without them: the login in your
#                          docker config ($DOCKER_CONFIG or ~/.docker/config.json)
#     --insecure           the registry speaks plain HTTP (a test registry)
#     --tool <t>           crane (default: the kit's) or docker (a daemon that
#                          trusts the registry; pushes with docker load/tag/push)
#     --force              rebuild build/pnpm-offline and build/ci-node even
#                          when their tags exist
#     --skip-verify        don't check offline/SHA256SUMS first
#     --dry-run            print what would be pushed and built; change nothing
#
# Steps:
#   1. sha256sum -c offline/SHA256SUMS
#   2. every image in offline/images.txt → ${OPTIO_REGISTRY}/<path>
#      (base/…, node and ubuntu also as <tag>-<kit version>, toolchain/…:<kit version>)
#   3. build/pnpm-offline:<kit version>: offline/pnpm-offline-<kit version>.tgz
#      as an image FROM scratch (store/ and pnpm.tgz at its root), the named
#      context pnpm-offline of the image builds
#   4. build/ci-node:<kit version>: base/node:26-<kit version> with pnpm (/usr/local/bin/pnpm)
#      and the store at /pnpm-offline/store, the image of the CI's Node jobs
#      (npm_config_nodedir=/usr/local: node-gyp uses the image's Node headers)
#
# Steps 3 and 4 make their layers from the kit's files, with no network.
# Running it again is safe: a push skips the blobs the registry has, and steps
# 3 and 4 skip a tag that exists (--force makes them again).
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }
die() { echo "ERROR: $*" >&2; exit 1; }

KIT="${OPTIO_KIT_DIR:-}"
REGISTRY="${OPTIO_REGISTRY:-}"
CA_FILE="${OPTIO_CA_FILE:-}"
USERNAME=""
PASSWORD_STDIN=0
INSECURE=0
TOOL=""
FORCE=0
VERIFY=1
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --kit) KIT="${2:?--kit needs a directory}"; shift ;;
    --kit=*) KIT="${1#*=}" ;;
    --registry) REGISTRY="${2:?--registry needs a value}"; shift ;;
    --registry=*) REGISTRY="${1#*=}" ;;
    --ca-file) CA_FILE="${2:?--ca-file needs a file}"; shift ;;
    --ca-file=*) CA_FILE="${1#*=}" ;;
    --username) USERNAME="${2:?--username needs a value}"; shift ;;
    --username=*) USERNAME="${1#*=}" ;;
    --password-stdin) PASSWORD_STDIN=1 ;;
    --insecure) INSECURE=1 ;;
    --tool) TOOL="${2:?--tool needs crane or docker}"; shift ;;
    --tool=*) TOOL="${1#*=}" ;;
    --force) FORCE=1 ;;
    --skip-verify) VERIFY=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[ -n "$KIT" ] || die "no kit: pass --kit <dir> or set OPTIO_KIT_DIR"
[ -n "$REGISTRY" ] || die "no registry: pass --registry or set OPTIO_REGISTRY (e.g. harbor.example.com/optio)"
OFF="$(cd "$KIT" && pwd)/offline"
[ -f "$OFF/images.txt" ] || die "$KIT is not a kit (no offline/images.txt)"
REGISTRY="${REGISTRY%/}"
REG_HOST="${REGISTRY%%/*}"
if [ -n "$USERNAME" ] && [ "$PASSWORD_STDIN" != 1 ]; then die "--username needs --password-stdin (the password on stdin)"; fi
if [ -n "$CA_FILE" ]; then
  [ -s "$CA_FILE" ] || die "--ca-file $CA_FILE is missing or empty"
  grep -q 'BEGIN CERTIFICATE' "$CA_FILE" || die "--ca-file $CA_FILE holds no PEM certificate"
fi

shopt -s nullglob
tgzs=("$OFF"/pnpm-offline-*.tgz)
shopt -u nullglob
[ "${#tgzs[@]}" = 1 ] || die "expected one offline/pnpm-offline-<version>.tgz, found ${#tgzs[@]}"
PNPM_TGZ="${tgzs[0]}"
KIT_VERSION="$(basename "$PNPM_TGZ" .tgz)"
KIT_VERSION="${KIT_VERSION#pnpm-offline-}"

# Verify before probing tools, reading credentials, or extracting kit content.
# Dry runs still execute tool probes, so they must pass the same integrity gate.
if [ "$VERIFY" = 1 ]; then
  echo "=== 1. offline/SHA256SUMS"
  (cd "$OFF" && sha256sum -c --quiet SHA256SUMS) || die "the kit does not match offline/SHA256SUMS"
  echo "ok"
fi

CRANE="${CRANE:-$OFF/bin/crane}"
if [ -z "$TOOL" ]; then
  if "$CRANE" version >/dev/null 2>&1; then TOOL=crane
  elif command -v docker >/dev/null 2>&1; then TOOL=docker
  else die "neither $CRANE nor docker can run here"
  fi
fi
case "$TOOL" in
  crane) "$CRANE" version >/dev/null 2>&1 || die "$CRANE does not run here (try --tool docker)" ;;
  docker) command -v docker >/dev/null 2>&1 || die "no docker here" ;;
  *) die "--tool is crane or docker, not $TOOL" ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/optio-load-kit.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "Kit:      $KIT (version $KIT_VERSION)"
if [ "$INSECURE" = 1 ]; then echo "Registry: $REGISTRY (plain HTTP)"; else echo "Registry: $REGISTRY"; fi
echo "Tool:     $TOOL"
[ "$DRY_RUN" = 1 ] && echo "Dry run:  nothing is pushed"

# ── The CA and the login, for this run only ──
if [ -n "$CA_FILE" ]; then
  # crane is Go: on Linux it reads SSL_CERT_FILE (the system's CAs plus yours).
  bundle="$WORK/ca-bundle.pem"
  for system in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do
    if [ -s "$system" ]; then cat "$system" > "$bundle"; break; fi
  done
  { echo; cat "$CA_FILE"; echo; } >> "$bundle"
  export SSL_CERT_FILE="$bundle"
  if [ "$TOOL" = docker ]; then
    echo "Note: docker pushes through its daemon, which must trust the CA itself"
    echo "      (/etc/docker/certs.d/$REG_HOST/ca.crt)."
  fi
fi
if [ -n "$USERNAME" ]; then
  PASSWORD="$(cat)"
  [ -n "$PASSWORD" ] || die "--password-stdin: nothing on stdin"
  # A config of its own: the password is never written into yours.
  export DOCKER_CONFIG="$WORK/docker"
  mkdir -p "$DOCKER_CONFIG"
  if [ "$DRY_RUN" = 0 ]; then
    if [ "$TOOL" = crane ]; then
      printf '%s' "$PASSWORD" | "$CRANE" auth login "$REG_HOST" -u "$USERNAME" --password-stdin >"$WORK/login.log" 2>&1
    else
      printf '%s' "$PASSWORD" | docker login "$REG_HOST" -u "$USERNAME" --password-stdin >"$WORK/login.log" 2>&1
    fi || { cat "$WORK/login.log" >&2; die "the login to $REG_HOST failed"; }
  fi
  unset PASSWORD
fi
CRANE_ARGS=()
if [ "$INSECURE" = 1 ]; then CRANE_ARGS+=(--insecure); fi
crane() { "$CRANE" "$@" "${CRANE_ARGS[@]}"; }
exists() { # <ref>
  if [ "$TOOL" = crane ]; then crane digest "$1" >/dev/null 2>&1
  elif [ "$INSECURE" = 1 ]; then docker manifest inspect --insecure "$1" >/dev/null 2>&1
  else docker manifest inspect "$1" >/dev/null 2>&1; fi
}

# ── 2. The kit's images ──
echo
echo "=== 2. Images (offline/images.txt → $REGISTRY/…)"
PUSHED=()
current=""
loaded=""
# Rows sharing a kit file are unpacked once.
while read -r file ref path; do
  [ -n "$file" ] || continue
  case "$file" in \#*) continue ;; esac
  [ -f "$OFF/$file" ] || die "offline/$file (listed in images.txt) is missing"
  target="$REGISTRY/$path"
  echo "  $path  ($ref)"
  if [ "$DRY_RUN" = 1 ]; then PUSHED+=("$target"); continue; fi
  if [ "$TOOL" = crane ]; then
    if [ "$file" != "$current" ]; then
      rm -f "$WORK/image.tar"
      # crane reads an uncompressed docker save tarball.
      gzip -dc "$OFF/$file" > "$WORK/image.tar"
      current="$file"
    fi
    crane push "$WORK/image.tar" "$target" >"$WORK/push.log" 2>&1 || {
      cat "$WORK/push.log" >&2
      die "push to $target failed (a private CA: --ca-file; a login: --username/--password-stdin)"
    }
  else
    if [ "$file" != "$current" ]; then
      loaded="$(docker load -i "$OFF/$file" | sed -n 's/^Loaded image\( ID\)\{0,1\}: //p' | head -n1)"
      [ -n "$loaded" ] || die "docker load -i offline/$file loaded nothing"
      current="$file"
    fi
    docker tag "$loaded" "$target"
    docker push -q "$target" >/dev/null
  fi
  PUSHED+=("$target")
done < <(LC_ALL=C sort -k1,1 "$OFF/images.txt")
rm -f "$WORK/image.tar"

# ── 3 and 4. build/pnpm-offline and build/ci-node, from the kit's files ──
PNPM_IMAGE="$REGISTRY/build/pnpm-offline:$KIT_VERSION"
CI_NODE_IMAGE="$REGISTRY/build/ci-node:$KIT_VERSION"
# The kit's own tag of node:26 (a kit before those tags: the plain one).
NODE_BASE="$REGISTRY/base/node:26"
if awk -v p="base/node:26-$KIT_VERSION" '$3 == p { found = 1 } END { exit !found }' "$OFF/images.txt"; then
  NODE_BASE="$REGISTRY/base/node:26-$KIT_VERSION"
fi
# npm_config_nodedir: node-gyp (node-pty's build) takes the image's Node
# headers instead of downloading them.
CI_NODE_ENV=(PNPM_STORE_DIR=/pnpm-offline/store npm_config_store_dir=/pnpm-offline/store npm_config_nodedir=/usr/local)

echo
echo "=== 3. $PNPM_IMAGE"
if [ "$DRY_RUN" = 1 ]; then
  echo "  would make it from offline/$(basename "$PNPM_TGZ")"
elif [ "$FORCE" = 0 ] && exists "$PNPM_IMAGE"; then
  echo "  exists (--force makes it again)"
elif [ "$TOOL" = crane ]; then
  # The archive's entries (./store/…, ./pnpm.tgz) are the layer as they are.
  crane append -f "$PNPM_TGZ" -t "$PNPM_IMAGE" >"$WORK/push.log" 2>&1 || { cat "$WORK/push.log" >&2; die "crane append failed"; }
  crane mutate "$PNPM_IMAGE" --set-platform linux/amd64 \
    -l org.opencontainers.image.version="$KIT_VERSION" -t "$PNPM_IMAGE" >"$WORK/push.log" 2>&1 || { cat "$WORK/push.log" >&2; die "crane mutate failed"; }
else
  mkdir -p "$WORK/pnpm-ctx"
  tar -xzf "$PNPM_TGZ" -C "$WORK/pnpm-ctx"
  printf 'FROM scratch\nCOPY . /\n' > "$WORK/pnpm.Dockerfile"
  docker build -q --network none --platform linux/amd64 -f "$WORK/pnpm.Dockerfile" -t "$PNPM_IMAGE" "$WORK/pnpm-ctx" >/dev/null
  docker push -q "$PNPM_IMAGE" >/dev/null
  rm -rf "$WORK/pnpm-ctx"
fi
PUSHED+=("$PNPM_IMAGE")

echo
echo "=== 4. $CI_NODE_IMAGE"
if [ "$DRY_RUN" = 1 ]; then
  echo "  would make it from $NODE_BASE and offline/$(basename "$PNPM_TGZ")"
elif [ "$FORCE" = 0 ] && exists "$CI_NODE_IMAGE"; then
  echo "  exists (--force makes it again)"
else
  # The layer: /pnpm-offline (the archive), /opt/pnpm (pnpm itself, from
  # corepack's archive) and /usr/local/bin/pnpm, pnpx.
  stage="$WORK/ci-node"
  mkdir -p "$stage/pnpm-offline" "$stage/opt/pnpm" "$stage/usr/local/bin"
  tar -xzf "$PNPM_TGZ" -C "$stage/pnpm-offline"
  # pnpm.tgz holds pnpm/<version>/… (corepack's cache layout).
  tar -xzf "$stage/pnpm-offline/pnpm.tgz" -C "$stage/opt/pnpm" --strip-components=2
  [ -f "$stage/opt/pnpm/bin/pnpm.cjs" ] || die "pnpm.tgz has no pnpm/<version>/bin/pnpm.cjs"
  ln -s /opt/pnpm/bin/pnpm.cjs "$stage/usr/local/bin/pnpm"
  ln -s /opt/pnpm/bin/pnpx.cjs "$stage/usr/local/bin/pnpx"
  if [ "$TOOL" = crane ]; then
    tar -C "$stage" --owner=0 --group=0 --numeric-owner -cf "$WORK/ci-node.tar" pnpm-offline opt usr
    tar -tf "$WORK/ci-node.tar" > "$WORK/ci-node.list"
    for f in usr/local/bin/pnpm opt/pnpm/bin/pnpm.cjs pnpm-offline/store pnpm-offline/pnpm.tgz; do
      grep -qx -e "$f" -e "$f/" "$WORK/ci-node.list" || die "the ci-node layer has no /$f"
    done
    crane append -b "$NODE_BASE" -f "$WORK/ci-node.tar" -t "$CI_NODE_IMAGE" >"$WORK/push.log" 2>&1 || { cat "$WORK/push.log" >&2; die "crane append failed"; }
    env_args=()
    for kv in "${CI_NODE_ENV[@]}"; do env_args+=(-e "$kv"); done
    crane mutate "$CI_NODE_IMAGE" "${env_args[@]}" \
      -l org.opencontainers.image.version="$KIT_VERSION" -t "$CI_NODE_IMAGE" >"$WORK/push.log" 2>&1 || { cat "$WORK/push.log" >&2; die "crane mutate failed"; }
  else
    {
      echo "FROM $NODE_BASE"
      echo "COPY . /"
      for kv in "${CI_NODE_ENV[@]}"; do echo "ENV $kv"; done
      echo "LABEL org.opencontainers.image.version=$KIT_VERSION"
    } > "$WORK/ci-node.Dockerfile"
    docker build -q --network none --platform linux/amd64 -f "$WORK/ci-node.Dockerfile" -t "$CI_NODE_IMAGE" "$stage" >/dev/null
    docker push -q "$CI_NODE_IMAGE" >/dev/null
  fi
  rm -rf "$stage" "$WORK/ci-node.tar" "$WORK/ci-node.list"
  if [ "$TOOL" = crane ]; then
    config="$(crane config "$CI_NODE_IMAGE")"
    case "$config" in *PNPM_STORE_DIR=/pnpm-offline/store*) ;; *) die "$CI_NODE_IMAGE lacks its environment (PNPM_STORE_DIR)" ;; esac
  fi
fi
PUSHED+=("$CI_NODE_IMAGE")

echo
if [ "$DRY_RUN" = 1 ]; then echo "Would push:"; else echo "In $REGISTRY:"; fi
printf '  %s\n' "${PUSHED[@]}"
cat << NEXT

Next: build with no network (docs/air-gapped.md), e.g.
  OPTIO_REGISTRY=$REGISTRY scripts/offline/build-images.sh <tag> --offline --push
and in the pipeline set OPTIO_TOOLCHAIN_VERSION=$KIT_VERSION (docs/examples/ci/README.md).
NEXT
