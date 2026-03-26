-- MCP Servers table
CREATE TABLE IF NOT EXISTS "mcp_servers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "command" text NOT NULL,
  "args" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "env" jsonb,
  "install_command" text,
  "scope" text NOT NULL DEFAULT 'global',
  "repo_url" text,
  "workspace_id" uuid,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_scope_idx" ON "mcp_servers" USING btree ("scope");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_repo_url_idx" ON "mcp_servers" USING btree ("repo_url");
--> statement-breakpoint

-- Custom Skills table
CREATE TABLE IF NOT EXISTS "custom_skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "prompt" text NOT NULL,
  "scope" text NOT NULL DEFAULT 'global',
  "repo_url" text,
  "workspace_id" uuid,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_skills_scope_idx" ON "custom_skills" USING btree ("scope");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_skills_repo_url_idx" ON "custom_skills" USING btree ("repo_url");
