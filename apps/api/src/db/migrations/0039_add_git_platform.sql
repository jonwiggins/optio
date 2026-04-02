-- Add git_platform column to repos table for multi-platform support (GitHub, GitLab)
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "git_platform" text NOT NULL DEFAULT 'github';

-- Backfill: repos with gitlab in the URL get 'gitlab' platform
UPDATE "repos" SET "git_platform" = 'gitlab' WHERE "repo_url" LIKE '%gitlab%' AND "git_platform" = 'github';
