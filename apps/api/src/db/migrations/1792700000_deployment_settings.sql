-- Deployment-wide settings a deployment admin changes in the app (Settings →
-- Access), one row per key, over the deployment's environment default when
-- the key has no row. The first key is `workspaces.creation` ("admins" or
-- "everyone": who may create a workspace; env OPTIO_WORKSPACE_CREATION,
-- chart workspaces.creation). services/deployment-settings.ts. Additive.
CREATE TABLE IF NOT EXISTS "deployment_settings" (
  "key" text PRIMARY KEY,
  "value" jsonb NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
