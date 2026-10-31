-- How deep a code review goes (docs/merge-confirmation.md "Review depth"):
-- "thorough" (what every review did before) or "light" (the diff only, no test
-- command, half the turns). A repo's own depth, null = the workspace's; the
-- workspace's defaults to "thorough". Additive.
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "review_depth" text;
ALTER TABLE "optio_settings" ADD COLUMN IF NOT EXISTS "review_depth" text DEFAULT 'thorough' NOT NULL;
