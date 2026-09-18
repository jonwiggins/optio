-- Optio Local: terminals on a user's own machine, managed via the CLI daemon
-- (`optio local up`). See docs/optio-local.md.
--
--   local_hosts      — paired machines (per-user, never workspace compute)
--   local_terminals  — PTY sessions with a state machine + attention state
--   local_blueprints — reusable terminal specs spawned by workflow_triggers
--                      (target_type = 'local_blueprint')

CREATE TYPE "public"."local_host_state" AS ENUM('online', 'offline');--> statement-breakpoint
CREATE TYPE "public"."local_terminal_state" AS ENUM('pending', 'launching', 'running', 'exited', 'error');--> statement-breakpoint
CREATE TYPE "public"."local_attention_state" AS ENUM('working', 'needs_you', 'idle');--> statement-breakpoint
CREATE TABLE "local_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"hostname" text NOT NULL,
	"platform" text NOT NULL,
	"arch" text,
	"daemon_version" text,
	"dirs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" "local_host_state" DEFAULT 'offline' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_hosts_user_hostname_key" UNIQUE("user_id","hostname")
);--> statement-breakpoint
CREATE TABLE "local_terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"user_id" uuid,
	"workspace_id" uuid,
	"title" text NOT NULL,
	"dir" text NOT NULL,
	"command" text,
	"spec" jsonb NOT NULL,
	"state" "local_terminal_state" DEFAULT 'pending' NOT NULL,
	"pending_reason" text,
	"exit_code" integer,
	"error_message" text,
	"attention_state" "local_attention_state" DEFAULT 'idle' NOT NULL,
	"attention_reason" text,
	"spawned_by" text DEFAULT 'manual' NOT NULL,
	"blueprint_id" uuid,
	"trigger_id" uuid,
	"ticket_source" text,
	"ticket_external_id" text,
	"ticket_url" text,
	"preview" text,
	"cost_usd" text,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "local_blueprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"host_id" uuid,
	"dir" text,
	"repo_url" text,
	"command_template" text NOT NULL,
	"spawn_mode" text DEFAULT 'auto' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_blueprints_user_name_key" UNIQUE("user_id","name")
);--> statement-breakpoint
ALTER TABLE "local_hosts" ADD CONSTRAINT "local_hosts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_terminals" ADD CONSTRAINT "local_terminals_host_id_local_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."local_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_terminals" ADD CONSTRAINT "local_terminals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_blueprints" ADD CONSTRAINT "local_blueprints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_blueprints" ADD CONSTRAINT "local_blueprints_host_id_local_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."local_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_hosts_user_id_idx" ON "local_hosts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "local_terminals_host_id_idx" ON "local_terminals" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "local_terminals_user_state_idx" ON "local_terminals" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "local_terminals_created_at_idx" ON "local_terminals" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "local_blueprints_user_id_idx" ON "local_blueprints" USING btree ("user_id");
