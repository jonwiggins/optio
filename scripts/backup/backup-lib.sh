# shellcheck shell=bash
# shellcheck disable=SC2034 # Shared functions return values through these globals.
# Shared by backup-db.sh and restore-db.sh. Namespace comes from
# --namespace or the selected kube context.
#
#   kc <args>                kubectl in the namespace
#   backup_cronjob           CRONJOB=<release>-backup; non-zero when it isn't there
#   backup_job <kind> [dump] [into]
#                            a Job from the CronJob, named so that it does <kind>
#                            (now, pre, restore, drill, list); a dump to restore
#                            and a drill's database go in the ConfigMap
#                            <cronjob>-restore, which the job reads at start
#   backup_wait <job> <secs> waits; 0 done, 1 failed, 2 still running at the
#                            end; JOB_LOG holds the pod's log
#   backup_value <KEY>       the last KEY=value the job printed
#   backup_cleanup           removes the ConfigMap and ends a copy job (call
#                            from an EXIT trap)
#   backup_target            pvc or s3 (or unknown), from the CronJob
#   backup_hold [secs]       a copy job that keeps the dumps' volume mounted
#                            (pvc); HOLD_POD its pod, once it is ready
#   backup_download <dump> <dir>
#                            a dump (a name, latest, latest-pre-upgrade) and
#                            its .sha256 from the held volume into <dir>,
#                            compared there; DOWNLOADED its path
#   backup_upload <file>     a local dump (and the .sha256 next to it) into
#                            the held volume, checked there; UPLOADED its name
#   backup_release           ends the copy job
#
# While a download or an upload runs, a heartbeat touches the copy job's
# .optio-alive-<job> every $OPTIO_BACKUP_HEARTBEAT seconds (60): the job holds
# the volume as long as copies go on (within the Job's deadline,
# backup.activeDeadlineSeconds), and lets it go 30 minutes after the last sign
# of life (helm/optio/files/optio-backup.sh, hold).
#
# Caller's variables: NAMESPACE, RELEASE, KUBECONFIG_FILE, CONTEXT (may be
# empty), WORK (a private temporary directory).

backup_die() {
  echo "ERROR: $*" >&2
  exit 1
}

backup_kube() {
  KUBE_ARGS=()
  if [ -n "${KUBECONFIG_FILE:-}" ]; then KUBE_ARGS+=(--kubeconfig "$KUBECONFIG_FILE"); fi
  if [ -n "${CONTEXT:-}" ]; then KUBE_ARGS+=(--context "$CONTEXT"); fi
  KUBECTL="${KUBECTL:-kubectl}"
  command -v "$KUBECTL" >/dev/null || backup_die "kubectl not found (set KUBECTL or put it on PATH)"
}

backup_env() {
  if [ -z "${NAMESPACE:-}" ]; then
    NAMESPACE="$("$KUBECTL" "${KUBE_ARGS[@]}" config view --minify -o 'jsonpath={..namespace}')" || backup_die "cannot read the current kube context"
    NAMESPACE="${NAMESPACE:-default}"
  fi
  RELEASE="${RELEASE:-$NAMESPACE}"
}

kc() { "$KUBECTL" "${KUBE_ARGS[@]}" -n "$NAMESPACE" "$@"; }

backup_cronjob() {
  CRONJOB="$RELEASE-backup"
  kc get cronjob "$CRONJOB" >/dev/null 2>&1
}

# A Job's name is at most 63 characters (it becomes a label).
backup_job() {
  local kind="$1" dump="${2:-}" into="${3:-}" stamp
  stamp="$(date -u +%m%d%H%M%S)"
  JOB="$CRONJOB-$kind-$stamp"
  [ "${#JOB}" -le 63 ] || backup_die "the job name $JOB is longer than 63 characters (a shorter release name)"
  if [ -n "$dump" ]; then
    kc create configmap "$CRONJOB-restore" --from-literal=dump="$dump" --from-literal=into="$into" \
      --dry-run=client -o yaml | kc apply -f - >/dev/null
    BACKUP_CONFIGMAP=1
  fi
  kc create job "$JOB" --from="cronjob/$CRONJOB" >/dev/null
  echo "Job $JOB started (namespace $NAMESPACE)"
}

backup_cleanup() {
  if [ -n "${BACKUP_CONFIGMAP:-}" ]; then
    kc delete configmap "$CRONJOB-restore" --ignore-not-found >/dev/null 2>&1 || true
    BACKUP_CONFIGMAP=""
  fi
  backup_release
}

# The newest pod of a job.
job_pod() { kc get pods -l "batch.kubernetes.io/job-name=$1" --sort-by=.metadata.creationTimestamp -o name 2>/dev/null | tail -n 1; }

backup_wait() {
  local job="$1" secs="$2" start state pod phase last="" now
  start=$SECONDS
  JOB_LOG="$WORK/$job.log"
  : >"$JOB_LOG"
  while :; do
    state="$(kc get job "$job" -o jsonpath='{range .status.conditions[*]}{.type}={.status} {end}' 2>/dev/null || true)"
    case " $state " in
      *" Complete=True "*) break ;;
      *" Failed=True "*) break ;;
    esac
    if [ $((SECONDS - start)) -ge "$secs" ]; then
      echo "Job $job is still running after ${secs}s." >&2
      kc get pods -l "batch.kubernetes.io/job-name=$job" -o wide >&2 || true
      kc get events --field-selector "involvedObject.name=$(job_pod "$job" | sed 's#^pod/##')" 2>/dev/null | tail -n 10 >&2 || true
      return 2
    fi
    pod="$(job_pod "$job")"
    phase="$(if [ -n "$pod" ]; then kc get "$pod" -o jsonpath='{.status.phase}' 2>/dev/null; fi || true)"
    now="${phase:-waiting for its pod}"
    if [ "$now" != "$last" ]; then
      echo "  $(date +%T) $job: $now"
      last="$now"
    fi
    sleep 3
  done
  pod="$(job_pod "$job")"
  if [ -n "$pod" ]; then kc logs "$pod" --all-containers >"$JOB_LOG" 2>&1 || true; fi
  sed 's/^/  | /' "$JOB_LOG"
  case " $state " in *" Complete=True "*) return 0 ;; esac
  echo "Job $job failed." >&2
  return 1
}

backup_value() { sed -n "s/^$1=//p" "$JOB_LOG" | tail -n 1; }

# ── Copies of dumps, in and out of the volume (backup.target: pvc) ──────────
# A copy job (<cronjob>-copy-<time>) runs the CronJob's pod with the volume
# mounted and waits (helm/optio/files/optio-backup.sh, "copy-…"); the bytes go
# through `kubectl exec` (no tar, no port), and the job is released and
# deleted at the end. S3 targets are copied with the deployment's own S3 tools.
BACKUP_POD_DIR=/backup
BACKUP_POD_SCRIPT=/opt/optio-backup/optio-backup.sh

backup_target() {
  local c
  c="$(kc get cronjob "$CRONJOB" -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[0].name}' 2>/dev/null || true)"
  case "$c" in pvc) echo pvc ;; store) echo s3 ;; *) echo unknown ;; esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

backup_hold() {
  local secs="${1:-600}" start=$SECONDS pod phase
  backup_job copy
  HOLD_JOB="$JOB"
  HOLD_POD=""
  while :; do
    pod="$(job_pod "$HOLD_JOB")"
    if [ -n "$pod" ]; then
      phase="$(kc get "$pod" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
      case "$phase" in
        Running)
          if kc logs "$pod" -c pvc 2>/dev/null | grep -q '^OPTIO_BACKUP_HOLD=ready$'; then
            HOLD_POD="${pod#pod/}"
            return 0
          fi
          ;;
        Succeeded | Failed)
          kc logs "$pod" --all-containers 2>&1 | sed 's/^/  | /' >&2 || true
          echo "The copy job $HOLD_JOB ended before it held the volume (above)." >&2
          return 1
          ;;
      esac
    fi
    if [ $((SECONDS - start)) -ge "$secs" ]; then
      echo "The copy job $HOLD_JOB wasn't ready after ${secs}s." >&2
      kc get pods -l "batch.kubernetes.io/job-name=$HOLD_JOB" -o wide >&2 || true
      return 1
    fi
    sleep 2
  done
}

# heartbeat_start / heartbeat_stop: the sign of life a copy gives the held
# job while it runs (a background loop; stopped by removing its flag file).
heartbeat_start() {
  local every="${OPTIO_BACKUP_HEARTBEAT:-60}"
  case "$every" in '' | *[!0-9]* | 0) every=60 ;; esac
  heartbeat_stop
  HEARTBEAT_FLAG="$WORK/.heartbeat-$HOLD_JOB"
  : >"$HEARTBEAT_FLAG"
  (
    n=0
    while [ -e "$HEARTBEAT_FLAG" ]; do
      sleep 1
      n=$((n + 1))
      if [ "$n" -ge "$every" ] && [ -e "$HEARTBEAT_FLAG" ]; then
        n=0
        kc exec "$HOLD_POD" -c pvc -- touch "$BACKUP_POD_DIR/.optio-alive-$HOLD_JOB" >/dev/null 2>&1 || true
      fi
    done
  ) &
  HEARTBEAT_PID=$!
}

heartbeat_stop() {
  if [ -n "${HEARTBEAT_PID:-}" ]; then
    rm -f "$HEARTBEAT_FLAG"
    wait "$HEARTBEAT_PID" 2>/dev/null || true
    HEARTBEAT_PID=""
  fi
}

backup_release() {
  heartbeat_stop
  if [ -n "${HOLD_JOB:-}" ]; then
    if [ -n "${HOLD_POD:-}" ]; then
      kc exec "$HOLD_POD" -c pvc -- touch "$BACKUP_POD_DIR/.optio-release-$HOLD_JOB" >/dev/null 2>&1 || true
    fi
    kc delete job "$HOLD_JOB" --ignore-not-found --wait=false >/dev/null 2>&1 || true
    HOLD_JOB=""
    HOLD_POD=""
  fi
}

backup_download() {
  local want="$1" dir="$2" name part sums
  name="$(kc exec "$HOLD_POD" -c pvc -- sh "$BACKUP_POD_SCRIPT" which "$want" 2>/dev/null | tail -n 1 || true)"
  [ -n "$name" ] || backup_die "no dump $want in $NAMESPACE (scripts/backup/restore-db.sh … --list)"
  mkdir -p "$dir"
  part="$dir/.$name.download"
  sums="$dir/.$name.sha256.download"
  echo "Copying $name out of $NAMESPACE's backup volume into $dir..."
  heartbeat_start
  if ! kc exec "$HOLD_POD" -c pvc -- cat "$BACKUP_POD_DIR/$name" >"$part"; then
    heartbeat_stop
    rm -f "$part"
    backup_die "couldn't copy $name"
  fi
  heartbeat_stop
  if kc exec "$HOLD_POD" -c pvc -- cat "$BACKUP_POD_DIR/$name.sha256" >"$sums" 2>/dev/null && [ -s "$sums" ]; then
    if [ "$(cut -d' ' -f1 <"$sums")" != "$(sha256_of "$part")" ]; then
      rm -f "$part" "$sums"
      backup_die "the copy of $name doesn't match its .sha256: nothing was kept in $dir"
    fi
    mv "$sums" "$dir/$name.sha256"
    echo "  $name matches its .sha256"
  else
    rm -f "$sums"
    echo "  $name has no .sha256 there: not compared" >&2
  fi
  mv "$part" "$dir/$name"
  DOWNLOADED="$dir/$name"
}

backup_upload() {
  local file="$1" name
  name="$(basename "$file")"
  echo "Copying $file into $NAMESPACE's backup volume..."
  # The heartbeat stops with the copy job (backup_release, the EXIT trap) if this dies.
  heartbeat_start
  # shellcheck disable=SC2016 # $1 is the pod's shell's
  kc exec -i "$HOLD_POD" -c pvc -- sh -c 'cat >"$1"' sh "$BACKUP_POD_DIR/.$name.upload" <"$file" ||
    backup_die "couldn't copy $file into the volume"
  if [ -f "$file.sha256" ]; then
    # shellcheck disable=SC2016
    kc exec -i "$HOLD_POD" -c pvc -- sh -c 'cat >"$1"' sh "$BACKUP_POD_DIR/.$name.sha256.upload" <"$file.sha256" ||
      backup_die "couldn't copy $file.sha256 into the volume"
  fi
  if ! kc exec "$HOLD_POD" -c pvc -- sh "$BACKUP_POD_SCRIPT" accept "$name" >"$WORK/accept.log" 2>&1; then
    sed 's/^/  | /' "$WORK/accept.log" >&2
    backup_die "the volume didn't take $name (above)"
  fi
  heartbeat_stop
  sed 's/^/  | /' "$WORK/accept.log"
  UPLOADED="$name"
}
