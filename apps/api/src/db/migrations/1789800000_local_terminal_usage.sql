-- Optio Local: token / cost totals the daemon sums from a Claude Code
-- session's transcript (agent spawns only), shown in the terminal header.

ALTER TABLE "local_terminals" ADD COLUMN "usage" jsonb;
