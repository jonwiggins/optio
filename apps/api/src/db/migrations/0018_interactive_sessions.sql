-- Interactive sessions: persistent interactive workspaces scoped to repo pods
DO $$ BEGIN
  CREATE TYPE "interactive_session_state" AS ENUM('active', 'ended');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "interactive_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_url" text NOT NULL,
	"user_id" uuid,
	"worktree_path" text,
	"branch" text NOT NULL,
	"state" "interactive_session_state" DEFAULT 'active' NOT NULL,
	"pod_id" uuid,
	"cost_usd" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "interactive_sessions_repo_url_idx" ON "interactive_sessions" ("repo_url");
CREATE INDEX IF NOT EXISTS "interactive_sessions_state_idx" ON "interactive_sessions" ("state");
CREATE INDEX IF NOT EXISTS "interactive_sessions_user_id_idx" ON "interactive_sessions" ("user_id");

CREATE TABLE IF NOT EXISTS "session_prs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL REFERENCES "interactive_sessions"("id") ON DELETE CASCADE,
	"pr_url" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_state" text,
	"pr_checks_status" text,
	"pr_review_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "session_prs_session_id_idx" ON "session_prs" ("session_id");
