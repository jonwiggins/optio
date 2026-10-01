-- What a piece of work changes about the environment its pod gives the agent
-- (packages/shared/src/work/settings.ts): connections, MCP servers, and skills
-- added or left out, setup commands, and a repo task's PR follow-through.
-- Null = the repo's and the workspace's defaults. A run keeps the settings it
-- started with (a scheduled Task copies its own into each task it spawns); a
-- Job run reads its Job's, like the rest of the Job.
ALTER TABLE "tasks" ADD COLUMN "settings" jsonb;
--> statement-breakpoint
ALTER TABLE "work_definitions" ADD COLUMN "settings" jsonb;
--> statement-breakpoint
ALTER TABLE "persistent_agents" ADD COLUMN "settings" jsonb;
--> statement-breakpoint
-- Repo-task lists read "kind = 'repo' newest first"; Job runs share the table.
CREATE INDEX IF NOT EXISTS "tasks_kind_created_at_idx" ON "tasks" ("kind", "created_at" DESC);
--> statement-breakpoint
-- Nothing writes task_logs.workflow_run_id any more (a Job run's lines are
-- keyed by task_id), so its index only costs writes.
DROP INDEX IF EXISTS "task_logs_workflow_run_id_idx";
