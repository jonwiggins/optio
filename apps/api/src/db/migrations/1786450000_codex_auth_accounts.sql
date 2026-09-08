CREATE TYPE "codex_auth_account_status" AS ENUM ('pending', 'connected', 'error');

CREATE TABLE "codex_auth_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid,
  "name" text DEFAULT 'default' NOT NULL,
  "app_server_url" text NOT NULL,
  "status" "codex_auth_account_status" DEFAULT 'pending' NOT NULL,
  "login_session_id" uuid,
  "login_session_repo_url" text,
  "created_by" uuid,
  "last_imported_at" timestamp with time zone,
  "last_validated_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "codex_auth_accounts_workspace_name_key" UNIQUE("workspace_id","name")
);

ALTER TABLE "codex_auth_accounts"
  ADD CONSTRAINT "codex_auth_accounts_login_session_id_interactive_sessions_id_fk"
  FOREIGN KEY ("login_session_id") REFERENCES "public"."interactive_sessions"("id")
  ON DELETE set null ON UPDATE no action;

ALTER TABLE "codex_auth_accounts"
  ADD CONSTRAINT "codex_auth_accounts_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;

CREATE INDEX "codex_auth_accounts_workspace_idx" ON "codex_auth_accounts" USING btree ("workspace_id");
