#!/bin/sh
# Optio's database backup job (templates/backup-cronjob.yaml; docs/backup.md).
# One POSIX sh script for every container of the job, run as
#
#   optio-backup.sh <role>
#
#   pvc     backup.target=pvc: the only container (PostgreSQL's image), the
#           claim mounted at $OPTIO_BACKUP_DIR
#   fetch   backup.target=s3: the first init container (an image with the AWS CLI)
#   db      backup.target=s3: the second init container (PostgreSQL's image)
#   store   backup.target=s3: the container (the AWS CLI image)
#
# and, through `kubectl exec` in a copy job's pod (pvc only; backup-db.sh
# --to / --download and restore-db.sh <file> run these):
#
#   which <dump>   the name a dump's name, latest or latest-pre-upgrade means
#   accept <name>  an upload ($OPTIO_BACKUP_DIR/.<name>.upload, and
#                  .<name>.sha256.upload when one came with it), checked like
#                  a new dump, then kept as <name>
#
# What a run does follows from its Job's name ($JOB_NAME, the pod's label
# batch.kubernetes.io/job-name) after the CronJob's name ($OPTIO_BACKUP_CRONJOB)
# and a dash; scripts/backup/backup-db.sh and restore-db.sh name the jobs
# they start this way:
#
#   <digits>     the schedule      a dump: optio-<UTC time>.dump
#   now-…        by hand           a dump: optio-<UTC time>-manual.dump
#   pre-…        before an upgrade a dump: optio-<UTC time>-pre-upgrade.dump
#   restore-…    restore           $OPTIO_RESTORE_DUMP into the live database
#   drill-…      a restore drill   $OPTIO_RESTORE_DUMP into the new database $OPTIO_RESTORE_INTO
#   list-…       list              the dumps there are
#   copy-…       copy (pvc)        holds the volume while a script copies dumps
#                                  out or in, until it is released
#                                  ($OPTIO_BACKUP_DIR/.optio-release-<job>) or
#                                  $OPTIO_BACKUP_HOLD_SECONDS (1800) pass without
#                                  a sign of life from it (.optio-alive-<job>)
#
# A drill only ever drops a database a drill made: it marks the one it makes
# (COMMENT ON DATABASE '$DRILL_MARK …'), makes one again only when it carries
# that mark, and refuses the names a restore gives (…_before_…, …_restore_…).
# apps/api/src/services/database-restore-check.ts drops it by the same mark.
#
# Any other name is a dump. A dump is written to a hidden partial file, read
# back with `pg_restore --list` (it must hold table data and Optio's
# migrations table, $OPTIO_BACKUP_REQUIRE_TABLE), given a .sha256 and only
# then renamed (or uploaded) to its name; then the oldest are pruned: the
# newest $OPTIO_BACKUP_KEEP dumps are kept, and apart from them the newest
# $OPTIO_BACKUP_KEEP_PRE_UPGRADE taken before upgrades.
#
# A restore never changes the live database until the dump has been checked
# and restored in full: with the right to create databases it restores into a
# new database and swaps the names, keeping the old one as
# <db>_before_<time>; without it, it replaces the schemas public and drizzle
# in one transaction, which rolls back on any error.
#
# The lines a caller reads are KEY=value on stdout: OPTIO_BACKUP_DUMP,
# OPTIO_BACKUP_SIZE, OPTIO_BACKUP_LOCATION, OPTIO_BACKUP_LIST,
# OPTIO_RESTORE_DUMP, OPTIO_RESTORE_METHOD, OPTIO_RESTORE_KEPT,
# OPTIO_RESTORE_DATABASE.
#
# Environment: DATABASE_URL (a postgres:// URL, as the API's), OPTIO_BACKUP_DIR
# (/backup), OPTIO_BACKUP_KEEP (7), OPTIO_BACKUP_KEEP_PRE_UPGRADE (3),
# OPTIO_BACKUP_REQUIRE_TABLE (drizzle.__drizzle_migrations; empty: none),
# OPTIO_BACKUP_PG_DUMP_ARGS (more pg_dump arguments), OPTIO_BACKUP_LOCATION
# (shown), OPTIO_RESTORE_DUMP, OPTIO_RESTORE_INTO, and
# for S3: OPTIO_BACKUP_S3_ENDPOINT, _BUCKET, _PREFIX, _REGION, _PATH_STYLE,
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
set -eu

ROLE="${1:-}"
ARG="${2:-}"
DIR="${OPTIO_BACKUP_DIR:-/backup}"
TMP="${TMPDIR:-/tmp}"
REQUIRE="${OPTIO_BACKUP_REQUIRE_TABLE-drizzle.__drizzle_migrations}"
NAME_RE='^optio-[0-9]{8}T[0-9]{6}Z(-[a-z]+(-[a-z]+)*)?\.dump$'
# The comment a drill's database carries (database-restore-check.ts DRILL_DATABASE_MARK).
DRILL_MARK='optio restore drill'

log() { printf '%s optio-backup %s: %s\n' "$(date -u +%H:%M:%S)" "${ROLE:-?}" "$*"; }
die() {
  log "ERROR: $*" >&2
  exit 1
}

# Stopped (the job deleted, its deadline passed): the shell (PID 1) notes it
# once the command it runs ends, and a restore then stops before it swaps the
# databases (restore-db.sh leaves the API stopped while that can happen).
STOPPED=""
trap 'STOPPED=1' TERM INT

# keep_count <value> <default>: a whole number, at least 1.
keep_count() {
  case "$1" in '' | *[!0-9]*) echo "$2" ;; *) if [ "$1" -lt 1 ]; then echo 1; else echo "$1"; fi ;; esac
}
KEEP="$(keep_count "${OPTIO_BACKUP_KEEP:-}" 7)"
KEEP_PRE="$(keep_count "${OPTIO_BACKUP_KEEP_PRE_UPGRADE:-}" 3)"

# ── What this run is ───────────────────────────────────────────────────────
# mode_of <job name> <cronjob name>: "<mode> <kind>"
mode_of() {
  rest="${1#"$2"-}"
  if [ -z "$1" ] || [ -z "$2" ] || [ "$rest" = "$1" ]; then
    echo "backup scheduled"
    return
  fi
  case "$rest" in
    now-*) echo "backup manual" ;;
    pre-*) echo "backup pre-upgrade" ;;
    restore-*) echo "restore -" ;;
    drill-*) echo "drill -" ;;
    list-*) echo "list -" ;;
    copy-*) echo "copy -" ;;
    *) echo "backup scheduled" ;;
  esac
}
set -- $(mode_of "${JOB_NAME:-}" "${OPTIO_BACKUP_CRONJOB:-}")
MODE="$1"
KIND="$2"

# ── Names ──────────────────────────────────────────────────────────────────
# dump_names: stdin → only the names this job writes (anything else in the
# directory or bucket is left alone).
dump_names() { grep -E "$NAME_RE" || true; }

# prune_names <keep>: stdin (one group's names) → the ones past the newest <keep>.
prune_names() { sort -r | awk -v keep="$1" 'NR > keep'; }

# group <regular|pre-upgrade>: stdin → that group's names
group() {
  if [ "$1" = pre-upgrade ]; then grep -e '-pre-upgrade\.dump$' || true; else grep -v -e '-pre-upgrade\.dump$' || true; fi
}

# to_prune: stdin (every dump name) → the names to delete, both groups
to_prune() {
  all="$(cat)"
  printf '%s\n' "$all" | dump_names | group regular | prune_names "$KEEP"
  printf '%s\n' "$all" | dump_names | group pre-upgrade | prune_names "$KEEP_PRE"
}

# resolve <wanted>: stdin (the names there are) → the one name meant
# (a name, "latest" or "latest-pre-upgrade"), or nothing.
resolve() {
  case "$1" in
    latest) dump_names | sort | tail -n 1 ;;
    latest-pre-upgrade) dump_names | group pre-upgrade | sort | tail -n 1 ;;
    *) dump_names | grep -x -F -e "$1" || true ;;
  esac
}

# The dump a restore, drill or download asks for: a name, latest, latest-pre-upgrade.
wanted_dump() {
  want="${OPTIO_RESTORE_DUMP:-}"
  [ -n "$want" ] || die "no dump named: the ConfigMap ${OPTIO_BACKUP_CRONJOB:-<cronjob>}-restore holds none (scripts/backup/restore-db.sh sets it)"
  case "$want" in
    latest | latest-pre-upgrade) ;;
    *) printf '%s\n' "$want" | grep -qE "$NAME_RE" || die "not a dump's name: $want" ;;
  esac
  printf '%s\n' "$want"
}

size_of() { wc -c <"$1" | tr -d ' '; }

new_dump_name() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  case "$KIND" in
    manual) echo "optio-$stamp-manual.dump" ;;
    pre-upgrade) echo "optio-$stamp-pre-upgrade.dump" ;;
    *) echo "optio-$stamp.dump" ;;
  esac
}

# ── TLS ────────────────────────────────────────────────────────────────────
# roots_file: the image's CAs in one file (printed).
roots_file() {
  f="$TMP/optio-backup-roots.pem"
  : >"$f"
  for c in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do
    if [ -n "$c" ] && [ -s "$c" ]; then
      cat "$c" >>"$f"
      echo >>"$f"
    fi
  done
  if [ -s "$f" ]; then echo "$f"; fi
}

# PostgreSQL over TLS, as the API connects: a URL that names its own
# sslrootcert keeps it; verify-ca / verify-full without one trusts the
# image's CAs. (libpq's default, ~/.postgresql/root.crt, is never there.)
pg_tls() {
  case "${DATABASE_URL:-}" in *sslrootcert=*) return 0 ;; esac
  case "${DATABASE_URL:-}" in *sslmode=verify-ca* | *sslmode=verify-full*) ;; *) return 0 ;; esac
  roots="$(roots_file)"
  if [ -n "$roots" ]; then
    PGSSLROOTCERT="$roots"
    export PGSSLROOTCERT
  fi
}

# ── Database URLs ──────────────────────────────────────────────────────────
# url_db <url>: the database a postgres:// URL names
url_db() {
  rest="${1#*://}"
  rest="${rest%%\?*}"
  case "$rest" in */*) echo "${rest#*/}" ;; *) echo "" ;; esac
}

# url_with_db <url> <database>: the same URL naming another database
url_with_db() {
  scheme="${1%%://*}"
  rest="${1#*://}"
  query=""
  case "$rest" in *\?*) query="?${rest#*\?}" ;; esac
  rest="${rest%%\?*}"
  authority="${rest%%/*}"
  printf '%s://%s/%s%s\n' "$scheme" "$authority" "$2" "$query"
}

# An identifier this script will quote into SQL: letters, digits, _ only.
plain_ident() { printf '%s\n' "$1" | grep -qE '^[A-Za-z_][A-Za-z0-9_]{0,62}$'; }

need_url() {
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set"
  case "$DATABASE_URL" in postgres://* | postgresql://*) ;; *) die "DATABASE_URL is not a postgres:// URL" ;; esac
  pg_tls
}

psql_at() { psql -X -q -At -v ON_ERROR_STOP=1 --no-password "$@"; }

# maint_url: a URL for a database on the same server other than the live one
# (postgres, else template1), or nothing when neither answers.
maint_url() {
  for m in postgres template1; do
    u="$(url_with_db "$DATABASE_URL" "$m")"
    if psql_at -d "$u" -c 'SELECT 1' >/dev/null 2>&1; then
      echo "$u"
      return 0
    fi
  done
}

# ── Checking a dump ────────────────────────────────────────────────────────
# check_dump <file>: pg_restore reads it, it holds table data, and Optio's
# migrations table ($OPTIO_BACKUP_REQUIRE_TABLE) is in it.
check_dump() {
  toc="$TMP/optio-backup-toc.$$"
  if ! pg_restore --list "$1" >"$toc" 2>"$toc.err"; then
    log "pg_restore --list can't read $(basename "$1"): $(head -c 400 "$toc.err")"
    rm -f "$toc" "$toc.err"
    return 1
  fi
  entries="$(grep -c '^[0-9]' "$toc" || true)"
  tables="$(grep -c ' TABLE DATA ' "$toc" || true)"
  if [ "${tables:-0}" -lt 1 ]; then
    log "$(basename "$1") holds no table data"
    rm -f "$toc" "$toc.err"
    return 1
  fi
  if [ -n "$REQUIRE" ]; then
    if ! grep -q " TABLE DATA ${REQUIRE%%.*} ${REQUIRE#*.} " "$toc"; then
      log "$(basename "$1") has no $REQUIRE: is DATABASE_URL Optio's database?"
      rm -f "$toc" "$toc.err"
      return 1
    fi
  fi
  rm -f "$toc" "$toc.err"
  log "checked: pg_restore reads it ($entries entries, $tables tables with data)"
}

# check_sum <dir> <name>: the .sha256 next to it matches (when there is one)
check_sum() {
  if [ -f "$1/$2.sha256" ]; then
    (cd "$1" && sha256sum -c "$2.sha256" >/dev/null 2>&1) || die "$2 doesn't match its .sha256: the file is damaged"
    log "$2 matches its .sha256"
  else
    log "$2 has no .sha256 next to it: not compared"
  fi
}

# ── Dumping ────────────────────────────────────────────────────────────────
# dump_to <dir>: a new, checked dump there (with its .sha256); prints its name
dump_to() {
  mkdir -p "$1"
  # A run that died half-way left its partial file; anything a day old is that.
  find "$1" -maxdepth 1 -name '.optio-*.partial' -mmin +1440 -exec rm -f {} \; 2>/dev/null || true
  name="$(new_dump_name)"
  part="$1/.$name.partial"
  log "pg_dump of $(url_db "$DATABASE_URL") → $name" >&2
  # shellcheck disable=SC2086 # OPTIO_BACKUP_PG_DUMP_ARGS is a list of arguments
  if ! pg_dump --format=custom --no-password ${OPTIO_BACKUP_PG_DUMP_ARGS:-} --dbname="$DATABASE_URL" --file="$part"; then
    rm -f "$part"
    die "pg_dump failed"
  fi
  if ! check_dump "$part" >&2; then
    rm -f "$part"
    die "the dump didn't pass its check; nothing was kept"
  fi
  sum="$(sha256sum "$part" | cut -d' ' -f1)"
  printf '%s  %s\n' "$sum" "$name" >"$1/.$name.sha256.partial"
  mv "$1/.$name.sha256.partial" "$1/$name.sha256"
  mv "$part" "$1/$name"
  log "$name: $(size_of "$1/$name") bytes, sha256 $sum" >&2
  echo "$name"
}

# ── S3 (the AWS CLI) ───────────────────────────────────────────────────────
s3_setup() {
  [ -n "${OPTIO_BACKUP_S3_BUCKET:-}" ] || die "backup.s3.bucket is not set"
  command -v aws >/dev/null 2>&1 || die "no aws command in this image (backup.s3.image needs the AWS CLI)"
  AWS_CONFIG_FILE="$TMP/optio-backup-aws-config"
  style=path
  case "${OPTIO_BACKUP_S3_PATH_STYLE:-true}" in false | False | FALSE | 0) style=virtual ;; esac
  printf '[default]\nregion = %s\ns3 =\n    addressing_style = %s\n' "${OPTIO_BACKUP_S3_REGION:-us-east-1}" "$style" >"$AWS_CONFIG_FILE"
  export AWS_CONFIG_FILE
  BUCKET="$OPTIO_BACKUP_S3_BUCKET"
  PREFIX="${OPTIO_BACKUP_S3_PREFIX:-}"
  PREFIX="${PREFIX#/}"
  case "$PREFIX" in '' | */) ;; *) PREFIX="$PREFIX/" ;; esac
  S3_BASE="s3://$BUCKET/$PREFIX"
}

awscli() {
  if [ -n "${OPTIO_BACKUP_S3_ENDPOINT:-}" ]; then
    aws --endpoint-url "$OPTIO_BACKUP_S3_ENDPOINT" "$@"
  else
    aws "$@"
  fi
}

# s3_ls: `aws s3 ls` of the prefix. The AWS CLI fails, saying nothing, on a
# prefix with nothing under it yet: no dumps, when the bucket itself answers.
s3_ls() {
  if out="$(awscli s3 ls "$S3_BASE" 2>"$TMP/optio-s3-ls.err")"; then
    printf '%s\n' "$out"
    return 0
  fi
  if [ ! -s "$TMP/optio-s3-ls.err" ] && awscli s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
    return 0
  fi
  die "can't list $S3_BASE: $(head -c 300 "$TMP/optio-s3-ls.err")"
}

# s3_names: the dump names under the prefix
s3_names() {
  out="$(s3_ls)" || exit 1
  printf '%s\n' "$out" | awk 'NF >= 4 { print $4 }' | dump_names
}

s3_size() { awscli s3api head-object --bucket "$BUCKET" --key "$PREFIX$1" --query ContentLength --output text; }

# ── The modes ──────────────────────────────────────────────────────────────
prune_dir() {
  ls -1 "$1" | to_prune | while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -f "$1/$old" "$1/$old.sha256"
    log "pruned $old"
  done
}

prune_s3() {
  s3_names | to_prune | while IFS= read -r old; do
    [ -n "$old" ] || continue
    awscli s3 rm --only-show-errors "$S3_BASE$old"
    awscli s3 rm --only-show-errors "$S3_BASE$old.sha256" || true
    log "pruned $old"
  done
}

result_lines() { # <name> <bytes> <location>
  echo "OPTIO_BACKUP_DUMP=$1"
  echo "OPTIO_BACKUP_SIZE=$2"
  echo "OPTIO_BACKUP_LOCATION=$3"
}

backup_pvc() {
  need_url
  name="$(dump_to "$DIR")"
  prune_dir "$DIR"
  log "kept $(ls -1 "$DIR" | dump_names | wc -l | tr -d ' ') dumps (newest $KEEP, and $KEEP_PRE from before upgrades)"
  result_lines "$name" "$(size_of "$DIR/$name")" "${OPTIO_BACKUP_LOCATION:-$DIR}/$name"
}

backup_db() { # s3: the dump into the scratch volume, for store to upload
  need_url
  rm -f "$DIR"/optio-*.dump "$DIR"/optio-*.dump.sha256
  name="$(dump_to "$DIR")"
  echo "$name" >"$DIR/.optio-dumped"
}

backup_store() {
  s3_setup
  [ -s "$DIR/.optio-dumped" ] || die "the dump container left nothing to upload"
  name="$(cat "$DIR/.optio-dumped")"
  [ -f "$DIR/$name" ] && [ -f "$DIR/$name.sha256" ] || die "$name is missing from $DIR"
  log "uploading $name to $S3_BASE"
  # The checksum first: a dump is only listed once both are there.
  awscli s3 cp --only-show-errors "$DIR/$name.sha256" "$S3_BASE$name.sha256"
  awscli s3 cp --only-show-errors "$DIR/$name" "$S3_BASE$name"
  local_size="$(size_of "$DIR/$name")"
  remote_size="$(s3_size "$name")" || die "$name was uploaded but can't be read back"
  [ "$remote_size" = "$local_size" ] || die "$name is $remote_size bytes in the bucket, $local_size here"
  log "uploaded: $remote_size bytes"
  prune_s3
  result_lines "$name" "$local_size" "$S3_BASE$name"
}

fetch_s3() { # restore / drill: the dump from the bucket into the scratch volume
  s3_setup
  want="$(wanted_dump)"
  name="$(s3_names | resolve "$want")"
  [ -n "$name" ] || die "no dump $want in $S3_BASE"
  mkdir -p "$DIR"
  log "downloading $name from $S3_BASE"
  awscli s3 cp --only-show-errors "$S3_BASE$name" "$DIR/$name"
  if awscli s3 cp --only-show-errors "$S3_BASE$name.sha256" "$DIR/$name.sha256" 2>/dev/null; then :; else rm -f "$DIR/$name.sha256"; fi
  check_sum "$DIR" "$name"
  echo "$name" >"$DIR/.optio-fetched"
}

list_dir() {
  log "dumps in ${OPTIO_BACKUP_LOCATION:-$DIR}:"
  ls -1 "$DIR" | dump_names | sort | while IFS= read -r n; do
    echo "OPTIO_BACKUP_LIST=$n $(size_of "$DIR/$n")"
  done
}

list_s3() {
  s3_setup
  log "dumps in $S3_BASE:"
  out="$(s3_ls)" || exit 1
  printf '%s\n' "$out" | awk 'NF >= 4 { print $4, $3 }' | while read -r n bytes; do
    if printf '%s\n' "$n" | grep -qE "$NAME_RE"; then echo "OPTIO_BACKUP_LIST=$n $bytes"; fi
  done | sort
}

# restore_from <dir> <name>: the checked dump into the live database (restore)
# or into $OPTIO_RESTORE_INTO (drill)
restore_from() {
  need_url
  src="$1/$2"
  [ -f "$src" ] || die "no dump $2 in ${OPTIO_BACKUP_LOCATION:-$1}"
  check_sum "$1" "$2"
  check_dump "$src" || die "$2 didn't pass its check; the database was not touched"
  live="$(url_db "$DATABASE_URL")"
  plain_ident "$live" || die "the database name in DATABASE_URL ($live) isn't a plain name this script will quote"
  stamp="$(date -u +%Y%m%d%H%M%S)"
  base="$(printf '%s' "$live" | cut -c1-40)"
  echo "OPTIO_RESTORE_DUMP=$2"
  if [ "$MODE" = drill ]; then
    into="${OPTIO_RESTORE_INTO:-${base}_drill}"
    plain_ident "$into" || die "not a plain database name: $into"
    [ "$into" != "$live" ] || die "a drill restores next to the live database, never into it ($live)"
    case "$into" in
      *_before_* | *_restore_*) die "$into is named like a database a restore keeps or makes (…_before_…, …_restore_…): a drill never replaces one; choose another name" ;;
    esac
    maint="$(maint_url)"
    [ -n "$maint" ] || die "no maintenance database (postgres, template1) answers: a drill needs to create a database"
    drill_db_free "$maint" "$into"
    log "drill: $2 → the new database $into (the live one, $live, is not touched)"
    # Only an earlier drill's database gets here (drill_db_free).
    psql_at -d "$maint" -c "DROP DATABASE IF EXISTS \"$into\"" >/dev/null
    create_like "$maint" "$into" "$live"
    if ! psql_at -d "$maint" -c "COMMENT ON DATABASE \"$into\" IS '$DRILL_MARK of $2'" >/dev/null; then
      psql_at -d "$maint" -c "DROP DATABASE IF EXISTS \"$into\"" >/dev/null 2>&1 || true
      die "couldn't mark $into as a drill's database; it was dropped"
    fi
    if ! pg_restore --no-owner --no-acl --exit-on-error --single-transaction --no-password \
      --dbname="$(url_with_db "$DATABASE_URL" "$into")" "$src"; then
      psql_at -d "$maint" -c "DROP DATABASE IF EXISTS \"$into\"" >/dev/null 2>&1 || true
      die "pg_restore into $into failed; it was dropped"
    fi
    summary "$(url_with_db "$DATABASE_URL" "$into")"
    echo "OPTIO_RESTORE_METHOD=drill"
    echo "OPTIO_RESTORE_DATABASE=$into"
    return 0
  fi
  maint="$(maint_url)"
  if [ -n "$maint" ] && can_swap "$maint" "$live"; then
    new="${base}_restore_$stamp"
    old="${base}_before_$stamp"
    log "restore: $2 → a new database $new; then $live becomes $old and $new becomes $live"
    create_like "$maint" "$new" "$live"
    if ! pg_restore --no-owner --no-acl --exit-on-error --single-transaction --no-password \
      --dbname="$(url_with_db "$DATABASE_URL" "$new")" "$src"; then
      psql_at -d "$maint" -c "DROP DATABASE IF EXISTS \"$new\"" >/dev/null 2>&1 || true
      die "pg_restore failed; $live was not touched"
    fi
    swapped=""
    for attempt in 1 2 3 4 5; do
      if [ -n "$STOPPED" ]; then
        psql_at -d "$maint" -c "DROP DATABASE IF EXISTS \"$new\"" >/dev/null 2>&1 || true
        die "stopped before the swap; $live was not touched"
      fi
      # Whoever is still connected (an API that isn't stopped) is let go first.
      psql_at -d "$maint" -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '$live' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
      if psql_at -d "$maint" --single-transaction \
        -c "ALTER DATABASE \"$live\" RENAME TO \"$old\"" \
        -c "ALTER DATABASE \"$new\" RENAME TO \"$live\"" >/dev/null 2>"$TMP/optio-rename.err"; then
        swapped=1
        break
      fi
      log "renaming failed (attempt $attempt): $(head -c 300 "$TMP/optio-rename.err")"
      sleep 3
    done
    if [ -z "$swapped" ]; then
      psql_at -d "$maint" -c "DROP DATABASE IF EXISTS \"$new\"" >/dev/null 2>&1 || true
      die "couldn't swap the databases (something keeps connecting to $live: scale the API to 0); $live was not touched"
    fi
    log "restored: $live is $2 now; the database as it was is kept as $old"
    summary "$DATABASE_URL"
    echo "OPTIO_RESTORE_METHOD=swap"
    echo "OPTIO_RESTORE_KEPT=$old"
    return 0
  fi
  [ -z "$STOPPED" ] || die "stopped before the restore; $live was not touched"
  log "restore: $2 → $live in place (this account can't create and rename databases): the schemas public and drizzle are replaced in one transaction"
  failed="$TMP/optio-restore-failed"
  rm -f "$failed"
  {
    echo 'BEGIN;'
    echo 'SET LOCAL client_min_messages = warning;'
    echo 'DROP SCHEMA IF EXISTS drizzle CASCADE;'
    echo 'DROP SCHEMA IF EXISTS public CASCADE;'
    echo 'CREATE SCHEMA public;'
    if pg_restore --no-owner --no-acl --file=- "$src"; then
      echo 'COMMIT;'
    else
      # psql reaches the end of its input inside the transaction: nothing is kept.
      : >"$failed"
    fi
  } | psql -X -q -v ON_ERROR_STOP=1 --no-password -d "$DATABASE_URL" >/dev/null || : >"$failed"
  if [ -e "$failed" ]; then
    die "the restore failed and was rolled back; $live was not changed"
  fi
  log "restored: $live is $2 now"
  summary "$DATABASE_URL"
  echo "OPTIO_RESTORE_METHOD=in-place"
}

# drill_db_free <maint url> <db>: a drill may make <db>: there is none of that
# name, or an earlier drill made it (its comment starts with $DRILL_MARK).
# Anything else is someone's database (another environment's on a shared
# server, a restore's kept one), and a drill never drops it.
drill_db_free() {
  state="$(psql_at -d "$1" -c "SELECT CASE WHEN coalesce(shobj_description(oid, 'pg_database'), '') LIKE '$DRILL_MARK%' THEN 'drill' ELSE 'other' END FROM pg_database WHERE datname = '$2'")" ||
    die "can't look up the database $2"
  case "$state" in
    '') ;;
    drill) log "$2 is an earlier drill's database: it is made again" ;;
    *) die "a database $2 is already there and no drill made it: a drill never replaces a database it didn't make. Choose another name (--into-database), or drop $2 yourself if it is a leftover" ;;
  esac
}

# can_swap <maint url> <live db>: may this account create databases and
# rename the live one (its owner, or a superuser)?
can_swap() {
  ok="$(psql_at -d "$1" -c "SELECT (r.rolsuper OR (r.rolcreatedb AND d.datdba = r.oid)) FROM pg_roles r, pg_database d WHERE r.rolname = current_user AND d.datname = '$2'" 2>/dev/null || true)"
  [ "$ok" = t ]
}

# create_like <maint url> <new db> <like db>: a new, empty database with the
# live one's encoding and locale
create_like() {
  props="$(psql_at -d "$1" -F '|' -c "SELECT pg_encoding_to_char(encoding), datcollate, datctype FROM pg_database WHERE datname = '$3'")"
  enc="${props%%|*}"
  rest="${props#*|}"
  coll="${rest%%|*}"
  ctype="${rest#*|}"
  for p in "$enc" "$coll" "$ctype"; do
    printf '%s\n' "$p" | grep -qE '^[A-Za-z0-9_.@-]+$' || die "the encoding or locale of $3 (\"$p\") isn't one this script copies"
  done
  psql_at -d "$1" -c "CREATE DATABASE \"$2\" TEMPLATE template0 ENCODING '$enc' LC_COLLATE '$coll' LC_CTYPE '$ctype'" >/dev/null
}

summary() {
  tables="$(psql_at -d "$1" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'" 2>/dev/null || echo '?')"
  migrations="$(psql_at -d "$1" -c 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2>/dev/null || echo '?')"
  log "the restored database has $tables tables and $migrations migrations recorded"
}

restore_pvc() {
  want="$(wanted_dump)"
  name="$(ls -1 "$DIR" | resolve "$want")"
  [ -n "$name" ] || die "no dump $want in ${OPTIO_BACKUP_LOCATION:-$DIR} (scripts/backup/restore-db.sh <env> --list)"
  restore_from "$DIR" "$name"
}

restore_db() { # s3: what fetch downloaded
  [ -s "$DIR/.optio-fetched" ] || die "the fetch container downloaded nothing"
  restore_from "$DIR" "$(cat "$DIR/.optio-fetched")"
}

# ── Copies (pvc) ───────────────────────────────────────────────────────────
# hold: the volume stays mounted while scripts/backup/backup-db.sh or
# restore-db.sh copy dumps through `kubectl exec`; they release it. While a
# copy runs they touch .optio-alive-<job> every minute or so (backup-lib.sh),
# and each touch starts the wait again: a long copy is held as long as it
# takes (within the Job's own deadline, backup.activeDeadlineSeconds), one
# whose script went away is let go after $OPTIO_BACKUP_HOLD_SECONDS.
hold_pvc() {
  secs="$(keep_count "${OPTIO_BACKUP_HOLD_SECONDS:-}" 1800)"
  release="$DIR/.optio-release-${JOB_NAME:-copy}"
  alive="$DIR/.optio-alive-${JOB_NAME:-copy}"
  rm -f "$alive"
  log "holding ${OPTIO_BACKUP_LOCATION:-$DIR} for a copy (until released, or ${secs}s without a sign of life)"
  echo "OPTIO_BACKUP_HOLD=ready"
  waited=0
  while [ ! -e "$release" ] && [ -z "$STOPPED" ]; do
    if [ -e "$alive" ]; then
      rm -f "$alive"
      waited=0
    fi
    if [ "$waited" -ge "$secs" ]; then
      log "not released, and no sign of life for ${secs}s"
      break
    fi
    sleep 2
    waited=$((waited + 2))
  done
  rm -f "$release" "$alive"
  # Uploads a copy left half-way.
  find "$DIR" -maxdepth 1 -name '.optio-*.upload' -mmin +120 -exec rm -f {} \; 2>/dev/null || true
  log "released"
}

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

# accept <name>: see the header. A dump of that name already there is kept
# when its bytes are the same, and the upload refused when they aren't.
accept_upload() {
  name="$ARG"
  printf '%s\n' "$name" | grep -qE "$NAME_RE" || die "not a dump's name: $name (optio-<time>[-<kind>].dump)"
  up="$DIR/.$name.upload"
  sum_up="$DIR/.$name.sha256.upload"
  [ -s "$up" ] || die "nothing was uploaded as $name"
  got="$(sha_of "$up")"
  if [ -s "$sum_up" ] && [ "$(cut -d' ' -f1 <"$sum_up")" != "$got" ]; then
    rm -f "$up" "$sum_up"
    die "$name doesn't match the .sha256 that came with it: damaged on the way; nothing was kept"
  fi
  if [ -e "$DIR/$name" ]; then
    rm -f "$up" "$sum_up"
    [ "$(sha_of "$DIR/$name")" = "$got" ] ||
      die "another $name (different bytes) is already there: restore that one by name, or remove it first"
    log "$name is already there, the same bytes"
  else
    if ! check_dump "$up"; then
      rm -f "$up" "$sum_up"
      die "$name didn't pass its check; nothing was kept"
    fi
    printf '%s  %s\n' "$got" "$name" >"$DIR/.$name.sha256.partial"
    mv "$DIR/.$name.sha256.partial" "$DIR/$name.sha256"
    mv "$up" "$DIR/$name"
    rm -f "$sum_up"
    log "kept the upload as $name"
  fi
  result_lines "$name" "$(size_of "$DIR/$name")" "${OPTIO_BACKUP_LOCATION:-$DIR}/$name"
}

case "$ROLE" in
  which)
    # Only the name on stdout (or nothing): the caller reads it.
    ls -1 "$DIR" | resolve "$ARG"
    exit 0
    ;;
  accept)
    accept_upload
    exit 0
    ;;
esac

case "$ROLE:$MODE" in
  pvc:backup) backup_pvc ;;
  pvc:restore | pvc:drill) restore_pvc ;;
  pvc:list) list_dir ;;
  pvc:copy) hold_pvc ;;
  fetch:copy | db:copy | store:copy) die "the dumps are in ${OPTIO_BACKUP_LOCATION:-the bucket}: copy them with your S3 tools (aws s3 cp)" ;;
  fetch:restore | fetch:drill) fetch_s3 ;;
  fetch:list) list_s3 ;;
  fetch:backup) : ;;
  db:backup) backup_db ;;
  db:restore | db:drill) restore_db ;;
  db:list) : ;;
  store:backup) backup_store ;;
  store:restore | store:drill | store:list) log "done" ;;
  *) die "usage: optio-backup.sh pvc|fetch|db|store, or which <dump>|accept <name> (got \"$ROLE\")" ;;
esac
