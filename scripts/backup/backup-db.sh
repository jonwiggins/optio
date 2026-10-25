#!/usr/bin/env bash
# A dump of an environment's database now, by its backup CronJob (the chart's
# backup.*; docs/backup.md): what backup-db.sh --reason pre-upgrade runs
# before every upgrade, and what you run by hand before anything risky.
#
#   scripts/backup/backup-db.sh --namespace <name> [options]
#   scripts/backup/backup-db.sh --namespace <namespace> [options]
#
#   --namespace <name>     default: the selected kube context namespace, else default
#   --release <name>       the Helm release (default: the namespace)
#   --reason <why>         manual (default; optio-<time>-manual.dump) or
#                          pre-upgrade (optio-<time>-pre-upgrade.dump, kept
#                          apart: backup.keepPreUpgrade)
#   --kubeconfig <file>    default: kubectl configuration ($KUBECONFIG)
#   --context <name>       default: the current kube context
#   --timeout <seconds>    how long to wait for the dump (default 3600)
#   --to <dir>             also copy the dump and its .sha256 to <dir> on this
#                          machine (off the cluster: keep it with the key)
#   --download <dump>      take no dump: copy this one (a name, latest or
#                          latest-pre-upgrade) to --to <dir> (default: here)
#
# The dump is checked in the job (pg_restore reads it back) before it is kept;
# a copy is compared with its .sha256. --to and --download work with the
# volume (backup.target: pvc); a bucket's dumps are copied with the deployment's S3
# tools. restore-db.sh restores a copied file (into this or another
# environment) when given its path.
# Prints the job's log, then the dump's name and the command that restores it;
# the last line is OPTIO_BACKUP_DUMP=<name>.
#
# Exit status: 0 the dump is kept (and copied); 3 the namespace has no backup
# CronJob (backup.enabled is off, or nothing is deployed there yet); 1 the
# dump or the copy failed.
#
# Tools: $KUBECTL, else the kit's ($OPTIO_KIT_DIR/offline/bin), else PATH.
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

NAMESPACE=""
RELEASE=""
REASON=manual
KUBECONFIG_FILE=""
CONTEXT=""
TIMEOUT=3600
TO=""
DOWNLOAD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --namespace) NAMESPACE="${2:?--namespace needs a name}"; shift ;;
    --release) RELEASE="${2:?--release needs a name}"; shift ;;
    --reason) REASON="${2:?--reason needs manual or pre-upgrade}"; shift ;;
    --kubeconfig) KUBECONFIG_FILE="${2:?--kubeconfig needs a file}"; shift ;;
    --context) CONTEXT="${2:?--context needs a name}"; shift ;;
    --timeout) TIMEOUT="${2:?--timeout needs seconds}"; shift ;;
    --to) TO="${2:?--to needs a directory}"; shift ;;
    --download) DOWNLOAD="${2:?--download needs a dump (a name, latest or latest-pre-upgrade)}"; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) echo "Unexpected argument: $1 (use --namespace)" >&2; exit 2 ;;
  esac
  shift
done
case "$REASON" in manual) KIND=now ;; pre-upgrade) KIND=pre ;; *) echo "--reason is manual or pre-upgrade (got $REASON)" >&2; exit 2 ;; esac
case "$TIMEOUT" in '' | *[!0-9]*) echo "--timeout takes seconds" >&2; exit 2 ;; esac
if [ -n "$DOWNLOAD" ]; then
  case "$DOWNLOAD" in
    latest | latest-pre-upgrade) ;;
    *) [[ "$DOWNLOAD" =~ ^optio-[0-9]{8}T[0-9]{6}Z(-[a-z]+(-[a-z]+)*)?\.dump$ ]] || { echo "Not a dump's name: $DOWNLOAD (optio-<time>[-<kind>].dump, latest or latest-pre-upgrade)" >&2; exit 2; } ;;
  esac
  TO="${TO:-.}"
fi
if [ -n "$TO" ] && [ -e "$TO" ] && [ ! -d "$TO" ]; then echo "--to names a file, not a directory: $TO" >&2; exit 2; fi

# shellcheck source=backup-lib.sh
. "$(dirname "$0")/backup-lib.sh"
WORK="$(mktemp -d)"
chmod 700 "$WORK"
trap 'backup_cleanup; rm -rf "$WORK"' EXIT

backup_kube
backup_env
TARGET="--namespace $NAMESPACE"
if [ "$RELEASE" != "$NAMESPACE" ]; then TARGET+=" --release $RELEASE"; fi

if ! backup_cronjob; then
  echo "No backup CronJob $CRONJOB in $NAMESPACE: backups are off there (backup.enabled; docs/backup.md), or nothing is deployed yet." >&2
  exit 3
fi
if [ -n "$TO" ] && [ "$(backup_target)" != pvc ]; then
  echo "$NAMESPACE's dumps go to an S3 bucket (backup.target: s3): copy them with your S3 tools (aws s3 cp); --to and --download copy from the volume." >&2
  exit 2
fi

# copy_out <dump>: the dump to $TO through a copy job
copy_out() {
  backup_hold 600 || backup_die "couldn't reach the backup volume for the copy"
  backup_download "$1" "$TO"
  backup_release
  echo "Copied: $DOWNLOADED ($(wc -c <"$DOWNLOADED" | tr -d ' ') bytes)$([ -f "$DOWNLOADED.sha256" ] && echo ", and its .sha256")"
}

if [ -n "$DOWNLOAD" ]; then
  copy_out "$DOWNLOAD"
  DUMP="$(basename "$DOWNLOADED")"
  echo "Restore it: scripts/backup/restore-db.sh $TARGET $DUMP (or the file, into another environment: restore-db.sh --namespace <name> $DOWNLOADED)"
  echo "OPTIO_BACKUP_DUMP=$DUMP"
  exit 0
fi

echo "A $REASON dump of $NAMESPACE's database (CronJob $CRONJOB)"
backup_job "$KIND"
if ! backup_wait "$JOB" "$TIMEOUT"; then
  echo "No dump was kept. The job's pods: kubectl -n $NAMESPACE get pods -l batch.kubernetes.io/job-name=$JOB" >&2
  exit 1
fi
DUMP="$(backup_value OPTIO_BACKUP_DUMP)"
[ -n "$DUMP" ] || backup_die "the job finished without naming its dump (an older chart's script?)"
echo
echo "Dump: $DUMP ($(backup_value OPTIO_BACKUP_SIZE) bytes) at $(backup_value OPTIO_BACKUP_LOCATION)"
echo "Restore it: scripts/backup/restore-db.sh $TARGET $DUMP"
if [ -n "$TO" ]; then copy_out "$DUMP"; fi
echo "OPTIO_BACKUP_DUMP=$DUMP"
