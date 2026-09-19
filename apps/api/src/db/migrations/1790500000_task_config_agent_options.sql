-- Per-run agent parameters on scheduled-Task blueprints (model, effort,
-- thinking, …), copied into each spawned task's metadata.agentOptions so the
-- New session form's Who parameters apply to every run. Null = repo defaults.
ALTER TABLE "task_configs" ADD COLUMN IF NOT EXISTS "agent_options" jsonb;
