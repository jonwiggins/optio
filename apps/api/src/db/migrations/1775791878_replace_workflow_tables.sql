-- Drop old workflow tables and references
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "workflow_run_id";
--> statement-breakpoint
DROP TABLE IF EXISTS "workflow_runs";
--> statement-breakpoint
DROP TABLE IF EXISTS "workflow_templates";
--> statement-breakpoint

-- Create new workflow enums
DO $$ BEGIN
  CREATE TYPE "public"."workflow_run_state" AS ENUM('queued', 'running', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."workflow_trigger_type" AS ENUM('manual', 'schedule', 'webhook');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."workflow_pod_state" AS ENUM('provisioning', 'ready', 'error', 'terminating');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Create workflows table
CREATE TABLE IF NOT EXISTS "workflows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "workspace_id" uuid,
  "environment_spec" jsonb,
  "prompt_template" text NOT NULL,
  "params_schema" jsonb,
  "agent_runtime" text DEFAULT 'claude-code' NOT NULL,
  "model" text,
  "max_turns" integer,
  "budget_usd" text,
  "max_concurrent" integer DEFAULT 1 NOT NULL,
  "max_retries" integer DEFAULT 3 NOT NULL,
  "warm_pool_size" integer DEFAULT 0 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_workspace_id_idx" ON "workflows" USING btree ("workspace_id");
--> statement-breakpoint

-- Create workflow_triggers table
CREATE TABLE IF NOT EXISTS "workflow_triggers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "type" "workflow_trigger_type" NOT NULL,
  "config" jsonb,
  "param_mapping" jsonb,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_triggers_workflow_id_idx" ON "workflow_triggers" USING btree ("workflow_id");
--> statement-breakpoint

-- Create workflow_runs table (new schema)
CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "trigger_id" uuid REFERENCES "workflow_triggers"("id"),
  "params" jsonb,
  "state" "workflow_run_state" DEFAULT 'queued' NOT NULL,
  "output" jsonb,
  "cost_usd" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "model_used" text,
  "error_message" text,
  "session_id" text,
  "pod_name" text,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_workflow_id_idx" ON "workflow_runs" USING btree ("workflow_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_state_idx" ON "workflow_runs" USING btree ("state");
--> statement-breakpoint

-- Create workflow_pods table
CREATE TABLE IF NOT EXISTS "workflow_pods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "pod_name" text,
  "state" "workflow_pod_state" DEFAULT 'provisioning' NOT NULL,
  "active_run_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_pods_workflow_id_idx" ON "workflow_pods" USING btree ("workflow_id");
