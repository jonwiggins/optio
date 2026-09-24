-- The models an agent CLI on the machine offers (Codex's own catalog, read
-- by the Optio Local daemon), for the model and effort pickers.
ALTER TABLE "local_hosts" ADD COLUMN IF NOT EXISTS "agent_models" jsonb;
--> statement-breakpoint
-- Per-run agent parameters for Local automations (model, effort, Claude
-- Code's permission mode), keyed like the provider catalog.
ALTER TABLE "local_blueprints" ADD COLUMN IF NOT EXISTS "agent_options" jsonb;
