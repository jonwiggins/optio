-- Task templates: save and reuse task configurations
CREATE TABLE IF NOT EXISTS "task_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "repo_url" text,
  "prompt" text NOT NULL,
  "agent_type" text DEFAULT 'claude-code' NOT NULL,
  "priority" integer DEFAULT 100 NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
