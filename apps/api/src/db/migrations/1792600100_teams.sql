-- Teams: a third scope next to the organization and one person. A team's
-- members see and use what it owns; its admins change it. People create
-- teams and ask to join them; the identity provider's groups can fill them.
-- See docs/teams.md.

CREATE TABLE IF NOT EXISTS "teams" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  -- open: anyone in the workspace joins at once; request: a team admin
  -- approves; closed: members are added by hand (or by SSO groups).
  "join_policy" text NOT NULL DEFAULT 'request',
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "teams_workspace_name_key" ON "teams" ("workspace_id", lower("name"));
CREATE UNIQUE INDEX IF NOT EXISTS "teams_workspace_slug_key" ON "teams" ("workspace_id", "slug");

CREATE TABLE IF NOT EXISTS "team_members" (
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'member',
  -- active, or a join request waiting (requested) / turned down (denied).
  "status" text NOT NULL DEFAULT 'active',
  -- manual: added or approved in the app; sso: from a group mapping (kept in
  -- step with the groups the provider reports at each sign-in).
  "source" text NOT NULL DEFAULT 'manual',
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("team_id", "user_id"),
  CONSTRAINT "team_members_role_check" CHECK ("role" IN ('admin', 'member')),
  CONSTRAINT "team_members_status_check" CHECK ("status" IN ('active', 'requested', 'denied')),
  CONSTRAINT "team_members_source_check" CHECK ("source" IN ('manual', 'sso'))
);
CREATE INDEX IF NOT EXISTS "team_members_user_id_idx" ON "team_members" ("user_id");

CREATE TABLE IF NOT EXISTS "team_group_mappings" (
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "group_name" text NOT NULL,
  "role" text NOT NULL DEFAULT 'member',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "team_group_mappings_role_check" CHECK ("role" IN ('admin', 'member'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_group_mappings_key" ON "team_group_mappings" ("team_id", lower("group_name"));

-- A team-owned row keeps its creator in owner_user_id, so code that still
-- reads "owner_user_id set = private" treats it as the creator's: it fails
-- closed until it learns about teams.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "owner_team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_team_owner_check" CHECK ("owner_team_id" IS NULL OR "owner_user_id" IS NOT NULL);
ALTER TABLE "work_definitions" ADD COLUMN IF NOT EXISTS "owner_team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL;
ALTER TABLE "work_definitions" ADD CONSTRAINT "work_definitions_team_owner_check" CHECK ("owner_team_id" IS NULL OR "owner_user_id" IS NOT NULL);
ALTER TABLE "persistent_agents" ADD COLUMN IF NOT EXISTS "owner_team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL;
ALTER TABLE "persistent_agents" ADD CONSTRAINT "persistent_agents_team_owner_check" CHECK ("owner_team_id" IS NULL OR "owner_user_id" IS NOT NULL);
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "owner_team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE;
ALTER TABLE "connections" ADD CONSTRAINT "connections_team_owner_check" CHECK ("owner_team_id" IS NULL OR "owner_user_id" IS NOT NULL);
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "owner_team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE;
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_team_owner_check" CHECK ("owner_team_id" IS NULL OR "owner_user_id" IS NOT NULL);
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "owner_team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE;
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_team_owner_check" CHECK ("owner_team_id" IS NULL OR "owner_user_id" IS NOT NULL);
ALTER TABLE "custom_skills" ADD COLUMN IF NOT EXISTS "owner_team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE;
ALTER TABLE "custom_skills" ADD CONSTRAINT "custom_skills_team_owner_check" CHECK ("owner_team_id" IS NULL OR "owner_user_id" IS NOT NULL);
ALTER TABLE "installed_skills" ADD COLUMN IF NOT EXISTS "owner_team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE;
ALTER TABLE "installed_skills" ADD CONSTRAINT "installed_skills_team_owner_check" CHECK ("owner_team_id" IS NULL OR "owner_user_id" IS NOT NULL);
ALTER TABLE "prompt_templates" ADD COLUMN IF NOT EXISTS "owner_team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE;
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_team_owner_check" CHECK ("owner_team_id" IS NULL OR "owner_user_id" IS NOT NULL);
ALTER TABLE "trigger_occurrences" ADD COLUMN IF NOT EXISTS "owner_team_id" uuid;

-- (The migrator remakes the run views around every migration, so
-- repo_tasks / workflow_runs pick the column up: db/run-views.ts.)

-- Team secrets: scope 'team' with the team on the row.
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE;
ALTER TABLE "secrets" DROP CONSTRAINT IF EXISTS "secrets_user_scope_check";
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_user_scope_check" CHECK (
  ("scope" = 'user' AND "user_id" IS NOT NULL AND "team_id" IS NULL)
  OR ("scope" = 'team' AND "team_id" IS NOT NULL AND "user_id" IS NULL)
  OR ("scope" NOT IN ('user', 'team') AND "user_id" IS NULL AND "team_id" IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS "secrets_team_name_key" ON "secrets" ("team_id", "name") WHERE "scope" = 'team';
CREATE INDEX IF NOT EXISTS "secrets_team_id_idx" ON "secrets" ("team_id");
