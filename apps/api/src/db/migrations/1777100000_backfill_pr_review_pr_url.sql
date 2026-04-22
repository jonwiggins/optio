-- Backfill: clear pr_url / pr_number on in-flight pr_review tasks.
--
-- The `tasks.pr_url` column means "the PR this task opened." External
-- pr_review tasks were mistakenly persisting the PR they were REVIEWING
-- into that column, which drove the reconciler's auto-merge path to
-- squash the external PR as soon as CI went green. The application layer
-- no longer writes pr_url / pr_number for pr_review rows; this migration
-- cleans up any in-flight rows that predate the fix.
--
-- Terminal rows (completed / cancelled / failed) keep their data for
-- audit. Per PR #480, the reconciler short-circuits on non-coding
-- taskTypes, so leaving terminal data in place is safe.

UPDATE tasks
   SET pr_url = NULL, pr_number = NULL
 WHERE task_type = 'pr_review'
   AND state NOT IN ('completed', 'cancelled', 'failed');
