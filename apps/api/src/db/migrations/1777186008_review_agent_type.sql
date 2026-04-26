-- Agent-aware review configuration.
--
-- Adds the ability to pick the review agent independently of the coding agent.
-- See `apps/api/src/services/review-config.ts` for the resolution order.
--
-- New columns:
--   repos.review_agent_type            -- per-repo override; NULL = inherit
--   optio_settings.default_review_agent_type
--   optio_settings.default_review_model
--
-- All NULL by default. Existing repos keep their current behaviour: when
-- review_agent_type is NULL the resolver falls through to repos.default_agent_type
-- (or claude-code), so reviews continue to run on Claude as they do today.

ALTER TABLE "repos"
  ADD COLUMN IF NOT EXISTS "review_agent_type" text;

ALTER TABLE "optio_settings"
  ADD COLUMN IF NOT EXISTS "default_review_agent_type" text;

ALTER TABLE "optio_settings"
  ADD COLUMN IF NOT EXISTS "default_review_model" text;
