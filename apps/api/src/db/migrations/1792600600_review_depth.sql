-- How deep a code review goes (review-service.ts, pr-review-service.ts):
-- "thorough" reads the code around the diff and runs the test command,
-- "light" reads the diff only and reports the top findings in fewer turns.
-- A repo's own depth (null = the workspace's), and the workspace's review
-- defaults that the Settings "Code review" card saves: when a review starts,
-- how deep it goes, and the test command for repos without one. Additive.

-- No column default: null is "the workspace's", read when the review starts, so
-- existing repos and repos made by API or config follow Settings → Code review.
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "review_depth" text;
-- (A database that ran an earlier draft of this file with a default drops it.)
ALTER TABLE "repos" ALTER COLUMN "review_depth" DROP DEFAULT;
ALTER TABLE "optio_settings" ADD COLUMN IF NOT EXISTS "review_trigger" text DEFAULT 'on_ci_pass' NOT NULL;
ALTER TABLE "optio_settings" ADD COLUMN IF NOT EXISTS "review_depth" text DEFAULT 'thorough' NOT NULL;
ALTER TABLE "optio_settings" ADD COLUMN IF NOT EXISTS "review_test_command" text;
