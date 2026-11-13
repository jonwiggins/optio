-- The GitLab servers a workspace signs in to with its own credentials
-- (Workspace Settings → GitLab). One row per (workspace, host); the token
-- itself is a `secrets` row (scope "workspace", name GITLAB_TOKEN_<HOST>,
-- bound to the workspace), so it is encrypted, AAD-bound and rotated like
-- every other secret. Rows go with their workspace.
CREATE TABLE IF NOT EXISTS "workspace_gitlab_servers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "host" text NOT NULL,
  "account_username" text,
  "account_name" text,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_gitlab_servers_workspace_host_key" UNIQUE ("workspace_id", "host")
);
CREATE INDEX IF NOT EXISTS "workspace_gitlab_servers_workspace_id_idx"
  ON "workspace_gitlab_servers" ("workspace_id");
