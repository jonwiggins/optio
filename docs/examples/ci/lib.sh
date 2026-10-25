# Shared by the job scripts in docs/examples/ci/
# (sourced, never run). POSIX sh: the BuildKit image (moby/buildkit:rootless)
# has no bash.
#
#   . docs/examples/ci/lib.sh
#   optio_trust_ca        # OPTIO_CA_FILE → the trust store of every tool a job runs
#   optio_pnpm_install    # the workspace's packages from the offline pnpm store
#   optio_file_var NAME   # the path of a File variable (or of a copy of its text)
#
# docs/examples/ci/README.md lists the variables.

die() {
  echo "ERROR: $*" >&2
  exit 1
}

section() {
  printf '\n=== %s\n' "$*"
}

# optio_file_var <variable name>: prints a path holding the variable's
# content. A GitLab variable of type File holds a path already; one of type
# Variable holds the text itself, which is written to a private temporary
# file. Prints nothing when the variable is unset or empty.
optio_file_var() {
  eval "_v=\${$1:-}"
  [ -n "$_v" ] || return 0
  if [ -f "$_v" ]; then
    printf '%s\n' "$_v"
    return 0
  fi
  case "$_v" in
    /*) if ! printf '%s' "$_v" | grep -q '[[:space:]]'; then die "$1 names a file that does not exist: $_v"; fi ;;
  esac
  _f="$(mktemp "${TMPDIR:-/tmp}/optio-$1.XXXXXX")"
  chmod 600 "$_f"
  printf '%s\n' "$_v" >"$_f"
  printf '%s\n' "$_f"
}

# Your CA (OPTIO_CA_FILE: a CI/CD variable of type File, or a path) for
# everything a job runs:
#   Node                          NODE_EXTRA_CA_CERTS (added to Node's own list)
#   helm, kubectl, buildctl,      SSL_CERT_FILE: a bundle of the image's CAs
#   buildkitd (Go), curl, git,    plus this one (Go reads SSL_CERT_FILE on Linux)
#   Python                        CURL_CA_BUNDLE, GIT_SSL_CAINFO, REQUESTS_CA_BUNDLE
# OPTIO_CA_FILE is set to the file's path. Without it nothing changes.
optio_trust_ca() {
  [ -n "${OPTIO_CA_FILE:-}" ] || return 0
  OPTIO_CA_FILE="$(optio_file_var OPTIO_CA_FILE)"
  export OPTIO_CA_FILE
  [ -s "$OPTIO_CA_FILE" ] || die "OPTIO_CA_FILE ($OPTIO_CA_FILE) is missing or empty"
  grep -q 'BEGIN CERTIFICATE' "$OPTIO_CA_FILE" || die "OPTIO_CA_FILE ($OPTIO_CA_FILE) holds no PEM certificate"
  OPTIO_CA_BUNDLE="${TMPDIR:-/tmp}/optio-ca-bundle.pem"
  : >"$OPTIO_CA_BUNDLE"
  for system in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do
    if [ -s "$system" ]; then
      cat "$system" >>"$OPTIO_CA_BUNDLE"
      break
    fi
  done
  # A File variable's last line may lack its newline; keep the PEM blocks apart.
  echo >>"$OPTIO_CA_BUNDLE"
  cat "$OPTIO_CA_FILE" >>"$OPTIO_CA_BUNDLE"
  echo >>"$OPTIO_CA_BUNDLE"
  export OPTIO_CA_BUNDLE
  export SSL_CERT_FILE="$OPTIO_CA_BUNDLE" CURL_CA_BUNDLE="$OPTIO_CA_BUNDLE"
  export GIT_SSL_CAINFO="$OPTIO_CA_BUNDLE" REQUESTS_CA_BUNDLE="$OPTIO_CA_BUNDLE"
  export NODE_EXTRA_CA_CERTS="$OPTIO_CA_FILE"
}

# `pnpm install` with no registry, from the store the build/ci-node image
# carries (PNPM_STORE_DIR, default /pnpm-offline/store). --ignore-scripts as
# in the Dockerfiles (husky's hook setup has no use in CI); the one allowed
# build script, node-pty's node-gyp compile, then runs by itself: the CLI's
# tests load its native module. node-gyp would download the Node headers, so
# it is pointed at the image's own (npm_config_nodedir: the Node prefix, which
# in node:22 has include/node; python3, make and g++ are there too).
# node_modules restored from the job cache makes this a quick check, and a
# cached build of node-pty is kept. OPTIO_SKIP_INSTALL=1 skips it all
# (node_modules already there).
optio_pnpm_install() {
  if [ "${OPTIO_SKIP_INSTALL:-0}" = 1 ]; then
    echo "OPTIO_SKIP_INSTALL=1: using the node_modules that are there"
    return 0
  fi
  store="${PNPM_STORE_DIR:-/pnpm-offline/store}"
  if [ ! -d "$store" ]; then
    npm_config_nodedir="${npm_config_nodedir:-/usr/local}" pnpm install --frozen-lockfile
    return
  fi
  section "pnpm install --offline (store $store)"
  COREPACK_ENABLE_NETWORK=0 HUSKY=0 pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir "$store"
  if ls node_modules/.pnpm/node-pty@*/node_modules/node-pty/build/Release/pty.node >/dev/null 2>&1; then
    return 0
  fi
  nodedir="${npm_config_nodedir:-$(dirname "$(dirname "$(command -v node)")")}"
  [ -f "$nodedir/include/node/node.h" ] || die "no Node headers in $nodedir/include/node (set npm_config_nodedir to a Node install that has them, e.g. the unpacked node-v22 tarball of the kit's offline/bin)"
  section "node-pty (pnpm rebuild, Node headers from $nodedir)"
  COREPACK_ENABLE_NETWORK=0 npm_config_nodedir="$nodedir" pnpm --filter @optio/cli rebuild node-pty
}
