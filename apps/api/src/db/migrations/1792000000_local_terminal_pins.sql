-- Pinned sessions: a terminal pinned to the top of every session list
-- (the rail, the Work list's terminal rows, the apps) until unpinned.
ALTER TABLE "local_terminals" ADD COLUMN "pinned_at" timestamp with time zone;
