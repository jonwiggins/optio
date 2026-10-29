#!/usr/bin/env bash
# Restore an environment's database from one of its dumps (the chart's
# backup.*; docs/backup.md): stops the API, restores the dump with the
# backup CronJob's job, starts the API again (which runs the migrations of its
# version) and checks that the environment's encryption key opens the
# restored secrets.
#
#   scripts/backup/restore-db.sh --namespace <name> <dump> [options]
#   scripts/backup/restore-db.sh --namespace <name> --list
#   scripts/backup/restore-db.sh --namespace <name> <dump> --into-database <name>    (a drill)
#   scripts/backup/restore-db.sh --namespace <name> --finish <job>
#
#   <dump>                 a dump's name (optio-20261024T021500Z.dump), latest, or
#                          latest-pre-upgrade (the one backup-db.sh --reason pre-upgrade took last);
#                          or the path of a dump on this machine (backup-db.sh
#                          --to copied it, maybe from another environment): it
#                          is copied into the environment's backup volume with
#                          the .sha256 next to it, checked there, then restored
#   --list                 the dumps there are, and nothing else
#   --into-database <name> a drill: the dump goes into this new database next to
#                          the live one; the API keeps running; the key is
#                          checked against it; then it is dropped (--keep keeps it).
#                          A drill only makes and drops a database of its own: a
#                          name that is taken by a database no drill made is refused
#   --finish <job>         a restore this script left running (it timed out or was
#                          stopped; it prints this): waits for that job, then
#                          starts the API and checks the key as a restore does
#   --yes                  don't ask (the pipeline, the end-to-end test)
#   --kubeconfig, --context as backup-db.sh --reason pre-upgrade
#   --timeout <seconds>    how long to wait for the restore job (default: its own
#                          deadline, backup.activeDeadlineSeconds, and 5 minutes),
#                          and for the API to come up (default 3600)
#
# The restore replaces everything written since the dump. It never touches the
# live database before the whole dump is restored: with the right to create
# databases (the built-in PostgreSQL) the dump goes into a new database that
# then takes the live one's name, and the live one is kept as
# <db>_before_<time> until you drop it; without it, it replaces the schemas in
# one transaction. If the restore fails, the API comes back on the database
# as it was. While the restore job may still be running (this script timed
# out, or was stopped), the API stays stopped: started, it could have the
# database swapped under it. The script says so, and --finish ends it.
#
# Restoring the database as it was before an upgrade: first `helm rollback`
# (backup-db.sh --reason pre-upgrade prints it), then this with the dump backup-db.sh --reason pre-upgrade named.
# Into a new namespace: deploy Optio there with the same encryption key and
# backups on, then this with the file (docs/backup.md).
#
# Tools: $KUBECTL, else kubectl on PATH.
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

DUMP=""
NAMESPACE=""
RELEASE=""
KUBECONFIG_FILE=""
CONTEXT=""
TIMEOUT=""
FILE=""
LIST=0
INTO=""
KEEP=0
YES=0
FINISH=""
POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    --namespace) NAMESPACE="${2:?--namespace needs a name}"; shift ;;
    --release) RELEASE="${2:?--release needs a name}"; shift ;;
    --kubeconfig) KUBECONFIG_FILE="${2:?--kubeconfig needs a file}"; shift ;;
    --context) CONTEXT="${2:?--context needs a name}"; shift ;;
    --timeout) TIMEOUT="${2:?--timeout needs seconds}"; shift ;;
    --list) LIST=1 ;;
    --into-database) INTO="${2:?--into-database needs a name}"; shift ;;
    --keep) KEEP=1 ;;
    --finish) FINISH="${2:?--finish needs the name of the restore job}"; shift ;;
    --yes | -y) YES=1 ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) POSITIONAL+=("$1") ;;
  esac
  shift
done
[ "${#POSITIONAL[@]}" -le 1 ] || { echo "One dump only; use --namespace to select a namespace" >&2; exit 2; }
DUMP="${POSITIONAL[0]:-}"
if [ -n "$FINISH" ]; then
  if [ -n "$DUMP" ] || [ "$LIST" = 1 ] || [ -n "$INTO" ]; then echo "--finish takes the job's name and nothing else to do" >&2; exit 2; fi
  [[ "$FINISH" =~ ^[a-z0-9-]+-backup-restore-[0-9]+$ ]] || { echo "--finish takes a restore job's name (<release>-backup-restore-<time>), got: $FINISH" >&2; exit 2; }
elif [ "$LIST" != 1 ]; then
  [ -n "$DUMP" ] || { echo "Name the dump to restore (or --list them)" >&2; exit 2; }
  # A path (or a file here): a copy to upload first, restored by its name.
  if [[ "$DUMP" == */* ]] || [ -f "$DUMP" ]; then
    [ -f "$DUMP" ] || { echo "No such file: $DUMP" >&2; exit 2; }
    FILE="$DUMP"
    DUMP="$(basename "$FILE")"
    [[ "$DUMP" =~ ^optio-[0-9]{8}T[0-9]{6}Z(-[a-z]+(-[a-z]+)*)?\.dump$ ]] || { echo "Not a dump's file name: $DUMP (keep the name backup-db.sh gave it: optio-<time>[-<kind>].dump)" >&2; exit 2; }
  fi
  case "$DUMP" in
    latest | latest-pre-upgrade) ;;
    *) [[ "$DUMP" =~ ^optio-[0-9]{8}T[0-9]{6}Z(-[a-z]+(-[a-z]+)*)?\.dump$ ]] || { echo "Not a dump's name: $DUMP (optio-<time>[-<kind>].dump, latest or latest-pre-upgrade)" >&2; exit 2; } ;;
  esac
fi
if [ -n "$INTO" ]; then
  [[ "$INTO" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "--into-database takes a plain name (lower-case letters, digits, _)" >&2; exit 2; }
  # The names a restore gives the database it keeps and the one it makes.
  case "$INTO" in *_before_* | *_restore_*) echo "--into-database $INTO: a drill never takes the name of a database a restore keeps or makes (…_before_…, …_restore_…)" >&2; exit 2 ;; esac
fi
case "$TIMEOUT" in '') ;; *[!0-9]*) echo "--timeout takes seconds" >&2; exit 2 ;; esac

# shellcheck source=backup-lib.sh
. "$(dirname "$0")/backup-lib.sh"
WORK="$(mktemp -d)"
chmod 700 "$WORK"
API_SCALED=""   # the API was stopped here: the EXIT trap starts it again
REPLICAS=""
RUNNING_JOB=""  # a restore or drill job whose end isn't known: it may still change the database
KEY_CHECK=""
REPLICAS_ANNOTATION=optio.dev/replicas-before-restore

# The command that ends a restore left running, with this run's environment.
finish_command() {
  local env_args
  env_args="--namespace $NAMESPACE"
  if [ "$RELEASE" != "$NAMESPACE" ]; then env_args+=" --release $RELEASE"; fi
  if [ -n "$KUBECONFIG_FILE" ]; then env_args+=" --kubeconfig $KUBECONFIG_FILE"; fi
  if [ -n "$CONTEXT" ]; then env_args+=" --context $CONTEXT"; fi
  echo "scripts/backup/restore-db.sh $env_args --finish $1"
}

# job_pods_gone <job>: none of its pods is left (a failed job's last pod may
# still be stopping); waits up to 5 minutes.
job_pods_gone() {
  kc wait --for=delete pod -l "batch.kubernetes.io/job-name=$1" --timeout=300s >/dev/null 2>&1 || true
  [ -z "$(kc get pods -l "batch.kubernetes.io/job-name=$1" -o name 2>/dev/null)" ]
}

# A restore job that may still run when this script ends: the API stays
# stopped (and its lock and immutable Job inputs stay for recovery).
leave_restore_running() {
  API_SCALED=""
  {
    echo
    echo "The restore job $RUNNING_JOB may still be running, so the API ($API) stays stopped:"
    echo "started now, it could have the database swapped under it. Optio is unavailable until you finish."
    echo "  Follow it:   kubectl -n $NAMESPACE logs -f job/$RUNNING_JOB --all-containers"
    echo "  Finish it:   $(finish_command "$RUNNING_JOB")"
    echo "               (waits for the job, then starts the API at its replicas and checks the key)"
    echo "  Or stop it:  kubectl -n $NAMESPACE delete job $RUNNING_JOB --cascade=foreground --wait"
    echo "               then the same --finish, which starts the API again"
  } >&2
}

# The restore jobs of the CronJob still running (none, normally).
active_restore_jobs() {
  kc get jobs -o jsonpath='{range .items[*]}{.metadata.name} {.status.active}{"\n"}{end}' 2>/dev/null |
    awk -v p="$CRONJOB-restore-" 'index($1, p) == 1 && $2 > 0 { print $1 }'
}

# A drill left running: it touches nothing live, so it is stopped and its
# database dropped (when it made one).
stop_drill() {
  echo "Stopping the drill: deleting its job $RUNNING_JOB..." >&2
  kc delete job "$RUNNING_JOB" --cascade=foreground --wait --timeout=300s >/dev/null 2>&1 || true
  if ! job_pods_gone "$RUNNING_JOB"; then
    echo "The drill's pod is still there: drop $INTO once it is gone (docs/backup.md, \"A restore drill\")." >&2
    return 0
  fi
  echo "Dropping the drill's database $INTO, if it made one:" >&2
  if ! check_key --database "$INTO" --drop-after >&2 && [ "$KEY_CHECK" != wrong-key ]; then
    echo "If $INTO is still there, drop it: kubectl -n $NAMESPACE exec deploy/$API -c api -- tsx scripts/check-encryption-key.ts --database $INTO --drop-after" >&2
  fi
}

finish() {
  local rc=$?
  trap - INT TERM HUP
  if [ -n "$RUNNING_JOB" ] && kc get job "$RUNNING_JOB" >/dev/null 2>&1; then
    if [ -n "$INTO" ]; then stop_drill; else leave_restore_running; fi
    if [ "$rc" = 0 ]; then rc=1; fi
  fi
  backup_cleanup
  if [ -n "$API_SCALED" ]; then
    echo "Starting the API again ($REPLICAS)..." >&2
    kc scale "deploy/$API" --replicas="$REPLICAS" >/dev/null || echo "Couldn't scale deploy/$API back to $REPLICAS: do it by hand" >&2
    kc annotate "deploy/$API" "$REPLICAS_ANNOTATION-" >/dev/null 2>&1 || true
  fi
  if [ -z "$RUNNING_JOB" ]; then backup_restore_unlock; fi
  rm -rf "$WORK"
  exit "$rc"
}
trap finish EXIT
# Stopped (Ctrl-C, a cancelled pipeline, a closed terminal): through the EXIT trap.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

backup_kube
backup_env
API="$RELEASE-api"
if ! backup_cronjob; then
  backup_die "no backup CronJob $CRONJOB in $NAMESPACE: backups are off there (backup.enabled). Without one, restore by hand: docs/backup.md, \"Without the chart's backups\""
fi
if [ -n "$FILE" ] && [ "$(backup_target)" != pvc ]; then
  backup_die "$NAMESPACE's dumps are in an S3 bucket (backup.target: s3): upload $FILE there with your S3 tools (its name unchanged, with its .sha256), then restore it by name: $DUMP"
fi
# Long enough for the job to end by itself: its deadline, then 5 minutes.
deadline="$(kc get cronjob "$CRONJOB" -o jsonpath='{.spec.jobTemplate.spec.activeDeadlineSeconds}' 2>/dev/null || true)"
case "$deadline" in '' | *[!0-9]*) deadline=7200 ;; esac
JOB_TIMEOUT="${TIMEOUT:-$((deadline + 300))}"
API_TIMEOUT="${TIMEOUT:-3600}"

# upload: the local file into the backup volume, before anything else changes
upload() {
  [ -n "$FILE" ] || return 0
  backup_hold 600 || backup_die "couldn't reach the backup volume to copy $FILE in; nothing changed"
  backup_upload "$FILE"
  backup_release
}

# check_key [args]: the encryption key against the restored secrets, in the
# API pod (apps/api/scripts/check-encryption-key.ts). KEY_CHECK: ok, wrong-key
# (it opens none: exit status 1 and its "It opens none" line), or failed (it
# couldn't run: a usage or database error, exit status 2, or kubectl's own
# error). Returns 0 only for ok.
check_key() {
  local out="$WORK/key.txt" rc=0
  kc exec "deploy/$API" -c api -- tsx scripts/check-encryption-key.ts "$@" >"$out" 2>&1 || rc=$?
  sed 's/^/  | /' "$out"
  if [ "$rc" = 0 ]; then KEY_CHECK=ok; return 0; fi
  if grep -q "check-encryption-key.ts" "$out" && grep -qiE "cannot find|not found|ENOENT" "$out"; then
    echo "This API image has no key check (older than the backup feature): sign in and check that a stored token still works to check the key." >&2
    KEY_CHECK=ok
    return 0
  fi
  if [ "$rc" = 1 ] && grep -q "It opens none" "$out"; then KEY_CHECK=wrong-key; else KEY_CHECK=failed; fi
  return 1
}

# The API's replicas before a restore stopped it (the annotation), else 1.
replicas_before_restore() {
  local r
  r="$(kc get "deploy/$API" -o jsonpath="{.metadata.annotations.${REPLICAS_ANNOTATION//./\\.}}" 2>/dev/null || true)"
  case "$r" in '' | 0 | *[!0-9]*) echo 1 ;; *) echo "$r" ;; esac
}

if [ "$LIST" = 1 ]; then
  backup_job list
  backup_wait "$JOB" "$JOB_TIMEOUT" >/dev/null || { cat "$JOB_LOG" >&2; backup_die "couldn't list the dumps"; }
  echo "Dumps in $NAMESPACE ($(sed -n 's/^.*: dumps in \(.*\):$/\1/p' "$JOB_LOG" | tail -n 1)):"
  if ! grep -q '^OPTIO_BACKUP_LIST=' "$JOB_LOG"; then echo "  none"; exit 0; fi
  sed -n 's/^OPTIO_BACKUP_LIST=//p' "$JOB_LOG" | awk '{ printf "  %-45s %12d bytes\n", $1, $2 }'
  exit 0
fi

if [ -n "$INTO" ]; then
  echo "A restore drill in $NAMESPACE: $DUMP into the new database $INTO; the live database and the API are not touched."
  upload
  backup_job drill "$DUMP" "$INTO"
  RUNNING_JOB="$JOB"
  echo "Waiting for $JOB (at most ${JOB_TIMEOUT}s)..."
  if backup_wait "$JOB" "$JOB_TIMEOUT"; then RUNNING_JOB=""; else
    [ "$?" = 2 ] || RUNNING_JOB=""
    backup_die "the drill's restore failed (above)"
  fi
  RESTORED="$(backup_value OPTIO_RESTORE_DUMP)"
  # shellcheck disable=SC2015 # Both validations must succeed.
  [ "$(backup_value OPTIO_RESTORE_METHOD)" = drill ] && [ -n "$RESTORED" ] ||
    backup_die "the drill's job ended without restoring anything (an older chart's script?)"
  echo
  echo "Checking the encryption key against $INTO:"
  drop=(--drop-after)
  if [ "$KEEP" = 1 ]; then drop=(); fi
  if ! check_key --database "$INTO" "${drop[@]}"; then
    if [ "$KEY_CHECK" = wrong-key ]; then
      backup_die "the environment's encryption key doesn't open the secrets in $RESTORED: this dump and this key don't belong together"
    fi
    backup_die "the key check couldn't run (above), so the drill proves only that $RESTORED restores. If $INTO is still there, drop it: kubectl -n $NAMESPACE exec deploy/$API -c api -- tsx scripts/check-encryption-key.ts --database $INTO --drop-after"
  fi
  echo
  echo "Drill passed: $RESTORED restores, and the key opens its secrets."
  if [ "$KEEP" = 1 ]; then echo "The database $INTO is kept; drop it when you're done (docs/backup.md, \"A restore drill\")."; fi
  exit 0
fi

# after_restore_job: waits for the restore job $JOB, then starts the API on
# what it left and checks the key. The API is stopped (API_SCALED) and comes
# back through the EXIT trap whenever the job is known to have ended.
after_restore_job() {
  local rc=0
  echo "Waiting for $JOB (at most ${JOB_TIMEOUT}s)..."
  backup_wait "$JOB" "$JOB_TIMEOUT" || rc=$?
  if [ "$rc" = 2 ]; then
    backup_die "the restore job didn't end within ${JOB_TIMEOUT}s"
  fi
  if [ "$rc" != 0 ]; then
    # Its last pod may still be stopping: the API waits until it is gone.
    job_pods_gone "$JOB" || backup_die "the restore job failed, but its pod is still there"
    RUNNING_JOB=""
    backup_die "the restore failed (above); the database was not changed, and the API is started again on it"
  fi
  RUNNING_JOB=""
  RESTORED="$(backup_value OPTIO_RESTORE_DUMP)"
  METHOD="$(backup_value OPTIO_RESTORE_METHOD)"
  KEPT="$(backup_value OPTIO_RESTORE_KEPT)"
  # A job that ended well but restored nothing (an older chart's script that
  # took it for a dump) must not pass for a restore.
  case "$METHOD" in swap | in-place) ;; *) RESTORED="" ;; esac
  [ -n "$RESTORED" ] ||
    backup_die "the restore job ended without restoring anything (an older chart's script?); the database was not changed, and the API is started again on it"

  echo "Starting the API ($REPLICAS); it runs its migrations on the restored database..."
  kc scale "deploy/$API" --replicas="$REPLICAS" >/dev/null
  API_SCALED=""
  kc annotate "deploy/$API" "$REPLICAS_ANNOTATION-" >/dev/null 2>&1 || true
  if ! kc rollout status "deploy/$API" --timeout="${API_TIMEOUT}s"; then
    kc get pods -l app=optio-api -o wide >&2 || true
    kc logs "deploy/$API" -c api --tail=60 >&2 || true
    backup_die "the API didn't come up on the restored database (above)"
  fi

  echo
  echo "Checking the encryption key against the restored secrets:"
  local record=(--record-restore "$RESTORED")
  if [ -n "$KEPT" ]; then record+=(--kept-as "$KEPT"); fi
  if ! check_key "${record[@]}"; then
    echo >&2
    if [ "$KEY_CHECK" = wrong-key ]; then
      echo "The environment's encryption key doesn't open the restored secrets: the dump and the key don't belong together." >&2
      echo "Put back the key the dump was made with (docs/backup.md, \"The key\"), then restart the API." >&2
    else
      echo "Restored $NAMESPACE from $RESTORED ($METHOD), and the API is up; but the key check couldn't run (above)." >&2
      echo "Run it when the API answers (it records the restore in the action log too):" >&2
      echo "  kubectl -n $NAMESPACE exec deploy/$API -c api -- tsx scripts/check-encryption-key.ts ${record[*]}" >&2
    fi
    exit 1
  fi
  echo
  echo "Restored $NAMESPACE from $RESTORED ($METHOD)."
  if [ -n "$KEPT" ]; then
    echo "The database as it was is kept as $KEPT. Drop it once you're satisfied:"
    echo "  kubectl -n $NAMESPACE exec deploy/$RELEASE-postgres -- psql -U optio -d postgres -c 'DROP DATABASE \"$KEPT\"'   (the built-in PostgreSQL)"
  fi
}

if [ -n "$FINISH" ]; then
  [[ "$FINISH" == "$CRONJOB-restore-"* ]] || backup_die "$FINISH isn't a restore job of $CRONJOB"
  JOB="$FINISH"
  backup_restore_lock "$JOB"
  REPLICAS="$(replicas_before_restore)"
  if ! kc get job "$JOB" >/dev/null 2>&1; then
    # Deleted (stopped by hand), or long gone: the API comes back, unless
    # another restore job is still at work.
    others="$(active_restore_jobs)"
    [ -z "$others" ] || backup_die "no job $JOB in $NAMESPACE, but the restore job $others is still running: --finish that one"
    echo "No job $JOB in $NAMESPACE (deleted, or kept no longer than backup.ttlSecondsAfterFinished): starting the API again ($REPLICAS)."
    echo "If it had swapped the databases before it was stopped, the API comes up on the restored one and a <db>_before_<time> database holds the one as it was."
    API_SCALED=1
    exit 1
  fi
  echo "Finishing the restore $JOB in $NAMESPACE (the API at $REPLICAS replicas afterwards)..."
  API_SCALED=1
  RUNNING_JOB="$JOB"
  after_restore_job
  exit 0
fi

RESTORE_JOB="$CRONJOB-restore-$(date -u +%m%d%H%M%S)${BASHPID}${RANDOM}"
[ "${#RESTORE_JOB}" -le 63 ] || backup_die "restore job name is longer than 63 characters (use a shorter release name)"
backup_restore_lock "$RESTORE_JOB"
REPLICAS="$(kc get "deploy/$API" -o jsonpath='{.spec.replicas}')"
case "$REPLICAS" in '' | 0) REPLICAS=1 ;; esac
echo "Restore $NAMESPACE's database from $DUMP."
echo "  - The API ($API, $REPLICAS replicas) stops until it is done: Optio is unavailable meanwhile."
echo "  - Everything written since the dump is replaced: work, runs, settings, people."
echo "  - The database as it is now is kept next to it when the account may create databases."
if [ "$YES" != 1 ]; then
  if [ ! -t 0 ]; then backup_die "no terminal to confirm on: pass --yes"; fi
  read -r -p "Type the namespace ($NAMESPACE) to go on: " answer
  [ "$answer" = "$NAMESPACE" ] || backup_die "not confirmed; nothing changed"
fi
upload

echo "Stopping the API..."
# Its replicas, for --finish if this script doesn't see the restore through.
kc annotate "deploy/$API" "$REPLICAS_ANNOTATION=$REPLICAS" --overwrite >/dev/null 2>&1 || true
kc scale "deploy/$API" --replicas=0 >/dev/null
API_SCALED=1
kc wait --for=delete pod -l app=optio-api --timeout=600s >/dev/null 2>&1 || true
if [ -n "$(kc get pods -l app=optio-api -o name 2>/dev/null)" ]; then
  backup_die "the API's pods are still there after 10 minutes; nothing was restored"
fi

backup_job restore "$DUMP"
RUNNING_JOB="$JOB"
after_restore_job
