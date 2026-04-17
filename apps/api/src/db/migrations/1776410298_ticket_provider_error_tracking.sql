-- Track sync errors per ticket provider so failures surface in the UI
-- instead of only appearing in server logs.

ALTER TABLE "ticket_providers" ADD COLUMN "last_error" text;
ALTER TABLE "ticket_providers" ADD COLUMN "last_error_at" timestamptz;
ALTER TABLE "ticket_providers" ADD COLUMN "consecutive_failures" integer NOT NULL DEFAULT 0;
