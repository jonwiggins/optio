-- Offboarding from the directory (docs/directory-sync.md): a disabled
-- account, the automations Optio paused for it, the directory sync's runs,
-- and which workspace memberships a directory group made. Additive: three
-- nullable columns on users, one on workspace_members, and two new tables.

-- A disabled account can't sign in, and its sessions, API keys and
-- WebSocket tokens stop working (services/session-service.ts,
-- api-key-service.ts check it). Null = enabled. The reason says who did it:
-- the directory sync ("gone", "disabled_in_directory",
-- "not_in_required_group", "domain_not_allowed") or a deployment admin by
-- hand ("admin", with disabled_by). The sync enables again only what it
-- disabled itself.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "disabled_at" timestamptz;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "disabled_reason" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "disabled_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;

-- What Optio paused when it disabled someone: their own scheduled and
-- triggered work definitions and persistent agents (owner_user_id = them,
-- no team), so an admin sees what to hand over, and so they come back on
-- when the person does. Open rows have resumed_at null; one per target.
CREATE TABLE IF NOT EXISTS "paused_automations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- "work_definition" | "persistent_agent"
  "target_type" text NOT NULL,
  "target_id" uuid NOT NULL,
  "workspace_id" uuid,
  "name" text NOT NULL,
  -- The definition's kind (repo-blueprint / standalone / local-blueprint) or "persistent-agent".
  "kind" text NOT NULL,
  "reason" text NOT NULL,
  "paused_at" timestamptz NOT NULL DEFAULT now(),
  "resumed_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "paused_automations_user_idx" ON "paused_automations" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "paused_automations_open_target_key"
  ON "paused_automations" ("target_type", "target_id") WHERE "resumed_at" IS NULL;

-- One row per directory sync run (scheduled or "Run now"): what it found,
-- for Settings → Access → Directory sync. The newest 50 are kept.
CREATE TABLE IF NOT EXISTS "directory_sync_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- "schedule" | "manual"
  "trigger" text NOT NULL,
  "started_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- "running" | "ok" | "held" (it would have disabled too many; nobody was) | "failed"
  "status" text NOT NULL DEFAULT 'running',
  "checked" integer NOT NULL DEFAULT 0,
  "changed" integer NOT NULL DEFAULT 0,
  "disabled" integer NOT NULL DEFAULT 0,
  "enabled" integer NOT NULL DEFAULT 0,
  "errors" integer NOT NULL DEFAULT 0,
  "error" text,
  -- Per person: { userId, email, outcome, reason? } (deployment admins only).
  "details" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "directory_sync_runs_started_idx" ON "directory_sync_runs" ("started_at");

-- True when a directory group (workspaces.access_groups) put the person in
-- the workspace (services/workspace-groups.ts); the directory sync takes
-- such a membership away once none of their groups opens the workspace.
-- Null: added by hand, or before this column — never taken away.
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "joined_via_groups" boolean;


ALTER TABLE "directory_sync_runs" ADD COLUMN "forced" boolean NOT NULL DEFAULT false;
