/**
 * The views over the one runs table (docs/plans/work-unification.md, phase
 * 3). `tasks` holds every run — a repo task (`kind = 'repo'`) or a Job run
 * (`kind = 'standalone'`) — and keeps its name, so migrations that alter
 * "tasks" keep working. Code that is about one kind reads and writes it
 * through a view:
 *
 *   repo_tasks     every repo run, every column (the schema's `tasks`)
 *   workflow_runs  every Job run, in the shape the Job code has always used
 *
 * Both are auto-updatable and WITH CHECK OPTION, so writes through them stay
 * in their kind; `workflow_runs` defaults `kind` for its inserts. A view's
 * column list is fixed when it is made, so the migrator drops them before
 * every migration and makes them again after (`migrate-safe.ts`): a new
 * `tasks` column shows up in `repo_tasks` without anyone remembering to. A
 * migration therefore sees `tasks` but not the views. The migrator also
 * remakes them at boot when this file's definition changed.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

const VIEWS = [
  `CREATE VIEW "repo_tasks" AS
     SELECT * FROM "tasks" WHERE "kind" = 'repo'
     WITH CASCADED CHECK OPTION`,
  `CREATE VIEW "workflow_runs" AS
     SELECT "id", "kind", "work_id" AS "workflow_id", "trigger_id", "params", "title", "state",
       "output", "cost_usd", "input_tokens", "output_tokens", "model_used", "error_message",
       "session_id", "container_id" AS "pod_name", "pod_id", "last_pod_id", "local_terminal_id",
       "retry_count", "recovery_required", "started_at", "completed_at" AS "finished_at", "control_intent",
       "reconcile_backoff_until", "reconcile_attempts", "workspace_id", "owner_user_id",
       "prompt", "agent_type", "run_target", "max_retries", "last_activity_at",
       "created_at", "updated_at"
     FROM "tasks" WHERE "kind" = 'standalone'
     WITH CASCADED CHECK OPTION`,
  `ALTER VIEW "workflow_runs" ALTER COLUMN "kind" SET DEFAULT 'standalone'`,
  `ALTER VIEW "workflow_runs" ALTER COLUMN "state" SET DEFAULT 'queued'`,
];

/**
 * Which definition of the views a database has, kept as a comment on
 * `workflow_runs`: the migrator remakes the views at boot when it differs,
 * so changing them here needs no migration.
 */
export const RUN_VIEWS_MARKER = `optio-run-views:${createHash("sha256")
  .update(VIEWS.join("\n"))
  .digest("hex")
  .slice(0, 16)}`;

export const RUN_VIEWS_SQL = [...VIEWS, `COMMENT ON VIEW "workflow_runs" IS '${RUN_VIEWS_MARKER}'`];

/** Whether the database's views are this code's (false when they're missing or older). */
export const RUN_VIEWS_CURRENT = sql`
  SELECT COALESCE(
    obj_description(to_regclass('workflow_runs'), 'pg_class') = ${RUN_VIEWS_MARKER},
    false
  ) AS "current"`;

/** The runs table has its views once `tasks.kind` exists (the phase 3 migration). */
export const HAS_RUN_KINDS = sql`
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'tasks' AND column_name = 'kind'
  ) AS "has"`;
