-- Sign-in configured in the app for OpenID Connect and LDAP / Active
-- Directory, beside the Google, GitHub and GitLab sign-ins (see
-- docs/sign-in.md). Additive: a provider's settings that aren't a client id
-- and secret, and LDAP has no client id. Saved sign-in settings stay as they
-- are.
ALTER TABLE "auth_provider_configs" ADD COLUMN IF NOT EXISTS "settings" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "auth_provider_configs" ALTER COLUMN "client_id" SET DEFAULT '';

-- The organization's workspace, marked by the setup wizard's first sign-in;
-- a sign-in provider set to do so adds the people it signs in to it.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "organization" boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_one_organization_idx" ON "workspaces" ("organization") WHERE "organization" = true;

-- The groups the identity provider reported at the last sign-in (admin
-- groups, team membership).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sso_groups" jsonb NOT NULL DEFAULT '[]'::jsonb;
