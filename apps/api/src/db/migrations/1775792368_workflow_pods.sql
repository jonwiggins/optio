-- Create the workflow_pod_state enum type
DO $$ BEGIN
  CREATE TYPE "workflow_pod_state" AS ENUM ('provisioning', 'ready', 'error', 'terminating');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Drop the old workflow_pods table (created in 1775791846 with different schema)
DROP TABLE IF EXISTS "workflow_pods" CASCADE;

-- Recreate workflow_pods with workflow_run_id FK, enum state, and additional columns
CREATE TABLE "workflow_pods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_run_id" uuid NOT NULL REFERENCES "workflow_runs"("id") ON DELETE CASCADE,
  "workspace_id" uuid,
  "pod_name" text,
  "pod_id" text,
  "state" "workflow_pod_state" DEFAULT 'provisioning' NOT NULL,
  "active_run_count" integer DEFAULT 0 NOT NULL,
  "last_run_at" timestamp with time zone,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "workflow_pods_run_id_idx" ON "workflow_pods" ("workflow_run_id");
CREATE INDEX IF NOT EXISTS "workflow_pods_workspace_id_idx" ON "workflow_pods" ("workspace_id");
