-- Automatic merging needs a person to have said yes: the checkbox ticked AND
-- the confirmation dialog accepted. auto_merge alone no longer merges — the
-- reconciler also wants the matching confirmed_at (packages/shared/src/work/
-- auto-merge.ts). Additive: auto_merge keeps its meaning and nothing is
-- backfilled, so a row that had auto_merge on before this migration waits for
-- someone to confirm it again (docs/tasks.md).

-- The repo setting: when and by whom it was confirmed (cleared when it's off).
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "auto_merge_confirmed_at" timestamptz;
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "auto_merge_confirmed_by" uuid;

-- A run's own follow-through ("Works until merged" with merging on) and the
-- definitions that spawn runs carry the same stamp.
-- (The migrator remakes the run views around every migration, so
-- repo_tasks picks the column up: db/run-views.ts.)
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_merge_confirmed_at" timestamptz;
ALTER TABLE "work_definitions" ADD COLUMN IF NOT EXISTS "auto_merge_confirmed_at" timestamptz;
