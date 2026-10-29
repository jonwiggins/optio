-- GitHub triggers gained twenty kinds (#687). A trigger saved with no `events`
-- filter meant "every kind" — the eleven there were. Pin those rows to the
-- kinds they listened for, so they don't start firing on every comment, edit,
-- push to a PR, close, branch and alert too. New triggers always say their kinds.
UPDATE "workflow_triggers"
SET "config" = COALESCE("config", '{}'::jsonb) || '{"events": ["review_requested", "mentioned", "assigned", "pr_opened", "issue_opened", "pr_merged", "labeled", "push", "release_published", "workflow_succeeded", "workflow_failed"]}'::jsonb
WHERE "type" = 'github'
  AND (
    "config" IS NULL
    OR "config"->'events' IS NULL
    OR jsonb_typeof("config"->'events') <> 'array'
    OR jsonb_array_length("config"->'events') = 0
  );
