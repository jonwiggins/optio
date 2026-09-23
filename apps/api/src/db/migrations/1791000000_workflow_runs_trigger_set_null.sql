-- A trigger's past runs outlive it. workflow_runs.trigger_id referenced
-- workflow_triggers with the default NO ACTION, so deleting a trigger that had
-- already started runs failed on the foreign key (the API answered 500). With
-- SET NULL the trigger goes and each run keeps its history, no longer naming
-- a trigger. No other table references workflow_triggers: the tasks a
-- scheduled Task spawns and Local terminals keep no FK to their trigger.
--
-- The inline REFERENCES in 1775791846 got Postgres's default name; re-add it
-- under drizzle's name (schema.ts), dropping either spelling first.
ALTER TABLE "workflow_runs" DROP CONSTRAINT IF EXISTS "workflow_runs_trigger_id_fkey";
--> statement-breakpoint
ALTER TABLE "workflow_runs" DROP CONSTRAINT IF EXISTS "workflow_runs_trigger_id_workflow_triggers_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_id_workflow_triggers_id_fk"
  FOREIGN KEY ("trigger_id") REFERENCES "workflow_triggers"("id") ON DELETE SET NULL;
