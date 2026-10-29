-- A resumed session keeps its original's spawn source; the lineage lives in
-- two soft pointers so lists can show the latest of a chain in its place.
ALTER TABLE "local_terminals" ADD COLUMN "resumed_from_terminal_id" uuid;
ALTER TABLE "local_terminals" ADD COLUMN "resumed_by_terminal_id" uuid;
CREATE INDEX IF NOT EXISTS "local_terminals_resumed_from_idx" ON "local_terminals" ("resumed_from_terminal_id");
