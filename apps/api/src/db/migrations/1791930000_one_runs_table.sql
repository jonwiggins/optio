-- One runs table (docs/plans/work-unification.md, phase 3). Job runs
-- (workflow_runs) become rows of "tasks" with kind = 'standalone'; repo task
-- runs are kind = 'repo'. The table keeps its name, so migrations that alter
-- "tasks" keep working, and every table that points at a task (logs, events,
-- dependencies, PRs) can point at any run. Two views give the old shapes to
-- code about one kind (src/db/run-views.ts; the migrator remakes them around
-- every later migration):
--   repo_tasks     every repo run, every column
--   workflow_runs  every Job run, in its old shape
-- A Job run's columns map onto the task ones that mean the same thing
-- (workflow_id → work_id, finished_at → completed_at, pod_name →
-- container_id); only what has no equivalent is new. Its workspace and owner
-- come from its Job, so workspace-scoped run queries see it.
ALTER TABLE "tasks" ADD COLUMN "kind" text DEFAULT 'repo' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_check" CHECK ("kind" IN ('repo', 'standalone'));
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "trigger_id" uuid
  REFERENCES "workflow_triggers"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "params" jsonb;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "output" jsonb;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "pod_id" uuid;
--> statement-breakpoint
-- What only a repo run must have; a Job run takes its prompt and agent from
-- its Job when it runs, and is named by its Job unless its trigger names it.
ALTER TABLE "tasks" ALTER COLUMN "title" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "prompt" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "repo_url" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "agent_type" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repo_check" CHECK (
  "kind" <> 'repo' OR (
    "title" IS NOT NULL AND "prompt" IS NOT NULL AND "repo_url" IS NOT NULL AND "agent_type" IS NOT NULL
  )
);
--> statement-breakpoint
-- A Job run belongs to its Job (deleting the Job deletes its runs first).
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_standalone_check" CHECK (
  "kind" <> 'standalone' OR "work_id" IS NOT NULL
);
--> statement-breakpoint
INSERT INTO "tasks" (
  "id", "kind", "work_id", "trigger_id", "params", "title", "state", "output",
  "cost_usd", "input_tokens", "output_tokens", "model_used", "error_message", "session_id",
  "container_id", "pod_id", "last_pod_id", "local_terminal_id", "retry_count", "max_retries",
  "started_at", "completed_at", "control_intent", "reconcile_backoff_until", "reconcile_attempts",
  "workspace_id", "owner_user_id", "run_target", "created_at", "updated_at"
)
SELECT
  r."id", 'standalone', r."workflow_id", r."trigger_id", r."params", r."title",
  (CASE WHEN r."state" IN ('queued', 'running', 'completed', 'failed', 'cancelled')
    THEN r."state" ELSE 'failed' END)::"task_state",
  r."output", r."cost_usd", r."input_tokens", r."output_tokens", r."model_used",
  r."error_message", r."session_id", r."pod_name", r."pod_id", r."last_pod_id",
  r."local_terminal_id", r."retry_count", d."max_retries", r."started_at", r."finished_at",
  r."control_intent", r."reconcile_backoff_until", r."reconcile_attempts",
  d."workspace_id", d."owner_user_id", d."run_target", r."created_at", r."updated_at"
FROM "workflow_runs" r
JOIN "work_definitions" d ON d."id" = r."workflow_id";
--> statement-breakpoint
-- A Job run's log lines join every other run's, keyed by the run.
INSERT INTO "task_logs" ("id", "task_id", "stream", "content", "log_type", "metadata", "timestamp")
SELECT "id", "workflow_run_id", "stream", "content", "log_type", "metadata", "timestamp"
FROM "workflow_run_logs";
--> statement-breakpoint
DROP TABLE "workflow_run_logs";
--> statement-breakpoint
DROP TABLE "workflow_runs";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_kind_state_idx" ON "tasks" ("kind", "state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_pod_id_idx" ON "tasks" ("pod_id") WHERE "pod_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_trigger_id_idx" ON "tasks" ("trigger_id") WHERE "trigger_id" IS NOT NULL;
--> statement-breakpoint
CREATE VIEW "repo_tasks" AS
  SELECT * FROM "tasks" WHERE "kind" = 'repo'
  WITH CASCADED CHECK OPTION;
--> statement-breakpoint
CREATE VIEW "workflow_runs" AS
  SELECT "id", "kind", "work_id" AS "workflow_id", "trigger_id", "params", "title", "state",
    "output", "cost_usd", "input_tokens", "output_tokens", "model_used", "error_message",
    "session_id", "container_id" AS "pod_name", "pod_id", "last_pod_id", "local_terminal_id",
    "retry_count", "started_at", "completed_at" AS "finished_at", "control_intent",
    "reconcile_backoff_until", "reconcile_attempts", "workspace_id", "owner_user_id",
    "prompt", "agent_type", "last_activity_at", "created_at", "updated_at"
  FROM "tasks" WHERE "kind" = 'standalone'
  WITH CASCADED CHECK OPTION;
--> statement-breakpoint
ALTER VIEW "workflow_runs" ALTER COLUMN "kind" SET DEFAULT 'standalone';
--> statement-breakpoint
ALTER VIEW "workflow_runs" ALTER COLUMN "state" SET DEFAULT 'queued';
