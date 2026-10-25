-- Coder (docs/coder.md): Optio starts work in a Coder workspace, which pairs
-- itself with Optio as a machine. Additive: a connection table, the host
-- columns that say a machine is a Coder workspace Optio made, and the launch
-- a run (or a definition) was started with.

-- Where Optio reaches Coder. One for the organization (both owners null),
-- one per team, one per person. The session token is sealed on the row
-- (AES-256-GCM, AAD `coder_connection|<id>`) and never returned.
CREATE TABLE IF NOT EXISTS "coder_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid,
  "owner_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "owner_team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "encrypted_token" bytea,
  "token_iv" bytea,
  "token_auth_tag" bytea,
  "token_hint" text,
  "ca_pem" text,
  "insecure_skip_verify" boolean NOT NULL DEFAULT false,
  "organization_id" text,
  "template_id" text,
  "template_version_id" text,
  "template_name" text,
  "default_parameters" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "ttl_ms" bigint,
  "delete_when_done" boolean NOT NULL DEFAULT false,
  "last_tested_at" timestamptz,
  "last_error" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  -- A team row keeps its creator in owner_user_id (fails closed; docs/teams.md).
  CONSTRAINT "coder_connections_team_owner_check" CHECK ("owner_team_id" IS NULL OR "owner_user_id" IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS "coder_connections_workspace_id_idx" ON "coder_connections" ("workspace_id");
CREATE UNIQUE INDEX IF NOT EXISTS "coder_connections_org_key" ON "coder_connections" ("workspace_id") WHERE "owner_user_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "coder_connections_team_key" ON "coder_connections" ("workspace_id", "owner_team_id") WHERE "owner_team_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "coder_connections_user_key" ON "coder_connections" ("workspace_id", "owner_user_id") WHERE "owner_user_id" IS NOT NULL AND "owner_team_id" IS NULL;

-- A machine that is a Coder workspace: registered by Optio before the
-- workspace exists (its daemon claims the row by id), with the pairing
-- token Optio minted for it so it can be revoked when the work ends.
ALTER TABLE "local_hosts" ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'machine';
ALTER TABLE "local_hosts" ADD COLUMN IF NOT EXISTS "coder_workspace_id" text;
ALTER TABLE "local_hosts" ADD COLUMN IF NOT EXISTS "coder_connection_id" uuid REFERENCES "coder_connections"("id") ON DELETE SET NULL;
ALTER TABLE "local_hosts" ADD COLUMN IF NOT EXISTS "coder_workspace_name" text;
ALTER TABLE "local_hosts" ADD COLUMN IF NOT EXISTS "pairing_token_id" uuid REFERENCES "api_keys"("id") ON DELETE SET NULL;
ALTER TABLE "local_hosts" DROP CONSTRAINT IF EXISTS "local_hosts_origin_check";
ALTER TABLE "local_hosts" ADD CONSTRAINT "local_hosts_origin_check" CHECK ("origin" IN ('machine', 'coder'));
CREATE INDEX IF NOT EXISTS "local_hosts_coder_workspace_id_idx" ON "local_hosts" ("coder_workspace_id") WHERE "coder_workspace_id" IS NOT NULL;

-- What a run in a Coder workspace was started with (run_target stays
-- 'local'), so a re-run starts the same workspace or template again.
-- (The migrator remakes the run views around every migration, so
-- repo_tasks picks the column up: db/run-views.ts.)
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "coder_launch" jsonb;
ALTER TABLE "work_definitions" ADD COLUMN IF NOT EXISTS "coder_launch" jsonb;
