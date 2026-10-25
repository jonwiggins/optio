#!/usr/bin/env bash
# The offline kit's supply-chain check (docs/air-gapped.md, "The
# supply-chain check"): SBOMs, a vulnerability scan whose database travels
# with the kit, and a list of known-bad packages and images. make-kit.sh runs
# it on the connected side; inside, it checks a kit again with no network.
#
#   scripts/offline/kit-scan.sh <kit dir> [options]            connected side
#     1. an SBOM (Syft, CycloneDX JSON, packages) of every image in
#        offline/images, of the npm packages (pnpm-lock.yaml) and of the tools
#        in offline/bin                                   → offline/sbom/
#     2. Trivy's vulnerability database                   → offline/trivy-db.tgz
#     3. every SBOM scanned with it                       → offline/scan/*.trivy.json
#     4. every package and image digest against the known-bad list
#                                                         → offline/scan/KNOWN-BAD.md
#     5. the summary KIT.md shows                         → offline/scan/SUMMARY.md
#   scripts/offline/kit-scan.sh <kit dir> --offline [options]  inside, no network
#     steps 3 to 5 again for the kit's SBOMs, with the kit's database or a
#     newer one carried in (--db), against this source's known-bad list. The
#     kit isn't changed (its SHA256SUMS stay right): the reports go to --out.
#
#   --offline              see above
#   --db <trivy-db.tgz>    the vulnerability database (default: the kit's)
#   --out <dir>            where --offline writes (default <kit dir>/rescan-<date>)
#   --known-bad <file>     the list (default scripts/offline/known-bad.txt)
#   --syft-image <ref>     Syft's image (make-kit.sh passes its pinned one)
#   --trivy-image <ref>    Trivy's image (make-kit.sh passes its pinned one;
#                          --offline: the kit's, from docker load). --offline
#                          runs $TRIVY (a trivy binary) instead when it is set,
#                          or a trivy on PATH when there is no docker.
#
# Exit 1 when the known-bad list matches (don't carry the kit in), and only
# then; 2 on a usage error or a failed step (a scanner, docker, tar), whatever
# status the step had. Vulnerabilities are reported, not fatal.
# The scanners run with --network none, except the database download
# (TRIVY_DB_REPOSITORY names a mirror of it). Needs: docker (or trivy for
# --offline), tar, gzip, and node (else the kit's own offline/bin Node).
# Image archives are unpacked one at a time under $KIT_SCAN_TMP (default
# release/.kit-scan-tmp, beside the kits).
set -euo pipefail

# Paths on the command line are the caller's; the script works from the source.
CALLER="$PWD"
cd "$(dirname "$0")/../.."
ROOT="$PWD"
abs() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s' "$CALLER/$1" ;; esac; }

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

KIT=""
OFFLINE=0
DB=""
OUT=""
KNOWN_BAD="$ROOT/scripts/offline/known-bad.txt"
SYFT_IMAGE=""
TRIVY_IMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --offline) OFFLINE=1 ;;
    --db) DB="$(abs "${2:?--db needs a file}")"; shift ;;
    --out) OUT="$(abs "${2:?--out needs a directory}")"; shift ;;
    --known-bad) KNOWN_BAD="$(abs "${2:?--known-bad needs a file}")"; shift ;;
    --syft-image) SYFT_IMAGE="${2:?--syft-image needs a reference}"; shift ;;
    --trivy-image) TRIVY_IMAGE="${2:?--trivy-image needs a reference}"; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [ -n "$KIT" ]; then echo "One kit directory only (got $KIT and $1)" >&2; exit 2; fi
      KIT="$(abs "$1")"
      ;;
  esac
  shift
done
[ -n "$KIT" ] || { usage >&2; exit 2; }
[ -d "$KIT/offline" ] || { echo "$KIT is not a kit (no offline/)" >&2; exit 2; }
KIT="$(cd "$KIT" && pwd)"
OFF="$KIT/offline"
[ -f "$KNOWN_BAD" ] || { echo "No known-bad list at $KNOWN_BAD" >&2; exit 2; }
KNOWN_BAD="$(cd "$(dirname "$KNOWN_BAD")" && pwd)/$(basename "$KNOWN_BAD")"
if [ -n "$DB" ]; then
  [ -f "$DB" ] || { echo "No such database: $DB" >&2; exit 2; }
  DB="$(cd "$(dirname "$DB")" && pwd)/$(basename "$DB")"
fi

TMP_ROOT="${KIT_SCAN_TMP:-$ROOT/release/.kit-scan-tmp}"
mkdir -p "$TMP_ROOT"
WORK="$(mktemp -d "$TMP_ROOT/scan.XXXXXX")"
# Exit 1 says the known-bad list matched, and nothing else does: a step that
# fails (docker, Syft, Trivy, tar) leaves with 2, whatever its own status.
KNOWN_BAD_HIT=0
finish() {
  local status=$?
  rm -rf "$WORK"
  if [ "$status" != 0 ] && [ "$KNOWN_BAD_HIT" != 1 ]; then exit 2; fi
}
trap finish EXIT
mkdir -p "$WORK/home" "$WORK/tmp" "$WORK/cache"
PLATFORM=linux/amd64
step() { echo; echo "##### $*"; }

# node: this machine's, else the kit's own (offline/bin/node-*-linux-x64.tar.xz).
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  tarball=""
  for t in "$OFF"/bin/node-*-linux-x64.tar.xz; do if [ -f "$t" ]; then tarball="$t"; break; fi; done
  [ -n "$tarball" ] || { echo "Missing: node (and the kit has no offline/bin/node-*.tar.xz)" >&2; exit 2; }
  tar -xJf "$tarball" -C "$WORK" --strip-components=2 --wildcards '*/bin/node'
  NODE="$WORK/node"
fi
sc() { "$NODE" "$ROOT/scripts/offline/supply-chain.mjs" "$@"; }

# A container of one scanner: this user, the work directory at /work, no network.
scanner() { # <image> <docker args...> -- <scanner args...>
  local image="$1" args=()
  shift
  while [ "$1" != "--" ]; do args+=("$1"); shift; done
  shift
  docker run --rm --platform "$PLATFORM" --user "$(id -u):$(id -g)" \
    -e HOME=/work/home -e TMPDIR=/work/tmp -e XDG_CACHE_HOME=/work/home/.cache \
    -v "$WORK:/work" "${args[@]}" "$image" "$@"
}
# The version in an image reference's tag (anchore/syft:v1.54.1@sha256:… → 1.54.1).
tag_version() { local t="${1%@*}"; t="${t##*:}"; printf '%s' "${t#v}"; }

# ── Trivy: an image, or a binary for --offline without docker ──
TRIVY_BIN=""
if [ "$OFFLINE" = 1 ] && [ -z "$TRIVY_IMAGE" ]; then
  if [ -n "${TRIVY:-}" ]; then
    TRIVY_BIN="$TRIVY"
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    # The kit's own Trivy, as make-kit.sh saved it.
    file="$(awk '$3 ~ /^base\/trivy:/ { print $1; exit }' "$OFF/images.txt")"
    [ -n "$file" ] && [ -f "$OFF/$file" ] || { echo "The kit has no base/trivy image (offline/images.txt)" >&2; exit 2; }
    loaded="$(gunzip -c "$OFF/$file" | docker load | sed -n 's/^Loaded image\( ID\)\{0,1\}: //p' | tail -n1)"
    [ -n "$loaded" ] || { echo "docker load of offline/$file named no image" >&2; exit 2; }
    TRIVY_IMAGE="$loaded"
  else
    TRIVY_BIN="$(command -v trivy || true)"
    [ -n "$TRIVY_BIN" ] || { echo "Needs docker (the kit's Trivy image) or a trivy binary (\$TRIVY or PATH)" >&2; exit 2; }
  fi
fi
if [ -z "$TRIVY_BIN" ] && [ -z "$TRIVY_IMAGE" ]; then
  echo "--trivy-image is needed (make-kit.sh passes it)" >&2
  exit 2
fi
if [ "$OFFLINE" = 0 ] && [ -z "$SYFT_IMAGE" ]; then
  echo "--syft-image is needed (make-kit.sh passes it)" >&2
  exit 2
fi
# Trivy, offline: the database at /work/cache/db, nothing fetched, no update or telemetry calls.
trivy_offline() { # <trivy args...> (paths under /work)
  local common=(--cache-dir /work/cache --cache-backend memory --skip-db-update --skip-java-db-update
    --offline-scan --skip-version-check --disable-telemetry --quiet)
  if [ -n "$TRIVY_BIN" ]; then
    local a local_args=()
    for a in "$@" "${common[@]}"; do local_args+=("${a/#\/work\//$WORK/}"); done
    "$TRIVY_BIN" "${local_args[@]}"
  else
    scanner "$TRIVY_IMAGE" --network none -- "$@" "${common[@]}"
  fi
}

if [ "$OFFLINE" = 1 ]; then
  SBOM_DIR="$OFF/sbom"
  [ -n "$(find "$SBOM_DIR" -maxdepth 1 -name '*.cdx.json' 2>/dev/null | head -n1)" ] ||
    { echo "The kit has no SBOMs (offline/sbom/): created without scanning, for example with make-kit.sh --skip-scan" >&2; exit 2; }
  OUT="${OUT:-$KIT/rescan-$(date -u +%Y-%m-%d)}"
  mkdir -p "$OUT"
  OUT="$(cd "$OUT" && pwd)"
  SCAN_DIR="$OUT"
  DB="${DB:-$OFF/trivy-db.tgz}"
  [ -f "$DB" ] || { echo "No vulnerability database: $DB (--db <trivy-db.tgz>)" >&2; exit 2; }
  WHERE="$(basename "$OUT")/"
  case "$DB" in "$OFF/trivy-db.tgz") DB_SHOWN=offline/trivy-db.tgz ;; *) DB_SHOWN="$(basename "$DB")" ;; esac
else
  for tool in docker tar gzip; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Missing: $tool" >&2; exit 2; }
  done
  SBOM_DIR="$OFF/sbom"
  SCAN_DIR="$OFF/scan"
  rm -rf "$SBOM_DIR" "$SCAN_DIR"
  mkdir -p "$SBOM_DIR" "$SCAN_DIR"
  WHERE="offline/scan/"
  DB_SHOWN=offline/trivy-db.tgz

  # ── 1. SBOMs: every image archive (once each), the npm packages, the tools ──
  step "SBOMs (Syft $(tag_version "$SYFT_IMAGE"), offline/sbom/)"
  syft() { # <source> <name> [syft args...]: offline/sbom/<name>.cdx.json
    local src="$1" name="$2"
    shift 2
    scanner "$SYFT_IMAGE" --network none -e SYFT_CHECK_FOR_APP_UPDATE=false \
      -e SYFT_FILE_METADATA_SELECTION=none -v "$SBOM_DIR:/sbom" -- \
      scan "$src" -o "cyclonedx-json=/sbom/$name.cdx.json" -q "$@"
  }
  : >"$SBOM_DIR/digests.txt"
  declare -A SEEN_FILE=()
  while read -r file ref _path; do
    [ -n "$file" ] && [ -z "${SEEN_FILE[$file]:-}" ] || continue
    SEEN_FILE[$file]=1
    name="$(basename "$file" .tar.gz)"
    gunzip -c "$OFF/$file" >"$WORK/image.tar"
    # What the archive says it is: its platform manifests (index.json) and its
    # config (manifest.json), for the known-bad list's image digests.
    digests="$( { tar -xOf "$WORK/image.tar" index.json 2>/dev/null | grep -o '"digest":"sha256:[0-9a-f]*"' | cut -d'"' -f4
      tar -xOf "$WORK/image.tar" manifest.json 2>/dev/null | grep -o '"Config":"[^"]*"' | grep -o '[0-9a-f]\{64\}' | sed 's/^/sha256:/'
    } | awk '!seen[$0]++' | paste -sd' ' - || true)"
    printf '%s %s\n' "$file" "$digests" >>"$SBOM_DIR/digests.txt"
    echo "  $ref"
    syft "docker-archive:/work/image.tar" "$name" --source-name "${ref%@*}" ${digests:+--source-version "${digests%% *}"}
    rm -f "$WORK/image.tar"
  done <"$OFF/images.txt"
  mkdir -p "$WORK/npm"
  cp package.json pnpm-lock.yaml "$WORK/npm/"
  echo "  npm packages (pnpm-lock.yaml)"
  syft "dir:/work/npm" npm-packages --source-name "optio npm packages" \
    --source-version "$(sha256sum pnpm-lock.yaml | cut -c1-16)"
  # The tools: helm, kubectl, crane, buildctl (Go) and Node from its tarball.
  mkdir -p "$WORK/tools"
  find "$OFF/bin" -maxdepth 1 -type f ! -name '*.tar.*' -exec cp {} "$WORK/tools/" \;
  for t in "$OFF"/bin/node-*-linux-x64.tar.xz; do
    [ -f "$t" ] && tar -xJf "$t" -C "$WORK/tools" --strip-components=2 --wildcards '*/bin/node'
  done
  echo "  tools (offline/bin)"
  syft "dir:/work/tools" tools --source-name "offline/bin"
  rm -rf "$WORK/npm" "$WORK/tools"

  # ── 2. The vulnerability database, for the scan here and inside ──
  step "Trivy's vulnerability database (offline/trivy-db.tgz)"
  scanner "$TRIVY_IMAGE" ${TRIVY_DB_REPOSITORY:+-e TRIVY_DB_REPOSITORY="$TRIVY_DB_REPOSITORY"} -- \
    image --download-db-only --cache-dir /work/cache --no-progress --skip-version-check --disable-telemetry
  tar -C "$WORK/cache" --owner=0 --group=0 --numeric-owner -czf "$OFF/trivy-db.tgz" db
  DB="$OFF/trivy-db.tgz"
fi

# ── 3. The scan: every SBOM, with the database ──
# Trivy's version as Trivy says it: an image docker load named by its ID (or
# name@digest) has no tag to read it from.
if [ -n "$TRIVY_BIN" ]; then
  TRIVY_VERSION="$("$TRIVY_BIN" --version 2>/dev/null | sed -n 's/^Version: *//p' | head -n1)"
else
  TRIVY_VERSION="$(scanner "$TRIVY_IMAGE" --network none -- --version 2>/dev/null | sed -n 's/^Version: *//p' | head -n1)"
fi
if [ ! -f "$WORK/cache/db/trivy.db" ]; then tar -xzf "$DB" -C "$WORK/cache"; fi
[ -f "$WORK/cache/db/metadata.json" ] || { echo "$DB holds no db/metadata.json: not a Trivy database" >&2; exit 2; }
cp "$WORK/cache/db/metadata.json" "$SCAN_DIR/trivy-db-metadata.json"
step "Vulnerabilities (Trivy ${TRIVY_VERSION:-?}, database of $(sed -n 's/.*"UpdatedAt":"\([0-9-]*\)T.*/\1/p' "$SCAN_DIR/trivy-db-metadata.json"))"
mkdir -p "$WORK/sbom" "$WORK/scan"
for f in "$SBOM_DIR"/*.cdx.json; do
  name="$(basename "$f" .cdx.json)"
  cp "$f" "$WORK/sbom/"
  trivy_offline sbom --scanners vuln --format json --output "/work/scan/$name.trivy.json" "/work/sbom/$name.cdx.json"
  cp "$WORK/scan/$name.trivy.json" "$SCAN_DIR/"
  echo "  $name"
done

# ── 4. The known-bad list ──
step "Known-bad list ($KNOWN_BAD)"
kb=0
digests=()
if [ -f "$SBOM_DIR/digests.txt" ]; then digests=(--digests "$SBOM_DIR/digests.txt"); fi
sc known-bad --list "$KNOWN_BAD" --images "$OFF/images.txt" "${digests[@]}" "$SBOM_DIR" >"$SCAN_DIR/KNOWN-BAD.md" || kb=$?
cat "$SCAN_DIR/KNOWN-BAD.md"
[ "$kb" -le 1 ] || exit 2

# ── 5. The summary ──
sc summary --sbom-dir "$SBOM_DIR" --scan-dir "$SCAN_DIR" --db "$SCAN_DIR/trivy-db-metadata.json" \
  --known-bad "$SCAN_DIR/KNOWN-BAD.md" ${SYFT_IMAGE:+--syft "$(tag_version "$SYFT_IMAGE")"} \
  ${TRIVY_VERSION:+--trivy "$TRIVY_VERSION"} --where "$WHERE" --db-file "$DB_SHOWN" >"$SCAN_DIR/SUMMARY.md"
step "Summary ($SCAN_DIR/SUMMARY.md)"
cat "$SCAN_DIR/SUMMARY.md"
if [ "$kb" = 1 ]; then
  echo >&2
  echo "The kit holds something on the known-bad list (above): don't carry it in." >&2
  KNOWN_BAD_HIT=1
  exit 1
fi
