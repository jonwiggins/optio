-- Workspaces people reach through their identity-provider groups, and
-- ticket providers a team (or a person) owns. Additive: nothing upstream is
-- renamed or dropped (docs/teams.md).

-- Groups (as the provider names them) whose members join this workspace on
-- sign-in — or find it under "Discoverable" and join it themselves — with
-- `access_groups_role` (never admin). Compared case-insensitively.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "access_groups" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "access_groups_role" workspace_role NOT NULL DEFAULT 'member';

-- Who sees whose work: 'organization' (everyone sees the organization's
-- work), 'teams' (a member sees their own, their teams' and what they
-- created; admins everything). NULL = the deployment's default
-- (OPTIO_WORK_VISIBILITY_DEFAULT).
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "work_visibility" text;

-- A ticket provider's workspace and owner (services/ownership.ts): both
-- owner columns null = the organization's; a team's keeps its creator in
-- owner_user_id. NULL workspace = a row from before this column, which
-- keeps syncing as the deployment's.
ALTER TABLE "ticket_providers" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "ticket_providers" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "ticket_providers" ADD COLUMN IF NOT EXISTS "owner_team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "ticket_providers_workspace_idx" ON "ticket_providers" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ticket_providers_owner_user_idx" ON "ticket_providers" ("owner_user_id");
CREATE INDEX IF NOT EXISTS "ticket_providers_owner_team_idx" ON "ticket_providers" ("owner_team_id");
