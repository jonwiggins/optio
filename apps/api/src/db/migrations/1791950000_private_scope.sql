-- Private scope for MCP servers, skills and prompts: `owner_user_id` null =
-- the organization's (everyone in the workspace sees it); set = one person's
-- own (visible to them alone, read-only to workspace admins). The same rule
-- connections, model providers, secrets and work already follow — see
-- services/ownership.ts and docs/plans/org-scoping-and-sso.md.
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_owner_user_id_idx" ON "mcp_servers" ("owner_user_id");
--> statement-breakpoint
ALTER TABLE "custom_skills" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_skills_owner_user_id_idx" ON "custom_skills" ("owner_user_id");
--> statement-breakpoint
ALTER TABLE "installed_skills" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "installed_skills_owner_user_id_idx" ON "installed_skills" ("owner_user_id");
--> statement-breakpoint
ALTER TABLE "prompt_templates" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_templates_owner_user_id_idx" ON "prompt_templates" ("owner_user_id");
--> statement-breakpoint
-- A prompt's name is unique within its scope — the organization's in one
-- workspace, or one person's — not across the whole instance, so two people
-- can each have a private "Daily digest".
ALTER TABLE "prompt_templates" DROP CONSTRAINT IF EXISTS "prompt_templates_name_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_templates_scope_name_key" ON "prompt_templates" (
  COALESCE("workspace_id", '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE("owner_user_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "name"
);
