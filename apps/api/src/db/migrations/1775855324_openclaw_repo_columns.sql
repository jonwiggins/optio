ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "openclaw_model" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "openclaw_agent" text;
