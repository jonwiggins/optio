-- Optio Local: agent subscription limits the daemon reads off the machine
-- (Codex rate-limit snapshots from its session logs), shown on the overview.

ALTER TABLE "local_hosts" ADD COLUMN "agent_limits" jsonb;
