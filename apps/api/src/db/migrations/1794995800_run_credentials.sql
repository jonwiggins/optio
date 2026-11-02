-- Which credentials each run was given: identities and a keyed fingerprint,
-- never values (services/run-credentials.ts).
CREATE TABLE IF NOT EXISTS "run_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_kind" text NOT NULL,
	"run_id" uuid NOT NULL,
	"workspace_id" uuid,
	"user_id" uuid,
	"repo_url" text,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"name" text NOT NULL,
	"credential_id" uuid,
	"host" text,
	"fingerprint" text,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_credentials_fingerprint_idx" ON "run_credentials" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_credentials_credential_id_idx" ON "run_credentials" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_credentials_name_idx" ON "run_credentials" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_credentials_used_at_idx" ON "run_credentials" USING btree ("used_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_credentials_run_idx" ON "run_credentials" USING btree ("run_kind","run_id");
