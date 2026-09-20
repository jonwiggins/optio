-- Per-run agent parameters (model, effort, thinking, approval mode, …) on
-- Jobs and Persistent Agents, keyed like the provider catalog, so the New
-- session form's Who parameters apply to every pod run — not only Repo Tasks.
-- Null = the runtime's defaults; the legacy `model` column still works.
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "agent_options" jsonb;
ALTER TABLE "persistent_agents" ADD COLUMN IF NOT EXISTS "agent_options" jsonb;
