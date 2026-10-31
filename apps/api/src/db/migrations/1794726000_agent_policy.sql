-- Agent policy (docs/agent-policy.md): the deny rules a workspace adds to
-- every agent run, and the rules a repo adds for work in it. One row per
-- level: repo_id null = the workspace's own row. A row stays once written
-- (an emptied policy is '{}'), so later runs still clear the managed
-- settings file an earlier run left in a shared pod. Additive: one new table.
CREATE TABLE IF NOT EXISTS "agent_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "repo_id" uuid REFERENCES "repos"("id") ON DELETE CASCADE,
  "policy" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_policies_workspace_key"
  ON "agent_policies" ("workspace_id") WHERE "repo_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_policies_repo_key"
  ON "agent_policies" ("repo_id") WHERE "repo_id" IS NOT NULL;
