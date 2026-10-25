-- Agent policy (docs/agent-policy.md): Claude Code deny rules written into
-- the managed settings tier of every agent pod (OpenCode gets the same
-- rules), and the RuntimeClass a repo's pods run under. A policy per
-- workspace, with rules added per team and per repo, each a jsonb column
-- (null = nothing set at that level; packages/shared agent-policy.ts):
--   workspaces: { "defaults": bool, "denyRules": [rule, …] }
--   teams:      { "denyRules": [rule, …] }
--   repos:      { "denyRules": [rule, …], "runtimeClassName": "gvisor" }
-- And what a run got, for its page. Additive: three nullable columns and one
-- new table.

ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "agent_policy" jsonb;
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "agent_policy" jsonb;
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "agent_policy" jsonb;

-- The policy a run (a Repo Task or a Job run, a row of "tasks") started
-- with: the rules and where each came from, the RuntimeClass, the agent
-- runtime and the file Optio wrote. Kept per attempt (the newest wins), gone
-- with the run.
CREATE TABLE IF NOT EXISTS "run_agent_policies" (
  "run_id" uuid PRIMARY KEY REFERENCES "tasks"("id") ON DELETE CASCADE,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "policy" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
