-- Workspace-scoped configuration (docs/scope.md, "The deployment's own").
--
-- A configuration row with no workspace (`workspace_id IS NULL`) is the
-- deployment's. Until now every workspace read such rows: a legacy
-- connection, MCP server or skill appeared in every workspace's lists and
-- pods, and every workspace's runs fell back to the deployment's secrets and
-- agent settings. From now on the founding workspace (the oldest, which owns
-- the deployment's rows — services/founding-workspace.ts) still reads all of
-- them, and any other workspace reads only those a deployment admin shares
-- with every workspace: `deployment_default = true`.
--
-- The flag is set once, here, on every row that exists, so upgrading changes
-- nothing anyone sees or runs with; a deployment admin un-shares rows from
-- then on. New deployment rows start unshared.
--
-- Secrets also get a workspace-wide scope, `workspace`: a workspace's own
-- organization secret (an agent key, a GitLab token), read before the
-- deployment's. `global` stays the deployment's (no workspace, issue #509).
--
-- Ticket providers get a workspace: each existing one becomes the founding
-- workspace's, which is whose it already was (#735).

ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "deployment_default" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "deployment_default" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "deployment_default" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "custom_skills" ADD COLUMN IF NOT EXISTS "deployment_default" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "installed_skills" ADD COLUMN IF NOT EXISTS "deployment_default" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "optio_settings" ADD COLUMN IF NOT EXISTS "deployment_default" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Keep today's behaviour: every existing deployment row is shared. Private
-- secrets (scope 'user', and the legacy 'user:<id>' tokens) belong to a
-- person, never to the deployment, and are read by their owner alone.
UPDATE "secrets" SET "deployment_default" = true
WHERE "workspace_id" IS NULL AND "user_id" IS NULL
  AND "scope" <> 'user' AND "scope" NOT LIKE 'user:%';
--> statement-breakpoint
UPDATE "connections" SET "deployment_default" = true WHERE "workspace_id" IS NULL;
--> statement-breakpoint
UPDATE "mcp_servers" SET "deployment_default" = true WHERE "workspace_id" IS NULL;
--> statement-breakpoint
UPDATE "custom_skills" SET "deployment_default" = true WHERE "workspace_id" IS NULL;
--> statement-breakpoint
UPDATE "installed_skills" SET "deployment_default" = true WHERE "workspace_id" IS NULL;
--> statement-breakpoint
UPDATE "optio_settings" SET "deployment_default" = true WHERE "workspace_id" IS NULL;
--> statement-breakpoint

-- Only a deployment row can be a deployment default.
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_deployment_default_check"
  CHECK (NOT "deployment_default" OR ("workspace_id" IS NULL AND "user_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_deployment_default_check"
  CHECK (NOT "deployment_default" OR "workspace_id" IS NULL);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_deployment_default_check"
  CHECK (NOT "deployment_default" OR "workspace_id" IS NULL);
--> statement-breakpoint
ALTER TABLE "custom_skills" ADD CONSTRAINT "custom_skills_deployment_default_check"
  CHECK (NOT "deployment_default" OR "workspace_id" IS NULL);
--> statement-breakpoint
ALTER TABLE "installed_skills" ADD CONSTRAINT "installed_skills_deployment_default_check"
  CHECK (NOT "deployment_default" OR "workspace_id" IS NULL);
--> statement-breakpoint
ALTER TABLE "optio_settings" ADD CONSTRAINT "optio_settings_deployment_default_check"
  CHECK (NOT "deployment_default" OR "workspace_id" IS NULL);
--> statement-breakpoint

-- A workspace secret always has its workspace.
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_workspace_scope_check"
  CHECK ("scope" <> 'workspace' OR "workspace_id" IS NOT NULL);
--> statement-breakpoint

ALTER TABLE "ticket_providers" ADD COLUMN IF NOT EXISTS "workspace_id" uuid
  REFERENCES "workspaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
UPDATE "ticket_providers" SET "workspace_id" = (
  SELECT "id" FROM "workspaces" ORDER BY "created_at" ASC, "id" ASC LIMIT 1
) WHERE "workspace_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_providers_workspace_id_idx" ON "ticket_providers" ("workspace_id");
