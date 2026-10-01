-- Model providers (Amazon Bedrock for Claude Code and Codex), owned by the
-- organization (owner_user_id null) or by one person. Pod credentials are
-- stored encrypted on the row; machines use their own AWS profile.
CREATE TABLE IF NOT EXISTS "model_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid,
  "owner_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "kind" text DEFAULT 'bedrock' NOT NULL,
  "name" text NOT NULL,
  "agents" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "region" text NOT NULL,
  "models" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "local_aws_profile" text,
  "pod_credential" text DEFAULT 'none' NOT NULL,
  "encrypted_credentials" bytea,
  "credentials_iv" bytea,
  "credentials_auth_tag" bytea,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_providers_workspace_id_idx" ON "model_providers" ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_providers_owner_user_id_idx" ON "model_providers" ("owner_user_id");
--> statement-breakpoint
-- Who a piece of work belongs to (null = the organization) and the secrets
-- its pod gets (null = the workspace's legacy behavior).
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pod_secrets" jsonb;
--> statement-breakpoint
ALTER TABLE "task_configs" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "task_configs" ADD COLUMN IF NOT EXISTS "pod_secrets" jsonb;
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "pod_secrets" jsonb;
--> statement-breakpoint
ALTER TABLE "persistent_agents" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "persistent_agents" ADD COLUMN IF NOT EXISTS "pod_secrets" jsonb;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Sign-in by email domain joins the workspace; pods get only picked secrets.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "auto_join_domains" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "auto_join_role" "workspace_role" DEFAULT 'member' NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "restrict_pod_secrets" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- The machine's AWS profile names, as its daemon reported them.
ALTER TABLE "local_hosts" ADD COLUMN IF NOT EXISTS "aws_profiles" jsonb;
--> statement-breakpoint
-- When a person last typed into a session: the Machines rail orders by it
-- (then by creation), so sessions flipping between "needs you" and
-- "working" no longer reshuffle the list.
ALTER TABLE "local_terminals" ADD COLUMN IF NOT EXISTS "last_interacted_at" timestamp with time zone;
--> statement-breakpoint
-- The agent settings a person last used in the New work form (runtime and
-- per-runtime options), offered again next time.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "work_defaults" jsonb;
