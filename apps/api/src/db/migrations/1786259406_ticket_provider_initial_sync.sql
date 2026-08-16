-- Track whether a ticket provider has completed its first sync.
--
-- The first sweep after a provider is configured can match a backlog of
-- pre-existing tickets. Auto-queueing an agent for every one of them starts
-- work (and spends tokens) the user never initiated — see issue #579.
-- Backfilled tasks from the initial sync are now created in `pending` and
-- must be started explicitly; only tickets that match after this stamp is
-- set auto-queue.
--
-- Existing providers are stamped with their created_at so behavior does not
-- change for installs that already have providers syncing.

ALTER TABLE "ticket_providers" ADD COLUMN "initial_sync_at" timestamp with time zone;--> statement-breakpoint
UPDATE "ticket_providers" SET "initial_sync_at" = "created_at";
