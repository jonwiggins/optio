#!/usr/bin/env bash
# Fixture filenames are controlled; assertions intentionally use success/failure chains.
# shellcheck disable=SC2010,SC2012,SC2015,SC2016
# The backup and restore scripts' own logic, with no cluster: backup-db.sh,
# restore-db.sh and deploy-env.sh's dump before the upgrade run against a
# stand-in kubectl (and helm) that records every call and answers from a
# scenario: whether the CronJob is there, how each job ends, what its pod
# logged, whether the key check passes, whether the upgrade does.
#
#   scripts/backup/test-backup-scripts.sh      # helm on PATH for the render (HELM=…)
#
# The job script itself (helm/optio/files/optio-backup.sh) is tested against
# a real PostgreSQL by test-backup.sh.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2
REAL_HELM="$(command -v "${HELM:-helm}")" || { echo "helm not found (set HELM)" >&2; exit 2; }
FAILED=0
pass() { echo "ok    $*"; }
fail() {
  echo "FAIL  $*" >&2
  FAILED=1
}
expect() {
  if [ "$2" = "$3" ]; then pass "$1"; else
    fail "$1: got '$2', want '$3'"
    return 1
  fi
}
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAKE="$WORK/fake"
mkdir -p "$WORK/bin"

# ── The stand-in kubectl ────────────────────────────────────────────────────
cat >"$WORK/bin/kubectl" <<'KUBECTL'
#!/usr/bin/env bash
# Records "kubectl <args>" in $FAKE/calls and answers from files in $FAKE.
echo "kubectl $*" >>"$FAKE/calls"
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -n | --namespace | --context) shift ;;
    *) args+=("$1") ;;
  esac
  shift
done
set -- "${args[@]}"
kind_of() { sed -E 's/.*-backup-(now|pre|restore|drill|list|copy)-[0-9]+.*/\1/' <<<"$1"; }
# A pod's exec: the command after "--", against the stand-in volume $FAKE/vol.
pod_exec() {
  while [ $# -gt 0 ] && [ "$1" != -- ]; do shift; done
  shift
  local path
  case "$1 ${2:-} ${3:-}" in
    "sh /opt/optio-backup/optio-backup.sh which")
      case "$4" in
        latest) ls -1 "$FAKE/vol" | grep -E '\.dump$' | sort | tail -n 1 ;;
        latest-pre-upgrade) ls -1 "$FAKE/vol" | grep -E 'pre-upgrade\.dump$' | sort | tail -n 1 ;;
        *) [ -f "$FAKE/vol/$4" ] && echo "$4" ;;
      esac
      return 0 ;;
    "sh /opt/optio-backup/optio-backup.sh accept")
      if [ -e "$FAKE/fail-accept" ]; then echo "optio-backup accept: ERROR: $4 didn't pass its check; nothing was kept" >&2; return 1; fi
      mv "$FAKE/vol/.$4.upload" "$FAKE/vol/$4"
      if [ -f "$FAKE/vol/.$4.sha256.upload" ]; then mv "$FAKE/vol/.$4.sha256.upload" "$FAKE/vol/$4.sha256"; fi
      echo "OPTIO_BACKUP_DUMP=$4" ;;
    "cat "*)
      path="${2#/backup/}"
      if [ -e "$FAKE/slow-copy" ]; then sleep 3; fi
      cat "$FAKE/vol/$path" ;;
    "sh -c "*) path="${5#/backup/}"; cat >"$FAKE/vol/$path" ;;
    "touch "*)
      case "$2" in
        */.optio-release-*) touch "$FAKE/released" ;;
        */.optio-alive-*) echo "$2" >>"$FAKE/alive" ;;
        *) echo "stand-in kubectl: touch $2" >&2; return 2 ;;
      esac ;;
    *) echo "stand-in kubectl: exec $*" >&2; return 2 ;;
  esac
}
# A job is gone once deleted; its pods once deleted with it or waited away
# (unless $FAKE/pods-stay).
job_deleted() { grep -qxF -- "$1" "$FAKE/deleted-jobs" 2>/dev/null; }
case "$1 ${2:-}" in
  "config view") printf '%s' "${FAKE_NAMESPACE:-}" ;;
  "get cronjob")
    [ -e "$FAKE/cronjob" ] || exit 1
    case "$*" in
      *jsonpath=*containers*) cat "$FAKE/target" ;;
      *jsonpath=*activeDeadlineSeconds*) cat "$FAKE/deadline" 2>/dev/null || true ;;
    esac ;;
  "get serviceaccount") exit 0 ;;
  "get secret" | "get namespace") exit 1 ;;
  "get configmap") exit 1 ;;
  "create configmap")
    printf 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: %s}\ndata: %s\n' "$3" "${*:4}" ;;
  "apply -f") cat >"$FAKE/configmap" ;;
  "delete configmap") echo "$3" >>"$FAKE/deleted" ;;
  "create job") echo "$3" >>"$FAKE/jobs" ;;
  "delete job")
    echo "$3" >>"$FAKE/deleted-jobs"
    [ -e "$FAKE/pods-stay" ] || touch "$FAKE/pods-gone-$3" ;;
  "get job")
    if job_deleted "$3"; then echo "Error from server (NotFound): jobs.batch \"$3\" not found" >&2; exit 1; fi
    k="$(kind_of "$3")"
    if [ -e "$FAKE/hang-$k" ]; then echo ""
    elif [ -e "$FAKE/fail-$k" ]; then echo "Failed=True "
    else echo "Complete=True "; fi ;;
  "get jobs") cat "$FAKE/active-jobs" 2>/dev/null || true ;;
  "get pods")
    case "$*" in
      *app=optio-api*) if [ "$(cat "$FAKE/replicas")" != 0 ]; then echo "pod/api-1"; fi ;;
      *batch.kubernetes.io/job-name=*)
        all="$*"; j="${all##*job-name=}"; j="${j%% *}"
        [ -e "$FAKE/pods-gone-$j" ] || echo "pod/$j-x1" ;;
      *) echo "NAME READY" ;;
    esac ;;
  "get pod/"*) if [ "$(kind_of "$2")" = copy ]; then echo Running; else echo Succeeded; fi ;;
  "logs pod/"*) k="$(kind_of "$2")"; cat "$FAKE/log-$k" 2>/dev/null || true ;;
  "logs deploy/"*) echo "(the API's log)" ;;
  "get deploy/"*)
    case "$*" in
      *annotations*) cat "$FAKE/annotation" 2>/dev/null || true ;;
      *) cat "$FAKE/replicas" ;;
    esac ;;
  "annotate deploy/"*)
    case "$3" in
      *-) rm -f "$FAKE/annotation" ;;
      *=*) echo "${3#*=}" >"$FAKE/annotation" ;;
    esac ;;
  "scale deploy/"*) all="$*"; r="${all##*--replicas=}"; echo "${r%% *}" >"$FAKE/replicas" ;;
  "wait --for=delete")
    case "$*" in
      *app=optio-api*) if [ -e "$FAKE/api-slow-stop" ]; then sleep 5; fi ;;
      *batch.kubernetes.io/job-name=*)
        [ ! -e "$FAKE/pods-stay" ] || exit 1
        all="$*"; j="${all##*job-name=}"; touch "$FAKE/pods-gone-${j%% *}" ;;
    esac ;;
  "rollout status") [ ! -e "$FAKE/fail-rollout" ] ;;
  "exec deploy/"*)
    # As scripts/check-encryption-key.ts prints, and kubectl's own failure.
    if [ -e "$FAKE/kubectl-exec-error" ]; then echo "error: unable to upgrade connection: container not found (\"api\")" >&2; exit 1; fi
    if [ -e "$FAKE/key-error" ]; then echo "The key check couldn't read optio: connect ECONNREFUSED 10.43.0.7:5432" >&2; exit 2; fi
    if [ -e "$FAKE/fail-key" ]; then
      echo "encryption key: opens 0 of 3 stored secrets in optio"
      echo "  It opens none: this deployment's OPTIO_ENCRYPTION_KEY is not the key these secrets were stored with."
      exit 1
    fi
    echo "encryption key: opens 3 of 3 stored secrets" ;;
  "exec "*) pod_exec "$@" ;;
  "get events") exit 0 ;;
  *) exit 0 ;;
esac
KUBECTL
# ── The stand-in helm: renders with the real one, fakes the cluster ─────────
cat >"$WORK/bin/helm" <<HELM
#!/usr/bin/env bash
echo "helm \$*" >>"\$FAKE/calls"
case "\$1" in
  template) exec "$REAL_HELM" "\$@" ;;
  status) echo '{"info":{"status":"deployed"}}' ;;
  upgrade)
    case " \$* " in
      *" --dry-run=server "*) printf 'kind: ConfigMap\n  image: "registry.test/optio/optio-api:t1"\n' ;;
      *) [ ! -e "\$FAKE/fail-upgrade" ] ;;
    esac ;;
esac
HELM
chmod +x "$WORK/bin/kubectl" "$WORK/bin/helm"
export FAKE KUBECTL="$WORK/bin/kubectl" HELM="$WORK/bin/helm"
unset OPTIO_KUBECONFIG OPTIO_KUBE_CONTEXT OPTIO_VALUES OPTIO_VALUES_STAGING OPTIO_KUBECONFIG_STAGING OPTIO_CA_FILE

DUMP=optio-20261024T101500Z-manual.dump
PRE=optio-20261024T101600Z-pre-upgrade.dump
scenario() { # fresh state: the CronJob there (a volume), 2 API replicas, canned logs, two dumps on the volume
  rm -rf "$FAKE"
  mkdir -p "$FAKE/vol"
  : >"$FAKE/calls"
  touch "$FAKE/cronjob"
  echo pvc >"$FAKE/target"
  echo 7200 >"$FAKE/deadline"
  printf 'dump bytes %s\n' "$DUMP" >"$FAKE/vol/$DUMP"
  printf 'dump bytes %s\n' "$PRE" >"$FAKE/vol/$PRE"
  for n in "$DUMP" "$PRE"; do (cd "$FAKE/vol" && sha256sum "$n" >"$n.sha256"); done
  printf '10:15:00 optio-backup pvc: holding pvc/optio-staging-backup for a copy\nOPTIO_BACKUP_HOLD=ready\n' >"$FAKE/log-copy"
  echo 2 >"$FAKE/replicas"
  printf '10:15:00 optio-backup pvc: checked\nOPTIO_BACKUP_DUMP=%s\nOPTIO_BACKUP_SIZE=1234\nOPTIO_BACKUP_LOCATION=pvc/optio-staging-backup/%s\n' "$DUMP" "$DUMP" >"$FAKE/log-now"
  printf 'OPTIO_BACKUP_DUMP=%s\nOPTIO_BACKUP_SIZE=1234\nOPTIO_BACKUP_LOCATION=pvc/x/%s\n' "$PRE" "$PRE" >"$FAKE/log-pre"
  printf '10:15:00 optio-backup pvc: dumps in pvc/optio-staging-backup:\nOPTIO_BACKUP_LIST=%s 1234\nOPTIO_BACKUP_LIST=%s 2345\n' "$DUMP" "$PRE" >"$FAKE/log-list"
  printf 'OPTIO_RESTORE_DUMP=%s\nOPTIO_RESTORE_METHOD=swap\nOPTIO_RESTORE_KEPT=optio_before_20261024101700\n' "$DUMP" >"$FAKE/log-restore"
  printf 'OPTIO_RESTORE_DUMP=%s\nOPTIO_RESTORE_METHOD=drill\nOPTIO_RESTORE_DATABASE=optio_drill\n' "$DUMP" >"$FAKE/log-drill"
}
calls() { grep -c -- "$1" "$FAKE/calls" || true; }
# order <pattern...>: the calls matching each pattern appear in this order
order() {
  local last=0 n p
  for p in "$@"; do
    n="$(grep -n -- "$p" "$FAKE/calls" | head -n 1 | cut -d: -f1)"
    if [ -z "$n" ] || [ "$n" -le "$last" ]; then echo "no"; return; fi
    last="$n"
  done
  echo "yes"
}
run() { # <out> <cmd...>: its output in <out>, its status in <out>.status
  local out="$1"
  shift
  "$@" >"$out" 2>&1 </dev/null
  echo $? >"$out.status"
}
st() { cat "$1.status"; }

# Namespace resolution uses the selected context, then kubectl's default.
scenario
run "$WORK/context-ns" env FAKE_NAMESPACE=from-context scripts/backup/backup-db.sh
expect "backup-db: context namespace" "$(st "$WORK/context-ns")" 0
grep -q -- '-n from-context create job from-context-backup-now-' "$FAKE/calls" && pass "backup-db: uses context namespace and release" || fail "backup-db: context namespace"
scenario
run "$WORK/default-ns" env FAKE_NAMESPACE= scripts/backup/backup-db.sh
expect "backup-db: empty context namespace" "$(st "$WORK/default-ns")" 0
grep -q -- '-n default create job default-backup-now-' "$FAKE/calls" && pass "backup-db: falls back to default namespace" || fail "backup-db: default namespace"

# ── backup-db.sh ────────────────────────────────────────────────────────────
scenario
rm "$FAKE/cronjob"
run "$WORK/b0" scripts/backup/backup-db.sh --namespace optio-staging
expect "backup-db: no CronJob → status 3" "$(st "$WORK/b0")" 3
grep -q "backups are off there" "$WORK/b0" && pass "backup-db: …and says so" || fail "backup-db: no-CronJob message"
expect "backup-db: no CronJob → no job started" "$(calls 'create job')" 0

scenario
run "$WORK/b1" scripts/backup/backup-db.sh --namespace optio-staging
expect "backup-db: status" "$(st "$WORK/b1")" 0 || cat "$WORK/b1"
expect "backup-db: the namespace from staging's values" "$(calls '-n optio-staging get cronjob optio-staging-backup')" 1
grep -qE '^optio-staging-backup-now-[0-9]{10}$' "$FAKE/jobs" && pass "backup-db: a by-hand job ($(cat "$FAKE/jobs"))" || fail "backup-db: job name $(cat "$FAKE/jobs")"
expect "backup-db: last line" "$(tail -n 1 "$WORK/b1")" "OPTIO_BACKUP_DUMP=$DUMP"
grep -qF "Restore it: scripts/backup/restore-db.sh --namespace optio-staging $DUMP" "$WORK/b1" && pass "backup-db: prints the restore command" || fail "backup-db: restore command"
expect "backup-db: no ConfigMap for a dump" "$(calls 'create configmap')" 0

scenario
run "$WORK/b2" scripts/backup/backup-db.sh --namespace optio-x --release rel --reason pre-upgrade
grep -qE '^rel-backup-pre-[0-9]{10}$' "$FAKE/jobs" && pass "backup-db --reason pre-upgrade: a pre job of the release's CronJob" || fail "backup-db pre: $(cat "$FAKE/jobs")"
grep -qF "restore-db.sh --namespace optio-x --release rel $PRE" "$WORK/b2" && pass "backup-db --namespace: the restore command names it" || fail "backup-db --namespace: $(grep Restore "$WORK/b2")"

scenario
touch "$FAKE/fail-now"
run "$WORK/b3" scripts/backup/backup-db.sh --namespace optio-staging
expect "backup-db: a failed job → status 1" "$(st "$WORK/b3")" 1
run "$WORK/b4" scripts/backup/backup-db.sh --namespace optio-staging --reason weekly
expect "backup-db: an unknown reason → status 2" "$(st "$WORK/b4")" 2

# ── backup-db.sh: copies off the cluster ───────────────────────────────────
scenario
run "$WORK/c1" scripts/backup/backup-db.sh --namespace optio-staging --to "$WORK/out1"
expect "backup-db --to: status" "$(st "$WORK/c1")" 0 || cat "$WORK/c1"
expect "backup-db --to: the dump, then a copy job" "$(order 'create job optio-staging-backup-now-' 'create job optio-staging-backup-copy-')" yes
cmp -s "$WORK/out1/$DUMP" "$FAKE/vol/$DUMP" && pass "backup-db --to: the dump's bytes here" || fail "backup-db --to: $(ls -A "$WORK/out1" 2>&1)"
(cd "$WORK/out1" && sha256sum -c "$DUMP.sha256" >/dev/null 2>&1) && pass "backup-db --to: its .sha256 next to it" || fail "backup-db --to: .sha256"
expect "backup-db --to: the copy job released and deleted" "$([ -e "$FAKE/released" ] && echo yes) $(grep -c -- '-copy-' "$FAKE/deleted-jobs" 2>/dev/null)" "yes 1"
expect "backup-db --to: last line" "$(tail -n 1 "$WORK/c1")" "OPTIO_BACKUP_DUMP=$DUMP"

scenario
run "$WORK/c2" scripts/backup/backup-db.sh --namespace optio-staging --download latest-pre-upgrade --to "$WORK/out2"
expect "backup-db --download: status" "$(st "$WORK/c2")" 0 || cat "$WORK/c2"
expect "backup-db --download: no new dump" "$(grep -c -- '-now-\|-pre-' "$FAKE/jobs")" 0
cmp -s "$WORK/out2/$PRE" "$FAKE/vol/$PRE" && pass "backup-db --download latest-pre-upgrade: that dump here" || fail "backup-db --download: $(ls -A "$WORK/out2" 2>&1)"
grep -qF "restore-db.sh --namespace <name> $WORK/out2/$PRE" "$WORK/c2" && pass "backup-db --download: how to restore the file elsewhere" || fail "backup-db --download: restore line"

scenario
echo "0000  $DUMP" >"$FAKE/vol/$DUMP.sha256"
run "$WORK/c3" scripts/backup/backup-db.sh --namespace optio-staging --download "$DUMP" --to "$WORK/out3"
expect "backup-db --download: a copy that doesn't match its .sha256 → status 1" "$(st "$WORK/c3")" 1
expect "…nothing kept here" "$(ls -A "$WORK/out3" 2>/dev/null | wc -l | tr -d ' ')" 0
expect "…the copy job deleted all the same" "$(grep -c -- '-copy-' "$FAKE/deleted-jobs" 2>/dev/null)" 1

scenario
run "$WORK/c4" scripts/backup/backup-db.sh --namespace optio-staging --download optio-20991231T000000Z.dump --to "$WORK/out4"
expect "backup-db --download: a dump that isn't there → status 1" "$(st "$WORK/c4")" 1

# A long copy: a sign of life to the copy job while it runs, none after.
scenario
touch "$FAKE/slow-copy"
run "$WORK/c4b" env OPTIO_BACKUP_HEARTBEAT=1 scripts/backup/backup-db.sh --namespace optio-staging --download "$DUMP" --to "$WORK/out4b"
expect "backup-db --download, a slow copy: status" "$(st "$WORK/c4b")" 0 || cat "$WORK/c4b"
alive="$(grep -c '/backup/.optio-alive-optio-staging-backup-copy-' "$FAKE/alive" 2>/dev/null || echo 0)"
[ "$alive" -ge 1 ] && pass "…the copy job told it is still in use ($alive times)" || fail "…no sign of life during the copy"
sleep 2
expect "…and no more once the copy is done" "$(grep -c . "$FAKE/alive" 2>/dev/null || echo 0)" "$alive"

scenario
echo s3 >"$FAKE/target"
run "$WORK/c5" scripts/backup/backup-db.sh --namespace optio-staging --to "$WORK/out5"
expect "backup-db --to with an S3 target → status 2" "$(st "$WORK/c5")" 2
expect "…no job started" "$(calls 'create job')" 0
grep -q "aws s3 cp" "$WORK/c5" && pass "…and says to use the S3 tools" || fail "…S3 message"
run "$WORK/c6" scripts/backup/backup-db.sh --namespace optio-staging --download ../../etc/passwd
expect "backup-db --download of a path, not a dump's name → status 2" "$(st "$WORK/c6")" 2

# ── restore-db.sh ───────────────────────────────────────────────────────────
scenario
run "$WORK/r0" scripts/backup/restore-db.sh --namespace optio-staging ../../etc/passwd --yes
expect "restore-db: not a dump's name → status 2" "$(st "$WORK/r0")" 2
expect "restore-db: …before any kubectl call" "$(wc -l <"$FAKE/calls" | tr -d ' ')" 0
run "$WORK/r0b" scripts/backup/restore-db.sh --namespace optio-staging latest --into-database 'Optio;x'
expect "restore-db: a drill database that isn't plain → status 2" "$(st "$WORK/r0b")" 2

scenario
run "$WORK/r1" scripts/backup/restore-db.sh --namespace optio-staging --list
expect "restore-db --list: status" "$(st "$WORK/r1")" 0
grep -qE "^  $DUMP +1234 bytes$" "$WORK/r1" && pass "restore-db --list: names and sizes" || { fail "restore-db --list"; cat "$WORK/r1"; }
expect "restore-db --list: nothing scaled" "$(calls 'scale ')" 0

scenario
run "$WORK/r2" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP"
expect "restore-db without --yes and no terminal: refused" "$(st "$WORK/r2")" 1
expect "…nothing scaled, no job" "$(calls 'scale ') $(calls 'create job')" "0 0"

scenario
run "$WORK/r3" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes
expect "restore-db: status" "$(st "$WORK/r3")" 0 || cat "$WORK/r3"
expect "restore-db: stop the API, the dump named, restore, start the API, check the key, clean up" \
  "$(order 'get deploy/optio-staging-api' 'scale deploy/optio-staging-api --replicas=0' 'create configmap optio-staging-backup-restore' 'create job optio-staging-backup-restore-' 'scale deploy/optio-staging-api --replicas=2' 'rollout status deploy/optio-staging-api' 'check-encryption-key.ts --record-restore' 'delete configmap optio-staging-backup-restore')" yes
grep -q "dump=$DUMP" "$FAKE/configmap" && pass "restore-db: the ConfigMap names the dump" || fail "restore-db: ConfigMap $(cat "$FAKE/configmap")"
expect "restore-db: the key check records the restore and the kept database" \
  "$(calls "tsx scripts/check-encryption-key.ts --record-restore $DUMP --kept-as optio_before_20261024101700")" 1
expect "restore-db: the API back at its replicas" "$(cat "$FAKE/replicas")" 2
grep -q "kept as optio_before_20261024101700" "$WORK/r3" && pass "restore-db: says where the old database is" || fail "restore-db: kept"

scenario
touch "$FAKE/fail-restore"
run "$WORK/r4" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes
expect "restore-db: a failed restore → status 1" "$(st "$WORK/r4")" 1
expect "…the API started again" "$(cat "$FAKE/replicas")" 2
expect "…no key check" "$(calls 'check-encryption-key')" 0
expect "…the ConfigMap removed" "$(calls 'delete configmap optio-staging-backup-restore')" 1

scenario
touch "$FAKE/fail-key"
run "$WORK/r5" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes
expect "restore-db: the key doesn't open the secrets → status 1" "$(st "$WORK/r5")" 1
grep -q "don't belong together" "$WORK/r5" && pass "…and says the dump and the key don't belong together" || fail "…key message"
expect "…the API stays up" "$(cat "$FAKE/replicas")" 2

scenario
printf 'OPTIO_BACKUP_DUMP=%s\nOPTIO_BACKUP_SIZE=1\n' "$DUMP" >"$FAKE/log-restore"
run "$WORK/r4b" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes
expect "restore-db: a job that ended well but restored nothing → status 1" "$(st "$WORK/r4b")" 1
expect "…the API started again, no key check" "$(cat "$FAKE/replicas") $(calls 'check-encryption-key')" "2 0"
scenario
printf 'OPTIO_BACKUP_DUMP=%s\n' "$DUMP" >"$FAKE/log-drill"
run "$WORK/r4c" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --into-database optio_drill
expect "restore-db drill: a job that restored nothing → status 1, no key check" "$(st "$WORK/r4c") $(calls 'check-encryption-key')" "1 0"

scenario
echo 0 >"$FAKE/replicas"
run "$WORK/r6" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes
expect "restore-db: an API at 0 replicas comes back with 1" "$(cat "$FAKE/replicas")" 1

scenario
run "$WORK/r7" scripts/backup/restore-db.sh --namespace optio-staging latest --into-database optio_drill
expect "restore-db drill: status" "$(st "$WORK/r7")" 0 || cat "$WORK/r7"
expect "restore-db drill: the API not touched" "$(calls 'scale ')" 0
grep -qE '^optio-staging-backup-drill-[0-9]{10}$' "$FAKE/jobs" && pass "restore-db drill: a drill job" || fail "restore-db drill: $(cat "$FAKE/jobs")"
grep -q "into=optio_drill" "$FAKE/configmap" && grep -q "dump=latest" "$FAKE/configmap" && pass "restore-db drill: the ConfigMap names the dump and the database" || fail "drill ConfigMap: $(cat "$FAKE/configmap")"
expect "restore-db drill: the key checked against the drill's database, then dropped" \
  "$(calls 'check-encryption-key.ts --database optio_drill --drop-after')" 1
scenario
run "$WORK/r8" scripts/backup/restore-db.sh --namespace optio-staging latest --into-database optio_drill --keep
expect "restore-db drill --keep: not dropped" "$(calls 'check-encryption-key.ts --database optio_drill$')" 1

scenario
rm "$FAKE/cronjob"
run "$WORK/r9" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes
expect "restore-db: no CronJob → status 1" "$(st "$WORK/r9")" 1
expect "…nothing scaled" "$(calls 'scale ')" 0

# ── restore-db.sh: a restore job that doesn't end while the script waits ────
RJOB_RE='optio-staging-backup-restore-[0-9]+'
restore_job() { grep -E "^$RJOB_RE\$" "$FAKE/jobs" | tail -n 1; }
scenario
run "$WORK/t0" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes
grep -q "at most 7500s" "$WORK/t0" && pass "restore-db: waits for the job its own deadline and 5 minutes" || fail "restore-db: the job's wait: $(grep 'at most' "$WORK/t0")"

scenario
touch "$FAKE/hang-restore"
run "$WORK/t1" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes --timeout 2
expect "restore-db: the job still running at the timeout → status 1" "$(st "$WORK/t1")" 1
expect "…the API stays stopped (the job may still swap the database)" "$(cat "$FAKE/replicas")" 0
expect "…no scale back, no key check" "$(calls 'scale deploy/optio-staging-api --replicas=2') $(calls 'check-encryption-key')" "0 0"
expect "…the job left to finish (not deleted)" "$(calls 'delete job optio-staging-backup-restore-')" 0
expect "…the ConfigMap naming the dump kept for it" "$(calls 'delete configmap')" 0
T1JOB="$(restore_job)"
grep -qF "scripts/backup/restore-db.sh --namespace optio-staging --finish $T1JOB" "$WORK/t1" && pass "…and says how to finish it (--finish $T1JOB)" || { fail "…the --finish line"; cat "$WORK/t1"; }
grep -q "the database was not changed" "$WORK/t1" && fail "…claims the database wasn't changed" || pass "…without claiming the database wasn't changed"
expect "…the API's replicas noted on it for --finish" "$(cat "$FAKE/annotation" 2>/dev/null)" 2

# --finish, once the job has ended: the API at its replicas, the key checked, the restore recorded.
rm "$FAKE/hang-restore"
run "$WORK/t2" scripts/backup/restore-db.sh --namespace optio-staging --finish "$T1JOB"
expect "restore-db --finish: status" "$(st "$WORK/t2")" 0 || cat "$WORK/t2"
expect "restore-db --finish: the API back at the replicas it had" "$(cat "$FAKE/replicas")" 2
expect "restore-db --finish: the key checked and the restore recorded" \
  "$(calls "check-encryption-key.ts --record-restore $DUMP --kept-as optio_before_20261024101700")" 1
expect "restore-db --finish: the note and the ConfigMap removed" "$([ -e "$FAKE/annotation" ] && echo note) $(calls 'delete configmap optio-staging-backup-restore')" " 1"

scenario
touch "$FAKE/hang-restore"
run "$WORK/t3" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes --timeout 2
touch "$FAKE/fail-restore"
rm "$FAKE/hang-restore"
run "$WORK/t3b" scripts/backup/restore-db.sh --namespace optio-staging --finish "$(restore_job)"
expect "restore-db --finish of a job that failed → status 1, the API back, no key check" \
  "$(st "$WORK/t3b") $(cat "$FAKE/replicas") $(calls 'check-encryption-key')" "1 2 0"

scenario
touch "$FAKE/hang-restore"
run "$WORK/t4" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes --timeout 2
T4JOB="$(restore_job)"
echo "$T4JOB" >>"$FAKE/deleted-jobs" # stopped by hand: kubectl delete job
run "$WORK/t4b" scripts/backup/restore-db.sh --namespace optio-staging --finish "$T4JOB"
expect "restore-db --finish of a deleted job → status 1, the API back at its replicas" "$(st "$WORK/t4b") $(cat "$FAKE/replicas")" "1 2"
grep -q "No job $T4JOB" "$WORK/t4b" && pass "…saying the job isn't there" || fail "…no-job message"

scenario
echo 0 >"$FAKE/replicas"
echo optio-staging-backup-restore-1024000000 >>"$FAKE/deleted-jobs"
printf 'optio-staging-backup-restore-1024101700 1\noptio-staging-backup-1024101600 \n' >"$FAKE/active-jobs"
run "$WORK/t5" scripts/backup/restore-db.sh --namespace optio-staging --finish optio-staging-backup-restore-1024000000
expect "restore-db --finish of a missing job while another restore runs → status 1, the API stays stopped" \
  "$(st "$WORK/t5") $(cat "$FAKE/replicas")" "1 0"
grep -q "optio-staging-backup-restore-1024101700 is still running" "$WORK/t5" && pass "…naming the one that runs" || fail "…the running job: $(cat "$WORK/t5")"
scenario
run "$WORK/t5b" scripts/backup/restore-db.sh --namespace optio-staging --finish 'x; rm -rf /'
expect "restore-db --finish of a name that isn't a restore job's → status 2, before any kubectl call" \
  "$(st "$WORK/t5b") $(wc -l <"$FAKE/calls" | tr -d ' ')" "2 0"

# Stopped while the job runs (TERM: a cancelled pipeline; Ctrl-C goes the same way).
scenario
touch "$FAKE/hang-restore"
scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes --timeout 60 >"$WORK/t6" 2>&1 </dev/null &
pid=$!
n=0
while ! grep -q "create job optio-staging-backup-restore-" "$FAKE/calls" && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
sleep 0.5
kill -TERM "$pid"
wait "$pid"
expect "restore-db stopped while the job runs → status 143" "$?" 143
expect "…the API stays stopped, the job left running" "$(cat "$FAKE/replicas") $(calls 'delete job optio-staging-backup-restore-')" "0 0"
grep -q -- "--finish $(restore_job)" "$WORK/t6" && pass "…and says how to finish it" || { fail "…the --finish line"; cat "$WORK/t6"; }

# Stopped while the API's pods go, before the job: nothing restored, the API back.
scenario
touch "$FAKE/api-slow-stop"
scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes --timeout 60 >"$WORK/t7" 2>&1 </dev/null &
pid=$!
n=0
while ! grep -q "wait --for=delete pod -l app=optio-api" "$FAKE/calls" && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
kill -TERM "$pid"
wait "$pid"
expect "restore-db stopped before the job starts → status 143, no job, the API started again" \
  "$? $(calls 'create job') $(cat "$FAKE/replicas")" "143 0 2"

# A drill that doesn't end: its job is deleted and its database dropped; the API untouched.
scenario
touch "$FAKE/hang-drill"
run "$WORK/t8" scripts/backup/restore-db.sh --namespace optio-staging latest --into-database optio_drill --timeout 2
expect "restore-db drill still running at the timeout → status 1" "$(st "$WORK/t8")" 1
expect "…its job deleted, its pods waited away" "$(calls 'delete job optio-staging-backup-drill-.*--cascade=foreground')" 1
expect "…its database dropped (if it made one)" "$(calls 'check-encryption-key.ts --database optio_drill --drop-after')" 1
expect "…the API not touched" "$(calls 'scale ')" 0
scenario
run "$WORK/t9" scripts/backup/restore-db.sh --namespace optio-staging latest --into-database optio_before_20261024101700
expect "restore-db drill into a restore's kept name → status 2, before any kubectl call" \
  "$(st "$WORK/t9") $(grep -c 'create job' "$FAKE/calls")" "2 0"

# ── restore-db.sh: a key check that can't run is not a wrong key ────────────
scenario
touch "$FAKE/key-error"
run "$WORK/k1" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes
expect "restore-db: the key check can't run → status 1" "$(st "$WORK/k1")" 1
grep -q "the key check couldn't run" "$WORK/k1" && pass "…says it couldn't run" || { fail "…couldn't-run message"; cat "$WORK/k1"; }
grep -q "don't belong together" "$WORK/k1" && fail "…blames the key" || pass "…without blaming the key"
grep -qF "check-encryption-key.ts --record-restore $DUMP --kept-as optio_before_20261024101700" "$WORK/k1" && pass "…and gives the command to run it again" || fail "…the command"
expect "…the API stays up" "$(cat "$FAKE/replicas")" 2
scenario
touch "$FAKE/kubectl-exec-error"
run "$WORK/k2" scripts/backup/restore-db.sh --namespace optio-staging "$DUMP" --yes
expect "restore-db: kubectl's own failure (exit 1, no verdict) → couldn't run, not a wrong key" \
  "$(st "$WORK/k2") $(grep -c "couldn't run" "$WORK/k2") $(grep -c "don't belong together" "$WORK/k2")" "1 1 0"
scenario
touch "$FAKE/key-error"
run "$WORK/k3" scripts/backup/restore-db.sh --namespace optio-staging latest --into-database optio_drill
expect "restore-db drill: the key check can't run → status 1, couldn't run, not a wrong key" \
  "$(st "$WORK/k3") $(grep -c "couldn't run" "$WORK/k3") $(grep -c "don't belong together" "$WORK/k3")" "1 1 0"
scenario
touch "$FAKE/fail-key"
run "$WORK/k4" scripts/backup/restore-db.sh --namespace optio-staging latest --into-database optio_drill
expect "restore-db drill: a wrong key → status 1, the dump and the key don't belong together" \
  "$(st "$WORK/k4") $(grep -c "don't belong together" "$WORK/k4")" "1 1"

# restore-db.sh with a file: copied into the volume first, then restored by its name.
OTHER=optio-20261020T021500Z.dump
mkdir -p "$WORK/copies"
printf 'dump bytes from another environment\n' >"$WORK/copies/$OTHER"
(cd "$WORK/copies" && sha256sum "$OTHER" >"$OTHER.sha256")
scenario
run "$WORK/f1" scripts/backup/restore-db.sh --namespace optio-staging "$WORK/copies/$OTHER" --yes
expect "restore-db <file>: status" "$(st "$WORK/f1")" 0 || cat "$WORK/f1"
expect "restore-db <file>: upload, checked, then stop the API and restore it by name" \
  "$(order 'create job optio-staging-backup-copy-' 'exec -i ' 'optio-backup.sh accept '"$OTHER" 'delete job optio-staging-backup-copy-' 'scale deploy/optio-staging-api --replicas=0' 'create job optio-staging-backup-restore-')" yes
cmp -s "$FAKE/vol/$OTHER" "$WORK/copies/$OTHER" && [ -f "$FAKE/vol/$OTHER.sha256" ] && pass "restore-db <file>: the file and its .sha256 in the volume" || fail "restore-db <file>: volume $(ls -A "$FAKE/vol")"
grep -q "dump=$OTHER" "$FAKE/configmap" && pass "restore-db <file>: the restore names it by its name" || fail "restore-db <file>: ConfigMap $(cat "$FAKE/configmap")"

scenario
touch "$FAKE/fail-accept"
run "$WORK/f2" scripts/backup/restore-db.sh --namespace optio-staging "$WORK/copies/$OTHER" --yes
expect "restore-db <file> the volume refuses → status 1" "$(st "$WORK/f2")" 1
expect "…nothing scaled, no restore job" "$(calls 'scale ') $(calls 'create job optio-staging-backup-restore-')" "0 0"
expect "…the copy job deleted" "$(grep -c -- '-copy-' "$FAKE/deleted-jobs" 2>/dev/null)" 1
grep -q "didn't pass its check" "$WORK/f2" && pass "…and shows why" || fail "…accept's message"

scenario
echo s3 >"$FAKE/target"
run "$WORK/f3" scripts/backup/restore-db.sh --namespace optio-staging "$WORK/copies/$OTHER" --yes
expect "restore-db <file> with an S3 target → status 1" "$(st "$WORK/f3")" 1
expect "…nothing scaled, no job" "$(calls 'scale ') $(calls 'create job')" "0 0"

scenario
cp "$WORK/copies/$OTHER" "$WORK/copies/renamed.dump"
run "$WORK/f4" scripts/backup/restore-db.sh --namespace optio-staging "$WORK/copies/renamed.dump" --yes
expect "restore-db <file> not named like a dump → status 2" "$(st "$WORK/f4")" 2
expect "…before any kubectl call" "$(wc -l <"$FAKE/calls" | tr -d ' ')" 0
run "$WORK/f5" scripts/backup/restore-db.sh --namespace optio-staging "$WORK/copies/optio-20261020T021501Z.dump" --yes
expect "restore-db <file> that isn't there → status 2" "$(st "$WORK/f5")" 2

scenario
run "$WORK/f6" scripts/backup/restore-db.sh --namespace optio-staging "$WORK/copies/$OTHER" --into-database optio_drill
expect "restore-db <file> --into-database: status" "$(st "$WORK/f6")" 0 || cat "$WORK/f6"
expect "restore-db <file> --into-database: upload, then the drill; the API not touched" \
  "$(order 'optio-backup.sh accept '"$OTHER" 'create job optio-staging-backup-drill-') $(calls 'scale ')" "yes 0"

# ── deploy-env.sh: the dump before the upgrade ──────────────────────────────
exit "$FAILED"
