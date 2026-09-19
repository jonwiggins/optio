-- Run location: Tasks, their blueprints, and Jobs can run either in an Optio
-- pod ("cluster", the default) or on the owner's own machine ("local") via
-- the Optio Local daemon. Local runs are backed by a local_terminals row;
-- the pointers between the two are soft (no FKs) so neither table depends
-- on the other.

ALTER TABLE "tasks" ADD COLUMN "run_target" text DEFAULT 'cluster' NOT NULL;
ALTER TABLE "tasks" ADD COLUMN "local_host_id" uuid;
ALTER TABLE "tasks" ADD COLUMN "local_dir" text;
ALTER TABLE "tasks" ADD COLUMN "local_session_mode" text;
ALTER TABLE "tasks" ADD COLUMN "local_terminal_id" uuid;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_local_host_id_local_hosts_id_fk"
  FOREIGN KEY ("local_host_id") REFERENCES "public"."local_hosts"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "task_configs" ADD COLUMN "run_target" text DEFAULT 'cluster' NOT NULL;
ALTER TABLE "task_configs" ADD COLUMN "local_host_id" uuid;
ALTER TABLE "task_configs" ADD COLUMN "local_dir" text;
ALTER TABLE "task_configs" ADD COLUMN "local_session_mode" text;
ALTER TABLE "task_configs" ADD CONSTRAINT "task_configs_local_host_id_local_hosts_id_fk"
  FOREIGN KEY ("local_host_id") REFERENCES "public"."local_hosts"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "workflows" ADD COLUMN "run_target" text DEFAULT 'cluster' NOT NULL;
ALTER TABLE "workflows" ADD COLUMN "local_host_id" uuid;
ALTER TABLE "workflows" ADD COLUMN "local_dir" text;
ALTER TABLE "workflows" ADD COLUMN "local_session_mode" text DEFAULT 'headless' NOT NULL;
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_local_host_id_local_hosts_id_fk"
  FOREIGN KEY ("local_host_id") REFERENCES "public"."local_hosts"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "workflow_runs" ADD COLUMN "local_terminal_id" uuid;

ALTER TABLE "local_terminals" ADD COLUMN "workflow_run_id" uuid;
ALTER TABLE "local_terminals" ADD COLUMN "task_id" uuid;
CREATE INDEX IF NOT EXISTS "local_terminals_workflow_run_id_idx" ON "local_terminals" USING btree ("workflow_run_id");
CREATE INDEX IF NOT EXISTS "local_terminals_task_id_idx" ON "local_terminals" USING btree ("task_id");
