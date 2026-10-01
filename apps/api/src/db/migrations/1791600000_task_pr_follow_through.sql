-- "Works until merged": a task (or a scheduled Task's spawned runs) can keep
-- working its PR — resume on failing CI, conflicts, and requested changes,
-- then merge — regardless of the repo's own settings. Null = the repo's
-- auto_resume / auto_merge apply, which is every row before this one.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_resume" boolean;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_merge" boolean;
ALTER TABLE "task_configs" ADD COLUMN IF NOT EXISTS "auto_resume" boolean;
ALTER TABLE "task_configs" ADD COLUMN IF NOT EXISTS "auto_merge" boolean;
