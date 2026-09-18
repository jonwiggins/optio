-- Optio Local: PR / ticket links the daemon extracts from a terminal's output
-- (first-seen order, capped at 50). Lets the cockpit surface "which session is
-- working on PR #123" without storing the scrollback itself.

ALTER TABLE "local_terminals" ADD COLUMN "links" jsonb DEFAULT '[]'::jsonb NOT NULL;
