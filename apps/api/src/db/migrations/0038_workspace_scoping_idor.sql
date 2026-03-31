-- Add workspace_id columns to tables missing workspace scoping (IDOR fix)
ALTER TABLE "interactive_sessions" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "task_templates" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "prompt_templates" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

-- Add indexes for workspace-scoped queries
CREATE INDEX IF NOT EXISTS "interactive_sessions_workspace_id_idx" ON "interactive_sessions" ("workspace_id");
CREATE INDEX IF NOT EXISTS "schedules_workspace_id_idx" ON "schedules" ("workspace_id");
CREATE INDEX IF NOT EXISTS "task_templates_workspace_id_idx" ON "task_templates" ("workspace_id");
CREATE INDEX IF NOT EXISTS "prompt_templates_workspace_id_idx" ON "prompt_templates" ("workspace_id");
