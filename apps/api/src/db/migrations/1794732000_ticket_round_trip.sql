-- Ticket providers owned by a workspace, a team or one person, and the
-- ticket round trip (docs/ticket-round-trip.md). Additive.
--
-- Owner (services/ownership.ts): both owner columns null = the workspace's
-- (the organization's); a team's keeps its creator in owner_user_id. A NULL
-- workspace is a row from before these columns: it stays the deployment's,
-- managed by a deployment admin and synced as before. A person's or a team's
-- provider goes when they do, so it never falls back to the organization.
ALTER TABLE "ticket_providers" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ticket_providers" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ticket_providers" ADD COLUMN IF NOT EXISTS "owner_team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ticket_providers" ADD CONSTRAINT "ticket_providers_team_owner_check" CHECK ("owner_team_id" IS NULL OR "owner_user_id" IS NOT NULL);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_providers_workspace_idx" ON "ticket_providers" ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_providers_owner_user_idx" ON "ticket_providers" ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_providers_owner_team_idx" ON "ticket_providers" ("owner_team_id");--> statement-breakpoint

-- What Optio wrote, or still has to write, on the ticket a piece of work
-- came from: one row per event, keyed so an event is written once however
-- often it is announced or retried (`dedupe_key`); `done_steps` says which
-- of its comment / status move / link went through, so a retry repeats none
-- of them. `comment_id` and `link_id` are Optio's own comments and links on
-- the ticket: the follow-up poll never reads them as instructions. Nothing
-- is written until a provider's round trip is switched on
-- (`config.roundTrip.enabled`, off by default).
CREATE TABLE IF NOT EXISTS "ticket_writebacks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- "<task id>:started", "<task id>:mr_opened:<MR url>", "<task id>:follow_up:<comment id>",
  -- "skip:<provider id>:<ticket key>", ...
  "dedupe_key" text NOT NULL,
  -- Null for a ticket no work came from (skipped: no repository matches it).
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE CASCADE,
  "provider_id" uuid REFERENCES "ticket_providers"("id") ON DELETE SET NULL,
  "ticket_source" text NOT NULL,
  "ticket_external_id" text NOT NULL,
  -- started | mr_opened | mr_updated | merged | failed | needs_attention |
  -- follow_up | follow_up_limit | skipped
  "event" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "done_steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "comment_id" text,
  "link_id" text,
  -- A follow-up: who wrote the comment and whether Optio has answered it.
  "details" jsonb,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "claimed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ticket_writebacks_status_check"
    CHECK ("status" IN ('pending', 'sending', 'done', 'failed', 'skipped'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_writebacks_dedupe_key" ON "ticket_writebacks" ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_writebacks_task_idx" ON "ticket_writebacks" ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_writebacks_ticket_idx" ON "ticket_writebacks" ("ticket_source", "ticket_external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_writebacks_open_idx" ON "ticket_writebacks" ("provider_id", "created_at") WHERE "status" IN ('pending', 'sending', 'failed');
