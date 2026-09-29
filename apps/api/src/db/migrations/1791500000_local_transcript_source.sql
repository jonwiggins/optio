-- Where a transcript entry came from when it isn't simply the person or the
-- agent: the session's launch prompt, a background task reporting back,
-- another agent's message, a compaction summary, an interruption, a rollback.
-- Entries recorded before it have none (the API classifies them by text).
ALTER TABLE "local_terminal_transcripts" ADD COLUMN IF NOT EXISTS "source" text;
