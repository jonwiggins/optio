-- Provider-qualified sign-in groups and the origin of deployment-admin grants.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sso_groups" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deployment_admin_sources" jsonb;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "access_groups" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "access_groups_role" workspace_role NOT NULL DEFAULT 'member';
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "joined_via_groups" boolean;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "organization" boolean NOT NULL DEFAULT false;
