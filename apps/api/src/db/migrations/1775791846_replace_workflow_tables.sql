-- Drop old workflow tables (cascade removes FK references)
DROP TABLE IF EXISTS "workflow_runs" CASCADE;
DROP TABLE IF EXISTS "workflow_templates" CASCADE;

-- Create new workflows table
CREATE TABLE IF NOT EXISTS "workflows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "environment_spec" jsonb,
  "prompt_template" text NOT NULL,
  "params_schema" jsonb,
  "agent_runtime" text NOT NULL DEFAULT 'claude-code',
  "model" text,
  "max_turns" integer,
  "budget_usd" text,
  "max_concurrent" integer NOT NULL DEFAULT 2,
  "max_retries" integer NOT NULL DEFAULT 1,
  "warm_pool_size" integer NOT NULL DEFAULT 0,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "workflows_workspace_name_key" ON "workflows" ("workspace_id", "name");
CREATE INDEX IF NOT EXISTS "workflows_workspace_id_idx" ON "workflows" ("workspace_id");

-- Create workflow_triggers table
CREATE TABLE IF NOT EXISTS "workflow_triggers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "config" jsonb,
  "param_mapping" jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "workflow_triggers_workflow_id_idx" ON "workflow_triggers" ("workflow_id");

-- Create new workflow_runs table (replaces old one)
CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "trigger_id" uuid REFERENCES "workflow_triggers"("id"),
  "params" jsonb,
  "state" text NOT NULL DEFAULT 'queued',
  "output" jsonb,
  "cost_usd" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "model_used" text,
  "error_message" text,
  "session_id" text,
  "pod_name" text,
  "retry_count" integer NOT NULL DEFAULT 0,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "workflow_runs_workflow_id_idx" ON "workflow_runs" ("workflow_id");
CREATE INDEX IF NOT EXISTS "workflow_runs_trigger_id_idx" ON "workflow_runs" ("trigger_id");
CREATE INDEX IF NOT EXISTS "workflow_runs_state_idx" ON "workflow_runs" ("state");

-- Create workflow_pods table
CREATE TABLE IF NOT EXISTS "workflow_pods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "pod_name" text NOT NULL,
  "state" text NOT NULL DEFAULT 'creating',
  "active_run_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "workflow_pods_workflow_id_idx" ON "workflow_pods" ("workflow_id");
