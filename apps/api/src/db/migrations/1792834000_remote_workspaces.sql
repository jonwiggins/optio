-- Remote workspaces (docs/remote-workspaces.md): work runs in a workspace a
-- provider hosts — Coder, GitHub Codespaces, Daytona or E2B — which pairs
-- itself with Optio as a machine. The connection table and the columns that
-- point at a provider's workspace get provider-neutral names, and a
-- connection says which provider it is for. Renames, one new column whose
-- default keeps what the existing rows are (all made for Coder), and the
-- checks and keys that now include the provider: a database that ran the
-- earlier migrations upgrades in place.

-- The connections: one per provider for the organization, per team and per
-- person (the session token or API key stays sealed under the AAD it was
-- sealed with, `coder_connection|<id>`).
DO $$
BEGIN
  IF to_regclass('coder_connections') IS NOT NULL
     AND to_regclass('remote_workspace_connections') IS NULL THEN
    ALTER TABLE "coder_connections" RENAME TO "remote_workspace_connections";
  END IF;
END $$;

ALTER TABLE "remote_workspace_connections" ADD COLUMN IF NOT EXISTS "provider" text NOT NULL DEFAULT 'coder';
-- New rows name their provider.
ALTER TABLE "remote_workspace_connections" ALTER COLUMN "provider" DROP DEFAULT;
ALTER TABLE "remote_workspace_connections" DROP CONSTRAINT IF EXISTS "remote_workspace_connections_provider_check";
ALTER TABLE "remote_workspace_connections" ADD CONSTRAINT "remote_workspace_connections_provider_check"
  CHECK ("provider" IN ('coder', 'codespaces', 'daytona', 'e2b'));

-- The table's own constraints (its key, the team-owner check, the foreign
-- keys) and index follow its name.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'remote_workspace_connections'::regclass
      AND conname LIKE 'coder\_connections\_%'
  LOOP
    EXECUTE format(
      'ALTER TABLE "remote_workspace_connections" RENAME CONSTRAINT %I TO %I',
      c.conname,
      'remote_workspace_connections_' || substr(c.conname, length('coder_connections_') + 1)
    );
  END LOOP;
END $$;
ALTER INDEX IF EXISTS "coder_connections_workspace_id_idx" RENAME TO "remote_workspace_connections_workspace_id_idx";

-- One connection per scope per provider (it was one per scope).
DROP INDEX IF EXISTS "coder_connections_org_key";
DROP INDEX IF EXISTS "coder_connections_team_key";
DROP INDEX IF EXISTS "coder_connections_user_key";
CREATE UNIQUE INDEX IF NOT EXISTS "remote_workspace_connections_org_key"
  ON "remote_workspace_connections" ("workspace_id", "provider") WHERE "owner_user_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "remote_workspace_connections_team_key"
  ON "remote_workspace_connections" ("workspace_id", "provider", "owner_team_id") WHERE "owner_team_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "remote_workspace_connections_user_key"
  ON "remote_workspace_connections" ("workspace_id", "provider", "owner_user_id")
  WHERE "owner_user_id" IS NOT NULL AND "owner_team_id" IS NULL;

-- A machine that is a remote workspace: `origin` names its provider (the
-- rows there already say "coder"), and the workspace's id, name and
-- connection lose the provider in their names.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'local_hosts'
               AND column_name = 'coder_workspace_id') THEN
    ALTER TABLE "local_hosts" RENAME COLUMN "coder_workspace_id" TO "remote_workspace_id";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'local_hosts'
               AND column_name = 'coder_workspace_name') THEN
    ALTER TABLE "local_hosts" RENAME COLUMN "coder_workspace_name" TO "remote_workspace_name";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'local_hosts'
               AND column_name = 'coder_connection_id') THEN
    ALTER TABLE "local_hosts" RENAME COLUMN "coder_connection_id" TO "remote_workspace_connection_id";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'local_hosts'::regclass
               AND conname = 'local_hosts_coder_connection_id_fkey') THEN
    ALTER TABLE "local_hosts" RENAME CONSTRAINT "local_hosts_coder_connection_id_fkey"
      TO "local_hosts_remote_workspace_connection_id_fkey";
  END IF;
END $$;
ALTER INDEX IF EXISTS "local_hosts_coder_workspace_id_idx" RENAME TO "local_hosts_remote_workspace_id_idx";
ALTER TABLE "local_hosts" DROP CONSTRAINT IF EXISTS "local_hosts_origin_check";
ALTER TABLE "local_hosts" ADD CONSTRAINT "local_hosts_origin_check"
  CHECK ("origin" IN ('machine', 'coder', 'codespaces', 'daytona', 'e2b'));

-- What a run (or a definition) in a remote workspace was started with. (The
-- migrator remakes the run views around every migration: db/run-views.ts.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'tasks'
               AND column_name = 'coder_launch') THEN
    ALTER TABLE "tasks" RENAME COLUMN "coder_launch" TO "remote_workspace_launch";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'work_definitions'
               AND column_name = 'coder_launch') THEN
    ALTER TABLE "work_definitions" RENAME COLUMN "coder_launch" TO "remote_workspace_launch";
  END IF;
END $$;

-- Credential health keeps one row per connection: the connections it
-- already checked keep their history under the new kind and key.
UPDATE "credential_checks"
SET "kind" = 'remote_workspace',
    "credential_key" = 'remote_workspace:' || substr("credential_key", length('coder:') + 1)
WHERE "kind" = 'coder' AND "credential_key" LIKE 'coder:%';
