-- The Jira round trip (docs/jira.md): what Optio wrote, or still has to
-- write, on the ticket a piece of work came from — a comment at start (a
-- link to the run), when the merge request opens, on merge and on failure or
-- "needs a person", the remote link `optio:<task id>`, a status move per the
-- provider's mapping — and the comments by people it took as follow-ups.
-- One row per event, keyed so an event is written once however often it is
-- announced or retried (`dedupe_key`); `done_steps` says which of its
-- comment / transition / link went through, so a retry repeats none of them.
-- `comment_id` is the Jira comment Optio posted: the follow-up poll never
-- reads those as instructions. Additive: one new table.
CREATE TABLE IF NOT EXISTS "ticket_writebacks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- "<task id>:started", "<task id>:mr_opened:<MR url>", "<task id>:follow_up:<comment id>",
  -- "skip:<provider id>:<ticket key>", …
  "dedupe_key" text NOT NULL,
  -- Null for a ticket no work came from (skipped: no repository matches it).
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE CASCADE,
  "provider_id" uuid REFERENCES "ticket_providers"("id") ON DELETE SET NULL,
  "ticket_source" text NOT NULL,
  "ticket_external_id" text NOT NULL,
  -- started | mr_opened | mr_updated | merged | failed | needs_attention |
  -- follow_up | follow_up_limit | skipped
  "event" text NOT NULL,
  -- pending | sending | done | failed | skipped
  "status" text NOT NULL DEFAULT 'pending',
  "done_steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "comment_id" text,
  -- A follow-up: the person's comment and who wrote it; whether Optio has answered it.
  "details" jsonb,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "claimed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ticket_writebacks_status_check"
    CHECK ("status" IN ('pending', 'sending', 'done', 'failed', 'skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "ticket_writebacks_dedupe_key" ON "ticket_writebacks" ("dedupe_key");
CREATE INDEX IF NOT EXISTS "ticket_writebacks_task_idx" ON "ticket_writebacks" ("task_id");
CREATE INDEX IF NOT EXISTS "ticket_writebacks_ticket_idx"
  ON "ticket_writebacks" ("ticket_source", "ticket_external_id");
-- The retry sweep: what isn't done yet.
CREATE INDEX IF NOT EXISTS "ticket_writebacks_open_idx"
  ON "ticket_writebacks" ("provider_id", "created_at")
  WHERE "status" IN ('pending', 'sending', 'failed');
