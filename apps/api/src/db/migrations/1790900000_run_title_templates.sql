-- Run names from the trigger payload. `run_title` on a Job / Local automation
-- is a `{{param}}` template rendered each time a trigger fires ("Triage:
-- {{ticketTitle}}"); null = the definition's name. The rendered result lands on
-- the run (`workflow_runs.title`) or the spawned terminal's title. Scheduled
-- Tasks already render `task_configs.title` into the spawned task's title.
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "run_title" text;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "title" text;
--> statement-breakpoint
ALTER TABLE "local_blueprints" ADD COLUMN IF NOT EXISTS "run_title" text;
