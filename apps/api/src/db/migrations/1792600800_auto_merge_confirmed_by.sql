-- Who said yes to automatic merging, beyond repos: a run's own follow-through
-- and the definitions that spawn runs record the person who ticked the
-- checkbox and accepted the dialog, next to when (1792600500 added the time
-- here and both on repos). Additive and nullable: a row confirmed before this
-- migration, or by the config apply (the organization), names no one.
-- (The migrator remakes the run views around every migration, so repo_tasks
-- picks the column up: db/run-views.ts.)
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_merge_confirmed_by" uuid;
ALTER TABLE "work_definitions" ADD COLUMN IF NOT EXISTS "auto_merge_confirmed_by" uuid;
