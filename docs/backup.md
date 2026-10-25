# Backups and restores

Backups are optional (`backup.enabled=false` by default). The Helm chart can
schedule PostgreSQL custom-format dumps to a persistent volume or an S3
compatible store. The scripts in `scripts/backup/` also create dumps, copy
them off the cluster, restore them, and run restore drills through the same
CronJob. They use plain kubectl, with no deployment-directory dependency.

## Enable backups

```yaml
backup:
  enabled: true
  schedule: "0 2 * * *"
  keep: 14
  keepPreUpgrade: 5
  target: pvc
  pvc:
    size: 40Gi
    storageClass: ""
```

See `helm/optio/values.yaml` for S3 endpoint, bucket, credentials, prefix,
private CA, deadline and resource options. Mirror the S3 utility image for a
disconnected cluster. The chart uses the API's database URL and encryption key,
including `existingSecrets` references and the built-in database's TLS CA.

A dump includes work, settings, users, encrypted credentials and migration
history. It does not include repository PVCs, Redis, agent worktrees or external
services. Each completed dump has a SHA-256 sidecar; the job checks it with
`pg_restore --list` before keeping it. Partial dumps are discarded. Scheduled
and manual dumps have separate retention from pre-upgrade dumps. PVC creation
uses a retained hook so a Helm uninstall does not delete your backup data.
Keep a copy outside the cluster and test that it restores.

## Create and copy dumps

```bash
scripts/backup/backup-db.sh --namespace optio
scripts/backup/backup-db.sh --namespace optio --reason pre-upgrade --to /secure/backups
scripts/backup/backup-db.sh --namespace optio --download latest --to /secure/backups
scripts/backup/restore-db.sh --namespace optio --list
```

`--namespace` defaults to the selected kube context's namespace, then `default`.
`--release` defaults to the namespace; pass it when your Helm release has a
different name. `--kubeconfig` and `--context` select kubectl configuration;
`KUBECONFIG` works normally. Set `KUBECTL` to select an executable.

`--to` and `--download` work with PVC backups. A temporary copy job mounts the
volume, transfers bytes with kubectl exec, verifies checksums and exits. A
heartbeat keeps it alive during long copies. For S3 targets, copy dumps and
checksums with your S3 tools. Exit status 3 from backup-db means the namespace
has no backup CronJob; 1 means the backup or copy failed.

## Restore and drill

```bash
# Restore into a disposable database, verify the key, then remove that database:
scripts/backup/restore-db.sh --namespace optio latest --into-database optio_drill
# --keep retains the drill database for inspection.

# Replace the live database (asks for confirmation):
scripts/backup/restore-db.sh --namespace optio latest
# Or restore a copy transferred from another installation:
scripts/backup/restore-db.sh --namespace optio /secure/backups/optio-20261024T021500Z.dump
```

A live restore stops the API and records its replicas on the Deployment. When
the database account may create databases, the restore first builds a new
database, swaps names and keeps the previous one as `<db>_before_<time>`.
Otherwise it restores in one transaction. A failure starts the API on the
unchanged database. A successful restore starts it at the recorded replica
count, runs its migrations and verifies that the encryption key opens stored
credentials. `--yes` skips the confirmation for controlled automation.

If a restore times out or the operator stops the script while its job may
still be changing data, the API stays stopped. Follow the printed command:

```bash
scripts/backup/restore-db.sh --namespace optio --finish optio-backup-restore-1024101522
```

It waits for the existing job, then brings the API back and verifies the key.
Do not manually start the API while a restore job is still running. Use the
script's `--timeout` for slow restores. Drills only create and drop their own
database; a pre-existing database is refused.

Before restoring a pre-upgrade dump, roll the application back to a compatible
version using `helm rollback`, then restore the dump. For another cluster,
deploy with the original encryption key and backups enabled before restoring.
Never rotate the encryption key in place: losing it makes restored encrypted
credentials unreadable. Keep it separately from the database dumps, in your
normal secret backup process.

## Migration safety

New migrations should be additive. Do not edit previously shipped SQL: the
migration runner identifies it by hash. Before an upgrade or in a PR:

```bash
pnpm check:migrations --base origin/main
# Or inspect named SQL files:
pnpm check:migrations apps/api/src/db/migrations/<new-file>.sql
```

The checker compares existing migrations with the chosen git ref and rejects
edits and removals. For new files it flags dropped data, renames, type changes,
new NOT NULL columns without defaults and other unsafe operations. New tables,
nullable columns, defaulted columns and backfills are allowed. Dynamic SQL
requires manual review. A deliberate exception needs a reviewed
`-- optio:allow-destructive <reason>` comment explaining safety and operator
steps. Teams maintaining signed release inventories may use `--shipped` with
a sha256sum file instead; `--record` and `--verify-recorded` operate on that
explicit inventory. No release history list is maintained in this repository.

## Verification and troubleshooting

Watch `kubectl -n optio get cronjobs,jobs` and job logs. Check storage capacity,
PVC access modes, S3 connectivity, database permissions and the key if a job
fails. A missing or damaged checksum is refused; a failed dump is not promoted
to a completed backup. For an external backup system, use `pg_dump -Fc` and
retain the encryption key under the same policy.

The script tests need no cluster:
`bash scripts/backup/test-backup-scripts.sh`. The job's PostgreSQL test uses
throwaway databases and roles:
`sh scripts/backup/test-backup.sh --url <superuser-postgres-url>`.
