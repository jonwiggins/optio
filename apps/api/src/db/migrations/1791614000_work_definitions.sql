-- One definitions table (docs/plans/work-unification.md, phase 2). Scheduled
-- Tasks (task_configs), Jobs (workflows), and Local automations
-- (local_blueprints) become rows of work_definitions, told apart by `kind` —
-- the names the API already uses for them:
--   repo-blueprint   each firing spawns a repo task          (was task_configs)
--   standalone       each firing starts a Job run            (was workflows)
--   local-blueprint  each firing opens a terminal on a machine (was local_blueprints)
-- Ids are kept, so triggers (workflow_triggers.target_id), Job runs, spawned
-- tasks, and spawned terminals still point at their definition.
--
-- Columns are the five attributes of work under one name each: the prompt
-- (task_configs.prompt / workflows.prompt_template / local_blueprints.command_template),
-- the agent (agent_type / agent_runtime / agent), the base branch
-- (repo_branch / — / base_branch), and the run location (run_target +
-- local_host_id / local_dir / local_session_mode, a Local automation's
-- host_id / dir / session_mode). A scheduled Task's `title` is its run title.
CREATE TABLE "work_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "workspace_id" uuid,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users"("id"),
  "enabled" boolean DEFAULT true NOT NULL,
  "prompt" text NOT NULL,
  "prompt_template_id" uuid REFERENCES "prompt_templates"("id") ON DELETE SET NULL,
  "run_title" text,
  "params_schema" jsonb,
  "agent_type" text,
  "model" text,
  "agent_options" jsonb,
  "repo_url" text,
  "repo_branch" text,
  "run_target" text DEFAULT 'cluster' NOT NULL,
  "local_host_id" uuid REFERENCES "local_hosts"("id") ON DELETE SET NULL,
  "local_dir" text,
  "local_session_mode" text,
  "environment_spec" jsonb,
  "spawn_mode" text DEFAULT 'auto' NOT NULL,
  "max_retries" integer DEFAULT 1 NOT NULL,
  "priority" integer DEFAULT 100 NOT NULL,
  "auto_resume" boolean,
  "auto_merge" boolean,
  "max_turns" integer,
  "budget_usd" text,
  "max_concurrent" integer DEFAULT 2 NOT NULL,
  "warm_pool_size" integer DEFAULT 0 NOT NULL,
  "max_pod_instances" integer DEFAULT 1 NOT NULL,
  "max_agents_per_pod" integer DEFAULT 2 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "work_definitions_kind_check"
    CHECK ("kind" IN ('repo-blueprint', 'standalone', 'local-blueprint')),
  CONSTRAINT "work_definitions_repo_check"
    CHECK ("kind" <> 'repo-blueprint' OR "repo_url" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO "work_definitions" (
  "id", "kind", "name", "description", "workspace_id", "created_by", "enabled",
  "prompt", "prompt_template_id", "run_title", "agent_type", "agent_options",
  "repo_url", "repo_branch", "run_target", "local_host_id", "local_dir", "local_session_mode",
  "max_retries", "priority", "auto_resume", "auto_merge", "created_at", "updated_at"
)
SELECT
  "id", 'repo-blueprint', "name", "description", "workspace_id", "created_by", "enabled",
  "prompt", "prompt_template_id", "title", "agent_type", "agent_options",
  "repo_url", "repo_branch", "run_target", "local_host_id", "local_dir", "local_session_mode",
  "max_retries", "priority", "auto_resume", "auto_merge", "created_at", "updated_at"
FROM "task_configs";
--> statement-breakpoint
INSERT INTO "work_definitions" (
  "id", "kind", "name", "description", "workspace_id", "created_by", "enabled",
  "prompt", "run_title", "params_schema", "agent_type", "model", "agent_options",
  "run_target", "local_host_id", "local_dir", "local_session_mode", "environment_spec",
  "max_retries", "max_turns", "budget_usd", "max_concurrent", "warm_pool_size",
  "max_pod_instances", "max_agents_per_pod", "created_at", "updated_at"
)
SELECT
  "id", 'standalone', "name", "description", "workspace_id", "created_by", "enabled",
  "prompt_template", "run_title", "params_schema", "agent_runtime", "model", "agent_options",
  "run_target", "local_host_id", "local_dir", "local_session_mode", "environment_spec",
  "max_retries", "max_turns", "budget_usd", "max_concurrent", "warm_pool_size",
  "max_pod_instances", "max_agents_per_pod", "created_at", "updated_at"
FROM "workflows";
--> statement-breakpoint
INSERT INTO "work_definitions" (
  "id", "kind", "name", "description", "workspace_id", "user_id", "enabled",
  "prompt", "prompt_template_id", "run_title", "agent_type", "agent_options",
  "repo_url", "repo_branch", "run_target", "local_host_id", "local_dir", "local_session_mode",
  "spawn_mode", "created_at", "updated_at"
)
SELECT
  "id", 'local-blueprint', "name", "description", "workspace_id", "user_id", "enabled",
  "command_template", "prompt_template_id", "run_title", "agent", "agent_options",
  "repo_url", "base_branch", 'local', "host_id", "dir", "session_mode",
  "spawn_mode", "created_at", "updated_at"
FROM "local_blueprints";
--> statement-breakpoint
-- Name uniqueness stays what it was: scheduled Tasks and Jobs per workspace
-- (each kind its own namespace), Local automations per person.
CREATE UNIQUE INDEX "work_definitions_workspace_name_key"
  ON "work_definitions" ("kind", "workspace_id", "name") WHERE "kind" <> 'local-blueprint';
--> statement-breakpoint
CREATE UNIQUE INDEX "work_definitions_user_name_key"
  ON "work_definitions" ("user_id", "name") WHERE "kind" = 'local-blueprint';
--> statement-breakpoint
CREATE INDEX "work_definitions_workspace_id_idx" ON "work_definitions" ("workspace_id");
--> statement-breakpoint
-- A Job's runs and its triggers' legacy workflow_id go with the Job, as before.
ALTER TABLE "workflow_runs" DROP CONSTRAINT IF EXISTS "workflow_runs_workflow_id_fkey";
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_fkey"
  FOREIGN KEY ("workflow_id") REFERENCES "work_definitions"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "workflow_triggers" DROP CONSTRAINT IF EXISTS "workflow_triggers_workflow_id_fkey";
--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_workflow_id_fkey"
  FOREIGN KEY ("workflow_id") REFERENCES "work_definitions"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- The definition a task was spawned from (was only metadata.taskConfigId,
-- which stays for clients). Deleting the definition keeps its tasks.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "work_id" uuid
  REFERENCES "work_definitions"("id") ON DELETE SET NULL;
--> statement-breakpoint
UPDATE "tasks" t SET "work_id" = d."id"
FROM "work_definitions" d
WHERE d."kind" = 'repo-blueprint' AND t."metadata"->>'taskConfigId' = d."id"::text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_work_id_idx" ON "tasks" ("work_id") WHERE "work_id" IS NOT NULL;
--> statement-breakpoint
DROP TABLE "task_configs";
--> statement-breakpoint
DROP TABLE "workflows";
--> statement-breakpoint
DROP TABLE "local_blueprints";
