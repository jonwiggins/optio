-- Add per-repo network egress policy for agent pod isolation
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "network_policy" text DEFAULT 'unrestricted' NOT NULL;
