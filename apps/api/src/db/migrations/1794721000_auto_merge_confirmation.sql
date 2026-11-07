-- Optional confirmation before automatic merging (docs/merge-confirmation.md).
-- With OPTIO_MERGE_CONFIRMATION (or Settings → Access → Automatic merging) on,
-- turning auto_merge on needs the checkbox AND the confirmation dialog, and the
-- reconciler merges only a setting whose confirmed_at is set. With it off
-- (the default) nothing reads these columns and auto_merge alone decides, as
-- before. Additive and nullable; nothing is backfilled.

-- The repo setting: when and by whom it was confirmed (cleared when it's off).
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "auto_merge_confirmed_at" timestamptz;
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "auto_merge_confirmed_by" uuid;

-- A run's own follow-through ("Works until merged" with merging on) carries
-- the same stamp. (The migrator remakes the run views around every
-- migration, so repo_tasks picks the columns up: db/run-views.ts.)
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_merge_confirmed_at" timestamptz;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_merge_confirmed_by" uuid;

-- A definition that spawns runs (a scheduled Task, a trigger) keeps its stamp
-- beside it: one row while it merges by itself and a person confirmed it.
CREATE TABLE IF NOT EXISTS "work_auto_merge_confirmations" (
  "work_id" uuid PRIMARY KEY NOT NULL
    REFERENCES "work_definitions"("id") ON DELETE CASCADE,
  "confirmed_at" timestamptz NOT NULL,
  "confirmed_by" uuid
);
