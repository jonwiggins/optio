-- The project webhook Optio registers on a GitLab repo (services/
-- repo-webhook-service.ts): the hook's id and URL on the platform, when it
-- was last brought up to date, and why the last attempt failed. Additive.

ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "webhook_id" text;
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "webhook_url" text;
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "webhook_synced_at" timestamptz;
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "webhook_error" text;
