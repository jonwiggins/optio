-- Cursor agent support (issue #537): per-repo model selection for the
-- `cursor` agent type (Cursor CLI / cursor-agent). NULL = the Cursor
-- account's default model.

ALTER TABLE "repos" ADD COLUMN "cursor_model" text;
