#!/bin/sh
# Fixture filenames are controlled; assertions intentionally use success/failure chains.
# shellcheck disable=SC2010,SC2012,SC2015,SC2016
# The database backup job's script (helm/optio/files/optio-backup.sh) against
# a real PostgreSQL, in throwaway databases:
#
#   - a scheduled, a by-hand and a pre-upgrade dump: names, .sha256, checked
#     with pg_restore --list, no partial file left; old dumps pruned per group
#     (backup.keep, backup.keepPreUpgrade), files it didn't write left alone
#   - a database that isn't Optio's (no migrations table) and a failing
#     pg_dump keep nothing
#   - list; a drill into a new database next to the live one (the live one
#     untouched; never into the live one)
#   - a damaged dump (.sha256 mismatch, a truncated file) is refused or rolled
#     back, the live database unchanged
#   - a restore by an account that may create databases swaps them (the old
#     one kept as <db>_before_<time>); by one that may not, it replaces the
#     schemas in one transaction
#   - copies through a copy job's pod: `which` names a dump, `accept` keeps
#     an upload only when it matches its .sha256 and reads as a dump (one of
#     the same name: the same bytes or refused), the hold ends when released
#     or at its deadline
#   - the S3 target, through a stand-in `aws` command that keeps a directory
#     (an empty prefix lists as no dumps, a missing bucket fails)
#
#   scripts/backup/test-backup.sh --url postgres://user:pass@host:5432/postgres
#       pg_dump, pg_restore and psql (16) on PATH; the URL a superuser's
#       (not run in CI; see --container below)
#   scripts/backup/test-backup.sh --container <name>
#       runs itself inside that PostgreSQL container (docker exec), against
#       its own server: e.g. the test infra's optio-test-postgres
#
# Every database and role it makes is named optio_bkt_<random>_* and dropped
# at the end. Prints one line per check; exits non-zero when one fails.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../../helm/optio/files/optio-backup.sh"
URL=""
CONTAINER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:?--url needs a value}"; shift ;;
    --container) CONTAINER="${2:?--container needs a name}"; shift ;;
    --script) SCRIPT="${2:?--script needs a file}"; shift ;;
    -h | --help) sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -n "$CONTAINER" ]; then
  # Into the container: this file and the job's script, then run there
  # against its own server as its superuser.
  d=/tmp/optio-backup-test
  docker exec "$CONTAINER" sh -c "rm -rf $d && mkdir -p $d"
  docker cp "$SCRIPT" "$CONTAINER:$d/optio-backup.sh" >/dev/null
  docker cp "$0" "$CONTAINER:$d/test-backup.sh" >/dev/null
  status=0
  # shellcheck disable=SC2016 # expanded in the container
  docker exec "$CONTAINER" sh -c 'sh '"$d"'/test-backup.sh --script '"$d"'/optio-backup.sh --url "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-}@127.0.0.1:5432/postgres"' || status=$?
  docker exec "$CONTAINER" rm -rf "$d" || true
  exit "$status"
fi
[ -n "$URL" ] || { echo "Give --url <a superuser's postgres:// URL> or --container <name>" >&2; exit 2; }
[ -f "$SCRIPT" ] || { echo "No job script at $SCRIPT" >&2; exit 2; }
for t in pg_dump pg_restore psql sha256sum; do command -v "$t" >/dev/null || { echo "Missing: $t" >&2; exit 2; }; done

FAILED=0
pass() { echo "ok    $*"; }
fail() {
  echo "FAIL  $*" >&2
  FAILED=1
}
# expect <what> <got> <want>: non-zero when they differ
expect() {
  if [ "$2" = "$3" ]; then pass "$1"; else
    fail "$1: got '$2', want '$3'"
    return 1
  fi
}

R="$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')"
P="optio_bkt_$R"
WORK="$(mktemp -d)"
url_db() { # <url> <db>
  rest="${1#*://}"
  q=""
  case "$rest" in *\?*) q="?${rest#*\?}" ;; esac
  rest="${rest%%\?*}"
  printf '%s://%s/%s%s\n' "${1%%://*}" "${rest%%/*}" "$2" "$q"
}
with_user() { # <url> <user> <password>: the URL as another role
  rest="${1#*://}"
  printf '%s://%s:%s@%s\n' "${1%%://*}" "$2" "$3" "${rest#*@}"
}
q() { psql -X -q -At -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }
ADMIN="$URL"
LIVE="${P}_live"
LIVE_URL="$(url_db "$ADMIN" "$LIVE")"

cleanup() {
  for db in $(q "$ADMIN" "SELECT datname FROM pg_database WHERE datname LIKE '${P}%'" 2>/dev/null); do
    q "$ADMIN" "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1 || true
  done
  q "$ADMIN" "DROP ROLE IF EXISTS ${P}_app" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# An Optio-shaped database: the migrations journal, a few tables, a view, and
# enough rows that most of a dump is table data.
seed() { # <url>
  psql -X -q -v ON_ERROR_STOP=1 -d "$1" >/dev/null <<'SQL'
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('a', 1), ('b', 2);
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL);
INSERT INTO users (email) VALUES ('alice@example.test'), ('bob@example.test'), ('carol@example.test');
CREATE TABLE secrets (id serial PRIMARY KEY, name text, encrypted_value bytea, iv bytea);
INSERT INTO secrets (name, encrypted_value, iv) SELECT 'S' || g, decode(md5(g::text), 'hex'), decode('00ff', 'hex') FROM generate_series(1, 20) g;
CREATE TABLE task_logs (id bigserial PRIMARY KEY, content text);
INSERT INTO task_logs (content) SELECT repeat(md5(g::text), 8) FROM generate_series(1, 4000) g;
CREATE VIEW repo_tasks AS SELECT id, email FROM users;
SQL
}

# job <out> <role> <job name> [VAR=value ...]: the job's script as the CronJob
# runs it; its status in <out>.status
job() {
  out="$1" role="$2" name="$3"
  shift 3
  st=0
  env OPTIO_BACKUP_CRONJOB=optio-backup JOB_NAME="$name" OPTIO_BACKUP_DIR="$WORK/pvc" \
    OPTIO_BACKUP_KEEP=2 OPTIO_BACKUP_KEEP_PRE_UPGRADE=1 DATABASE_URL="$LIVE_URL" TMPDIR="$WORK/tmp" \
    "$@" sh "$SCRIPT" "$role" >"$out" 2>&1 || st=$?
  echo "$st" >"$out.status"
}
status() { cat "$1.status"; }
line() { sed -n "s/^$2=//p" "$1" | tail -n 1; } # <out> <KEY>
show() { sed 's/^/        | /' "$1" >&2; }
dumps() { ls -1 "${1:-$WORK/pvc}" 2>/dev/null | grep -E '^optio-[0-9]{8}T[0-9]{6}Z(-[a-z-]+)?\.dump$' | sort | tr '\n' ' ' | sed 's/ $//'; }

mkdir -p "$WORK/tmp" "$WORK/pvc"
# A CI service may still be starting: up to a minute for it to take a login.
n=0
until q "$ADMIN" 'SELECT 1' >/dev/null 2>&1; do
  n=$((n + 1))
  [ "$n" -lt 30 ] || break
  sleep 2
done
q "$ADMIN" "CREATE DATABASE \"$LIVE\"" >/dev/null || { echo "Can't create a database as $(printf '%s' "$ADMIN" | sed 's#//[^@]*@#//…@#')" >&2; exit 1; }
seed "$LIVE_URL" || { echo "Can't seed $LIVE" >&2; exit 1; }

# ── Dumps ───────────────────────────────────────────────────────────────────
job "$WORK/d1" pvc optio-backup-29345678
expect "scheduled dump: exit status" "$(status "$WORK/d1")" 0
D1="$(line "$WORK/d1" OPTIO_BACKUP_DUMP)"
if printf '%s\n' "$D1" | grep -qE '^optio-[0-9]{8}T[0-9]{6}Z\.dump$'; then pass "scheduled dump: named $D1"; else
  fail "scheduled dump: name '$D1'"
  show "$WORK/d1"
fi
[ -s "$WORK/pvc/$D1" ] && pass "scheduled dump: on the volume" || fail "scheduled dump: $D1 not on the volume"
(cd "$WORK/pvc" && sha256sum -c "$D1.sha256" >/dev/null 2>&1) && pass "scheduled dump: .sha256 matches" || fail "scheduled dump: .sha256"
pg_restore --list "$WORK/pvc/$D1" | grep -q ' TABLE DATA public task_logs ' && pass "scheduled dump: pg_restore reads it" || fail "scheduled dump: pg_restore --list"
expect "scheduled dump: size reported" "$(line "$WORK/d1" OPTIO_BACKUP_SIZE)" "$(wc -c <"$WORK/pvc/$D1" | tr -d ' ')"
expect "no partial file left" "$(ls -A "$WORK/pvc" | grep -c partial || true)" 0

# Older dumps (copies under older names), one of each group, and files the job didn't write.
for n in optio-20200101T000000Z.dump optio-20200102T000000Z-manual.dump \
  optio-20200101T000000Z-pre-upgrade.dump optio-20200102T000000Z-pre-upgrade.dump; do
  cp "$WORK/pvc/$D1" "$WORK/pvc/$n"
  printf '%s  %s\n' "$(sha256sum "$WORK/pvc/$n" | cut -d' ' -f1)" "$n" >"$WORK/pvc/$n.sha256"
done
echo keep >"$WORK/pvc/notes.txt"
cp "$WORK/pvc/$D1" "$WORK/pvc/optio-latest.dump"
sleep 1
job "$WORK/d2" pvc optio-backup-pre-1024101500
expect "pre-upgrade dump: exit status" "$(status "$WORK/d2")" 0
D2="$(line "$WORK/d2" OPTIO_BACKUP_DUMP)"
case "$D2" in optio-*-pre-upgrade.dump) pass "pre-upgrade dump: named $D2" ;; *) fail "pre-upgrade dump: name '$D2'" ;; esac
# keep 2 (regular: D1 and the 2020-01-02 manual one), keepPreUpgrade 1 (D2 only)
expect "pruned to the newest of each group" "$(dumps)" "$(printf '%s\n' "$D1" optio-20200102T000000Z-manual.dump "$D2" | sort | tr '\n' ' ' | sed 's/ $//')"
[ ! -e "$WORK/pvc/optio-20200101T000000Z.dump.sha256" ] && pass "a pruned dump's .sha256 goes with it" || fail "optio-20200101T000000Z.dump.sha256 left behind"
[ -e "$WORK/pvc/notes.txt" ] && [ -e "$WORK/pvc/optio-latest.dump" ] && pass "files the job didn't write are left alone" || fail "a foreign file was removed"
sleep 1
job "$WORK/d3" pvc optio-backup-now-1024101501
D3="$(line "$WORK/d3" OPTIO_BACKUP_DUMP)"
case "$D3" in optio-*-manual.dump) pass "by-hand dump: named $D3" ;; *) fail "by-hand dump: name '$D3' (status $(status "$WORK/d3"))" ;; esac
expect "by-hand dump: the regular group keeps 2" "$(dumps | tr ' ' '\n' | grep -vc pre-upgrade)" 2

# Not Optio's database: nothing kept. A failing pg_dump: nothing kept.
q "$ADMIN" "CREATE DATABASE \"${P}_other\"" >/dev/null
q "$(url_db "$ADMIN" "${P}_other")" "CREATE TABLE t (x int); INSERT INTO t VALUES (1)" >/dev/null
before="$(ls -A "$WORK/pvc" | sort | tr '\n' ' ')"
job "$WORK/d4" pvc optio-backup-29345679 DATABASE_URL="$(url_db "$ADMIN" "${P}_other")"
expect "a database without the migrations table: refused" "$(status "$WORK/d4")" 1
grep -q "has no drizzle.__drizzle_migrations" "$WORK/d4" && pass "…and says why" || { fail "…the reason"; show "$WORK/d4"; }
expect "…nothing kept" "$(ls -A "$WORK/pvc" | sort | tr '\n' ' ')" "$before"
job "$WORK/d5" pvc optio-backup-29345680 DATABASE_URL="$(url_db "$ADMIN" "${P}_missing")"
expect "pg_dump fails (no such database): refused" "$(status "$WORK/d5")" 1
expect "…nothing kept" "$(ls -A "$WORK/pvc" | sort | tr '\n' ' ')" "$before"

# ── List, drill ─────────────────────────────────────────────────────────────
job "$WORK/l1" pvc optio-backup-list-1024101502
expect "list: one line per dump" "$(grep -c '^OPTIO_BACKUP_LIST=' "$WORK/l1")" 3
grep -q "^OPTIO_BACKUP_LIST=$D1 $(wc -c <"$WORK/pvc/$D1" | tr -d ' ')\$" "$WORK/l1" && pass "list: name and size" || { fail "list: $D1"; show "$WORK/l1"; }

job "$WORK/r1" pvc optio-backup-drill-1024101503 OPTIO_RESTORE_DUMP="$D1" OPTIO_RESTORE_INTO="${P}_drill"
expect "drill: exit status" "$(status "$WORK/r1")" 0 || show "$WORK/r1"
expect "drill: method" "$(line "$WORK/r1" OPTIO_RESTORE_METHOD)" drill
expect "drill: rows in the drill database" "$(q "$(url_db "$ADMIN" "${P}_drill")" 'SELECT count(*) FROM task_logs')" 4000
expect "drill: the view came back" "$(q "$(url_db "$ADMIN" "${P}_drill")" 'SELECT count(*) FROM repo_tasks')" 3
mark_of() { q "$ADMIN" "SELECT coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '$1'"; }
case "$(mark_of "${P}_drill")" in "optio restore drill of $D1") pass "drill: its database marked as a drill's" ;; *) fail "drill: mark '$(mark_of "${P}_drill")'" ;; esac
job "$WORK/r1b" pvc optio-backup-drill-1024101503 OPTIO_RESTORE_DUMP="$D3" OPTIO_RESTORE_INTO="${P}_drill"
expect "drill again into an earlier drill's database: made again" "$(status "$WORK/r1b") $(line "$WORK/r1b" OPTIO_RESTORE_DUMP)" "0 $D3" || show "$WORK/r1b"
# Someone else's database on the same server (another environment's), and a
# restore's kept one: a drill never drops either.
someone() { # <db>: a database with a row worth keeping
  q "$ADMIN" "CREATE DATABASE \"$1\"" >/dev/null
  q "$(url_db "$ADMIN" "$1")" "CREATE TABLE important (note text); INSERT INTO important VALUES ('keep me')" >/dev/null
}
kept_note() { q "$(url_db "$ADMIN" "$1")" 'SELECT note FROM important' 2>&1; }
someone "${P}_staging"
job "$WORK/r1c" pvc optio-backup-drill-1024101503 OPTIO_RESTORE_DUMP="$D1" OPTIO_RESTORE_INTO="${P}_staging"
expect "drill into a database no drill made: refused" "$(status "$WORK/r1c")" 1
grep -q "no drill made it" "$WORK/r1c" && pass "…and says why" || { fail "…the reason"; show "$WORK/r1c"; }
expect "…that database left as it was" "$(kept_note "${P}_staging")" "keep me"
KEPT_LIKE="${LIVE}_before_20261024101700"
someone "$KEPT_LIKE"
q "$ADMIN" "COMMENT ON DATABASE \"$KEPT_LIKE\" IS 'optio restore drill'" >/dev/null
job "$WORK/r1d" pvc optio-backup-drill-1024101503 OPTIO_RESTORE_DUMP="$D1" OPTIO_RESTORE_INTO="$KEPT_LIKE"
expect "drill into a restore's kept name (even marked): refused" "$(status "$WORK/r1d") $(kept_note "$KEPT_LIKE")" "1 keep me"
job "$WORK/r1e" pvc optio-backup-drill-1024101503 OPTIO_RESTORE_DUMP="$D1" OPTIO_RESTORE_INTO="${LIVE}_restore_20261024101700"
expect "drill into a restore's working name: refused" "$(status "$WORK/r1e")" 1
q "$ADMIN" "DROP DATABASE \"$KEPT_LIKE\"" >/dev/null
job "$WORK/r2" pvc optio-backup-drill-1024101504 OPTIO_RESTORE_DUMP=latest OPTIO_RESTORE_INTO="$LIVE"
expect "drill into the live database: refused" "$(status "$WORK/r2")" 1
job "$WORK/r3" pvc optio-backup-drill-1024101505 OPTIO_RESTORE_DUMP=latest OPTIO_RESTORE_INTO='x"; DROP'
expect "drill into a name that isn't plain: refused" "$(status "$WORK/r3")" 1
job "$WORK/r4" pvc optio-backup-restore-1024101506
expect "restore with no dump named: refused" "$(status "$WORK/r4")" 1
job "$WORK/r5" pvc optio-backup-restore-1024101507 OPTIO_RESTORE_DUMP=../../etc/passwd
expect "restore of a path, not a dump's name: refused" "$(status "$WORK/r5")" 1

# ── Copies (a copy job's pod: which, accept, hold) ──────────────────────────
# podcmd <out> <role> <arg> [VAR=value ...]: a role run as `kubectl exec` runs it in the copy job's pod
podcmd() {
  out="$1" role="$2" arg="$3"
  shift 3
  st=0
  env OPTIO_BACKUP_CRONJOB=optio-backup JOB_NAME=optio-backup-copy-1024101520 OPTIO_BACKUP_DIR="$WORK/pvc" \
    TMPDIR="$WORK/tmp" "$@" sh "$SCRIPT" "$role" "$arg" >"$out" 2>&1 || st=$?
  echo "$st" >"$out.status"
}
podcmd "$WORK/w1" which latest
expect "which latest" "$(cat "$WORK/w1")" "$D3"
podcmd "$WORK/w2" which latest-pre-upgrade
expect "which latest-pre-upgrade" "$(cat "$WORK/w2")" "$D2"
podcmd "$WORK/w3" which "$D1"
expect "which <a name there>" "$(cat "$WORK/w3")" "$D1"
podcmd "$WORK/w4" which optio-29990101T000000Z.dump
expect "which <a name not there>: nothing" "$(cat "$WORK/w4")" ""
podcmd "$WORK/w5" which ../pvc/notes.txt
expect "which <a path>: nothing" "$(cat "$WORK/w5")" ""

NEWN=optio-20250101T000000Z-manual.dump
upload() { # <bytes from> [<sum file content>]
  cp "$1" "$WORK/pvc/.$NEWN.upload"
  rm -f "$WORK/pvc/.$NEWN.sha256.upload"
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" >"$WORK/pvc/.$NEWN.sha256.upload"; fi
}
uploads_left() { ls -A "$WORK/pvc" | grep -c '\.upload$' || true; }
upload "$WORK/pvc/$D1" "$(sha256sum "$WORK/pvc/$D1" | cut -d' ' -f1)  $NEWN"
podcmd "$WORK/u1" accept "$NEWN"
expect "accept: an upload with its .sha256" "$(status "$WORK/u1")" 0 || show "$WORK/u1"
expect "…kept under its name" "$(line "$WORK/u1" OPTIO_BACKUP_DUMP)" "$NEWN"
(cd "$WORK/pvc" && sha256sum -c "$NEWN.sha256" >/dev/null 2>&1) && pass "…with a .sha256 that matches" || fail "…its .sha256"
expect "…no upload file left" "$(uploads_left)" 0
rm -f "$WORK/pvc/$NEWN" "$WORK/pvc/$NEWN.sha256"
upload "$WORK/pvc/$D1" "0000000000000000000000000000000000000000000000000000000000000000  $NEWN"
podcmd "$WORK/u2" accept "$NEWN"
expect "accept: an upload that doesn't match its .sha256: refused" "$(status "$WORK/u2")" 1
expect "…nothing kept, the upload removed" "$([ -e "$WORK/pvc/$NEWN" ] && echo kept) $(uploads_left)" " 0"
head -c 5000 /dev/urandom >"$WORK/noise"
upload "$WORK/noise"
podcmd "$WORK/u3" accept "$NEWN"
expect "accept: an upload that isn't a dump: refused" "$(status "$WORK/u3")" 1
expect "…nothing kept, the upload removed" "$([ -e "$WORK/pvc/$NEWN" ] && echo kept) $(uploads_left)" " 0"
d1sum="$(sha256sum "$WORK/pvc/$D1" | cut -d' ' -f1)"
cp "$WORK/pvc/$D1" "$WORK/pvc/.$D1.upload"
podcmd "$WORK/u4" accept "$D1"
expect "accept: the same bytes as the dump of that name: kept as it is" "$(status "$WORK/u4")" 0 || show "$WORK/u4"
cp "$WORK/pvc/$D3" "$WORK/pvc/.$D1.upload"
podcmd "$WORK/u5" accept "$D1"
expect "accept: other bytes under a name that is there: refused" "$(status "$WORK/u5")" 1
expect "…the dump there unchanged" "$(sha256sum "$WORK/pvc/$D1" | cut -d' ' -f1) $(uploads_left)" "$d1sum 0"
podcmd "$WORK/u6" accept 'x.dump'
expect "accept: not a dump's name: refused" "$(status "$WORK/u6")" 1

job "$WORK/h1" pvc optio-backup-copy-1024101521 OPTIO_BACKUP_HOLD_SECONDS=2
expect "hold: ends at its deadline" "$(status "$WORK/h1")" 0
grep -q '^OPTIO_BACKUP_HOLD=ready$' "$WORK/h1" && pass "hold: says it is ready" || { fail "hold: ready line"; show "$WORK/h1"; }
job "$WORK/h2" pvc optio-backup-copy-1024101522 OPTIO_BACKUP_HOLD_SECONDS=60 &
hold_pid=$!
n=0
while ! grep -q '^OPTIO_BACKUP_HOLD=ready$' "$WORK/h2" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.2; n=$((n + 1)); done
touch "$WORK/pvc/.optio-release-optio-backup-copy-1024101522"
n=0
while [ ! -s "$WORK/h2.status" ] && [ "$n" -lt 50 ]; do sleep 0.2; n=$((n + 1)); done
if [ -s "$WORK/h2.status" ]; then
  expect "hold: ends when released" "$(status "$WORK/h2")" 0
  expect "…and removes the release mark" "$(ls -A "$WORK/pvc" | grep -c optio-release || true)" 0
else
  fail "hold: still holding 10s after its release"
  kill "$hold_pid" 2>/dev/null || true
fi
wait "$hold_pid" 2>/dev/null || true

# A long copy: each sign of life (.optio-alive-<job>) starts the wait again;
# once they stop, the hold ends after HOLD_SECONDS.
job "$WORK/h3" pvc optio-backup-copy-1024101523 OPTIO_BACKUP_HOLD_SECONDS=3 &
hold_pid=$!
n=0
while ! grep -q '^OPTIO_BACKUP_HOLD=ready$' "$WORK/h3" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.2; n=$((n + 1)); done
n=0
while [ "$n" -lt 7 ]; do # 7 seconds of a copy going on, a sign of life every second
  touch "$WORK/pvc/.optio-alive-optio-backup-copy-1024101523"
  sleep 1
  n=$((n + 1))
done
if [ -s "$WORK/h3.status" ]; then fail "hold: ended while a copy gave signs of life"; else pass "hold: held past HOLD_SECONDS while a copy gives signs of life"; fi
n=0
while [ ! -s "$WORK/h3.status" ] && [ "$n" -lt 50 ]; do sleep 0.2; n=$((n + 1)); done
grep -q "no sign of life for 3s" "$WORK/h3" && pass "…then ends once they stop" || { fail "…didn't end after the signs of life stopped"; show "$WORK/h3"; }
expect "…and leaves no mark behind" "$(ls -A "$WORK/pvc" | grep -cE 'optio-alive|optio-release' || true)" 0
wait "$hold_pid" 2>/dev/null || true
# The copy job deleted (TERM to its shell): the hold ends at once.
env OPTIO_BACKUP_CRONJOB=optio-backup JOB_NAME=optio-backup-copy-1024101524 OPTIO_BACKUP_DIR="$WORK/pvc" \
  OPTIO_BACKUP_HOLD_SECONDS=60 TMPDIR="$WORK/tmp" sh "$SCRIPT" pvc >"$WORK/h4" 2>&1 &
spid=$!
n=0
while ! grep -q '^OPTIO_BACKUP_HOLD=ready$' "$WORK/h4" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.2; n=$((n + 1)); done
kill -TERM "$spid"
n=0
while kill -0 "$spid" 2>/dev/null && [ "$n" -lt 25 ]; do sleep 0.2; n=$((n + 1)); done
if kill -0 "$spid" 2>/dev/null; then
  fail "hold: still holding 5s after TERM"
  kill -9 "$spid" 2>/dev/null || true
else pass "hold: ends within seconds when the copy job is deleted (TERM)"; fi
wait "$spid" 2>/dev/null || true

# ── Restores ────────────────────────────────────────────────────────────────
# After the dump: a new person, a table a newer migration added.
change_live() { # <url>
  q "$1" "INSERT INTO users (email) VALUES ('dave@example.test'); CREATE TABLE IF NOT EXISTS added_later (x int); INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('c', 3)" >/dev/null
}
change_live "$LIVE_URL"

# A damaged dump: same name pattern, wrong bytes for its .sha256.
BAD=optio-20300101T000000Z.dump
cp "$WORK/pvc/$D1" "$WORK/pvc/$BAD"
printf '%s  %s\n' "$(sha256sum "$WORK/pvc/$D1" | cut -d' ' -f1)" "$BAD" >"$WORK/pvc/$BAD.sha256"
printf 'x' >>"$WORK/pvc/$BAD"
job "$WORK/r6" pvc optio-backup-restore-1024101508 OPTIO_RESTORE_DUMP="$BAD"
expect "a dump that doesn't match its .sha256: refused" "$(status "$WORK/r6")" 1
expect "…the live database unchanged" "$(q "$LIVE_URL" 'SELECT count(*) FROM users')" 4
rm -f "$WORK/pvc/$BAD" "$WORK/pvc/$BAD.sha256"

# A truncated dump (no .sha256): its table of contents reads, its data doesn't.
size="$(wc -c <"$WORK/pvc/$D1" | tr -d ' ')"
head -c "$((size * 6 / 10))" "$WORK/pvc/$D1" >"$WORK/pvc/$BAD"
job "$WORK/r7" pvc optio-backup-restore-1024101509 OPTIO_RESTORE_DUMP="$BAD"
expect "a truncated dump: the restore fails" "$(status "$WORK/r7")" 1
expect "…the live database unchanged" "$(q "$LIVE_URL" 'SELECT count(*) FROM users')" 4
expect "…and still the live one (no rename)" "$(q "$ADMIN" "SELECT count(*) FROM pg_database WHERE datname LIKE '${LIVE}_%'")" 0

# The restore, as a superuser: the databases swap.
job "$WORK/r8" pvc optio-backup-restore-1024101510 OPTIO_RESTORE_DUMP="$D1"
expect "restore (swap): exit status" "$(status "$WORK/r8")" 0 || show "$WORK/r8"
expect "restore (swap): method" "$(line "$WORK/r8" OPTIO_RESTORE_METHOD)" swap
expect "restore (swap): the dump's people" "$(q "$LIVE_URL" 'SELECT count(*) FROM users')" 3
expect "restore (swap): the newer table is gone" "$(q "$LIVE_URL" "SELECT count(*) FROM information_schema.tables WHERE table_name = 'added_later'")" 0
expect "restore (swap): the journal is the dump's" "$(q "$LIVE_URL" 'SELECT count(*) FROM drizzle.__drizzle_migrations')" 2
KEPT="$(line "$WORK/r8" OPTIO_RESTORE_KEPT)"
case "$KEPT" in "${LIVE}_before_"*) pass "restore (swap): the old database kept as $KEPT" ;; *) fail "restore (swap): kept '$KEPT'" ;; esac
expect "…holding what was there" "$(q "$(url_db "$ADMIN" "$KEPT")" 'SELECT count(*) FROM users')" 4
job "$WORK/r9" pvc optio-backup-restore-1024101511 OPTIO_RESTORE_DUMP=latest-pre-upgrade
expect "restore of latest-pre-upgrade" "$(line "$WORK/r9" OPTIO_RESTORE_DUMP)" "$D2"

# Stopped (the job deleted) while pg_restore runs: no swap afterwards. A
# pg_restore that takes 2 seconds, TERM to the job's shell meanwhile.
mkdir -p "$WORK/slowbin"
real_pg_restore="$(command -v pg_restore)"
printf '#!/bin/sh\ncase "$1" in --list) ;; *) sleep 2 ;; esac\nexec %s "$@"\n' "$real_pg_restore" >"$WORK/slowbin/pg_restore"
chmod +x "$WORK/slowbin/pg_restore"
change_live "$LIVE_URL"
before_dbs="$(q "$ADMIN" "SELECT count(*) FROM pg_database WHERE datname LIKE '${LIVE}_%'")"
env OPTIO_BACKUP_CRONJOB=optio-backup JOB_NAME=optio-backup-restore-1024101530 OPTIO_BACKUP_DIR="$WORK/pvc" \
  DATABASE_URL="$LIVE_URL" TMPDIR="$WORK/tmp" OPTIO_RESTORE_DUMP="$D1" PATH="$WORK/slowbin:$PATH" \
  sh "$SCRIPT" pvc >"$WORK/r10" 2>&1 &
spid=$!
n=0
while ! grep -q "a new database" "$WORK/r10" 2>/dev/null && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
kill -TERM "$spid"
st=0
wait "$spid" || st=$?
expect "a restore stopped before the swap: fails" "$st" 1
grep -q "stopped before the swap" "$WORK/r10" && pass "…and says it stopped before the swap" || { fail "…the stop"; show "$WORK/r10"; }
expect "…the live database unchanged (as it was, not the dump)" "$(q "$LIVE_URL" "SELECT count(*) FROM information_schema.tables WHERE table_name = 'added_later'")" 1
expect "…no database kept or left behind" "$(q "$ADMIN" "SELECT count(*) FROM pg_database WHERE datname LIKE '${LIVE}_%'")" "$before_dbs"

# The restore by an account that can't create databases: in place.
APP="${P}_app"
q "$ADMIN" "CREATE ROLE $APP LOGIN PASSWORD 'bkt' NOCREATEDB NOSUPERUSER" >/dev/null
q "$ADMIN" "CREATE DATABASE \"$APP\" OWNER $APP" >/dev/null
APP_URL="$(with_user "$(url_db "$ADMIN" "$APP")" "$APP" bkt)"
seed "$APP_URL"
job "$WORK/a1" pvc optio-backup-29345690 DATABASE_URL="$APP_URL" OPTIO_BACKUP_DIR="$WORK/pvc-app"
expect "dump as the application's own account" "$(status "$WORK/a1")" 0 || show "$WORK/a1"
A1="$(line "$WORK/a1" OPTIO_BACKUP_DUMP)"
change_live "$APP_URL"
head -c "$(($(wc -c <"$WORK/pvc-app/$A1") * 6 / 10))" "$WORK/pvc-app/$A1" >"$WORK/pvc-app/$BAD"
job "$WORK/a2" pvc optio-backup-restore-1024101512 DATABASE_URL="$APP_URL" OPTIO_BACKUP_DIR="$WORK/pvc-app" OPTIO_RESTORE_DUMP="$BAD"
expect "in place, a truncated dump: the restore fails" "$(status "$WORK/a2")" 1
grep -q "rolled back" "$WORK/a2" && pass "…and says it rolled back" || { fail "…rolled back"; show "$WORK/a2"; }
expect "…the database unchanged" "$(q "$APP_URL" 'SELECT count(*) FROM users')" 4
expect "…its newer table still there" "$(q "$APP_URL" "SELECT count(*) FROM information_schema.tables WHERE table_name = 'added_later'")" 1
job "$WORK/a3" pvc optio-backup-restore-1024101513 DATABASE_URL="$APP_URL" OPTIO_BACKUP_DIR="$WORK/pvc-app" OPTIO_RESTORE_DUMP="$A1"
expect "restore (in place): exit status" "$(status "$WORK/a3")" 0 || show "$WORK/a3"
expect "restore (in place): method" "$(line "$WORK/a3" OPTIO_RESTORE_METHOD)" in-place
expect "restore (in place): the dump's people" "$(q "$APP_URL" 'SELECT count(*) FROM users')" 3
expect "restore (in place): the newer table is gone" "$(q "$APP_URL" "SELECT count(*) FROM information_schema.tables WHERE table_name = 'added_later'")" 0
expect "restore (in place): every row of the big table" "$(q "$APP_URL" 'SELECT count(*) FROM task_logs')" 4000
expect "restore (in place): still the same database" "$(q "$ADMIN" "SELECT count(*) FROM pg_database WHERE datname LIKE '${APP}_%'")" 0
job "$WORK/a4" pvc optio-backup-drill-1024101514 DATABASE_URL="$APP_URL" OPTIO_BACKUP_DIR="$WORK/pvc-app" OPTIO_RESTORE_DUMP="$A1" OPTIO_RESTORE_INTO="${P}_appdrill"
expect "a drill by an account that can't create databases: refused" "$(status "$WORK/a4")" 1

# ── S3, through a stand-in aws command ──────────────────────────────────────
# s3://<bucket>/<key> is $WORK/s3/<bucket>/<key>; it records its calls.
mkdir -p "$WORK/bin" "$WORK/s3/optio-backups"
cat >"$WORK/bin/aws" <<'AWS'
#!/bin/sh
set -eu
root="$FAKE_S3"
echo "aws $*" >>"$root/.calls"
[ "$1" = --endpoint-url ] && { echo "$2" >"$root/.endpoint"; shift 2; }
path() { p="${1#s3://}"; echo "$root/$p"; }
svc="$1" cmd="$2"; shift 2
[ "${1:-}" = --only-show-errors ] && shift
case "$svc $cmd" in
  "s3 cp")
    case "$1" in s3://*) [ -f "$(path "$1")" ] || { echo "404 $1" >&2; exit 1; }; cp "$(path "$1")" "$2" ;;
      *) mkdir -p "$(dirname "$(path "$2")")"; cp "$1" "$(path "$2")" ;; esac ;;
  "s3 ls")
    d="$(path "$1")"
    # As the AWS CLI: an empty prefix fails, saying nothing.
    [ -d "$d" ] || exit 1
    for f in "$d"*; do [ -f "$f" ] && echo "2026-10-24 02:15:03 $(wc -c <"$f" | tr -d ' ') $(basename "$f")"; done; true ;;
  "s3 rm") rm -f "$(path "$1")" ;;
  "s3api head-bucket")
    [ "$1" = --bucket ] && [ -d "$root/$2" ] || { echo "An error occurred (404) when calling the HeadBucket operation: Not Found" >&2; exit 254; } ;;
  "s3api head-object")
    b="" k=""
    while [ $# -gt 0 ]; do case "$1" in --bucket) b="$2"; shift ;; --key) k="$2"; shift ;; esac; shift; done
    wc -c <"$root/$b/$k" | tr -d ' ' ;;
  *) echo "fake aws: $svc $cmd" >&2; exit 2 ;;
esac
AWS
chmod +x "$WORK/bin/aws"
S3ENV="PATH=$WORK/bin:$PATH FAKE_S3=$WORK/s3 OPTIO_BACKUP_S3_ENDPOINT=https://s3.example.test:9000 OPTIO_BACKUP_S3_BUCKET=optio-backups OPTIO_BACKUP_S3_PREFIX=staging"
# shellcheck disable=SC2086 # S3ENV is a list of assignments
s3job() { out="$1" role="$2" name="$3" dir="$4"; shift 4; job "$out" "$role" "$name" $S3ENV OPTIO_BACKUP_DIR="$dir" "$@"; }
s3_people="$(q "$LIVE_URL" 'SELECT count(*) FROM users')" # the S3 dumps hold these
s3job "$WORK/s1" db optio-backup-29345700 "$WORK/scratch1"
expect "s3: the dump container" "$(status "$WORK/s1")" 0 || show "$WORK/s1"
s3job "$WORK/s2" store optio-backup-29345700 "$WORK/scratch1"
expect "s3: the upload container" "$(status "$WORK/s2")" 0 || show "$WORK/s2"
S1="$(line "$WORK/s2" OPTIO_BACKUP_DUMP)"
[ -s "$WORK/s3/optio-backups/staging/$S1" ] && [ -s "$WORK/s3/optio-backups/staging/$S1.sha256" ] &&
  pass "s3: the dump and its .sha256 under the prefix" || fail "s3: $S1 not in the bucket"
expect "s3: location" "$(line "$WORK/s2" OPTIO_BACKUP_LOCATION)" "s3://optio-backups/staging/$S1"
expect "s3: the endpoint used" "$(cat "$WORK/s3/.endpoint")" https://s3.example.test:9000
grep -q 'addressing_style = path' "$WORK/tmp/optio-backup-aws-config" && pass "s3: path-style addressing" || fail "s3: addressing style"
for n in optio-20200101T000000Z.dump optio-20200102T000000Z.dump optio-20200101T000000Z-pre-upgrade.dump; do
  cp "$WORK/s3/optio-backups/staging/$S1" "$WORK/s3/optio-backups/staging/$n"
done
echo other >"$WORK/s3/optio-backups/staging/README"
sleep 1
s3job "$WORK/s3a" db optio-backup-pre-1024101515 "$WORK/scratch2"
s3job "$WORK/s3b" store optio-backup-pre-1024101515 "$WORK/scratch2"
expect "s3: a second upload" "$(status "$WORK/s3b")" 0 || show "$WORK/s3b"
S2="$(line "$WORK/s3b" OPTIO_BACKUP_DUMP)"
expect "s3: pruned per group" "$(dumps "$WORK/s3/optio-backups/staging")" "$(printf '%s\n' "$S1" optio-20200102T000000Z.dump "$S2" | sort | tr '\n' ' ' | sed 's/ $//')"
[ -e "$WORK/s3/optio-backups/staging/README" ] && pass "s3: objects the job didn't write are left alone" || fail "s3: README removed"
s3job "$WORK/s4" store optio-backup-29345701 "$WORK/scratch-empty"
expect "s3: upload with nothing dumped: refused" "$(status "$WORK/s4")" 1
s3job "$WORK/s5" fetch optio-backup-list-1024101516 "$WORK/scratch3"
expect "s3: list" "$(grep -c '^OPTIO_BACKUP_LIST=' "$WORK/s5")" 3
s3job "$WORK/s5b" fetch optio-backup-list-1024101519 "$WORK/scratch3" OPTIO_BACKUP_S3_PREFIX=nothing-yet
expect "s3: list of a prefix with nothing under it: no dumps" "$(status "$WORK/s5b") $(grep -c '^OPTIO_BACKUP_LIST=' "$WORK/s5b")" "0 0" || show "$WORK/s5b"
s3job "$WORK/s5c" fetch optio-backup-list-1024101520 "$WORK/scratch3" OPTIO_BACKUP_S3_BUCKET=no-such-bucket
expect "s3: list of a bucket that isn't there: fails" "$(status "$WORK/s5c")" 1
s3job "$WORK/s5d" fetch optio-backup-copy-1024101521 "$WORK/scratch3"
expect "s3: a copy job: refused (the bucket's own tools)" "$(status "$WORK/s5d")" 1
s3job "$WORK/s6" fetch optio-backup-drill-1024101517 "$WORK/scratch4" OPTIO_RESTORE_DUMP=latest-pre-upgrade OPTIO_RESTORE_INTO="${P}_s3drill"
expect "s3: the fetch container" "$(status "$WORK/s6")" 0 || show "$WORK/s6"
s3job "$WORK/s7" db optio-backup-drill-1024101517 "$WORK/scratch4" OPTIO_RESTORE_DUMP=latest-pre-upgrade OPTIO_RESTORE_INTO="${P}_s3drill"
expect "s3: drill from the bucket" "$(status "$WORK/s7")" 0 || show "$WORK/s7"
expect "s3: drill restored $S2" "$(line "$WORK/s7" OPTIO_RESTORE_DUMP)" "$S2"
expect "s3: drill rows" "$(q "$(url_db "$ADMIN" "${P}_s3drill")" 'SELECT count(*) FROM users')" "$s3_people"
s3job "$WORK/s8" fetch optio-backup-restore-1024101518 "$WORK/scratch5" OPTIO_RESTORE_DUMP=optio-29990101T000000Z.dump
expect "s3: fetch of a dump that isn't there: refused" "$(status "$WORK/s8")" 1
s3job "$WORK/s9" store optio-backup-restore-1024101518 "$WORK/scratch5"
expect "s3: the upload container does nothing on a restore" "$(status "$WORK/s9")" 0

if [ "$FAILED" = 0 ]; then echo "All backup script checks passed."; else exit 1; fi
