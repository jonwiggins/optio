-- iOS glanceable surfaces (docs/design/ios-glanceable-architecture.md §3):
-- APNs device tokens, ActivityKit update / push-to-start tokens for the
-- per-user "Watch" Live Activity, and a server-side "Later" snooze on local
-- terminals so the needs-you queue is consistent across web, push and widgets.

CREATE TYPE "public"."apns_environment" AS ENUM('sandbox', 'production');
--> statement-breakpoint
CREATE TABLE "apns_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid,
	"token" text NOT NULL,
	"platform" text DEFAULT 'ios' NOT NULL,
	"environment" "apns_environment" DEFAULT 'sandbox' NOT NULL,
	"bundle_id" text NOT NULL,
	"app_version" text,
	"device_name" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apns_devices_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "live_activity_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'watch' NOT NULL,
	"subject_id" text,
	"token" text NOT NULL,
	"environment" "apns_environment" DEFAULT 'sandbox' NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_activity_tokens_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "live_activity_start_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'watch' NOT NULL,
	"token" text NOT NULL,
	"environment" "apns_environment" DEFAULT 'sandbox' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_activity_start_tokens_token_key" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "apns_devices" ADD CONSTRAINT "apns_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "live_activity_tokens" ADD CONSTRAINT "live_activity_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "live_activity_start_tokens" ADD CONSTRAINT "live_activity_start_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "apns_devices_user_id_idx" ON "apns_devices" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "live_activity_tokens_user_kind_idx" ON "live_activity_tokens" USING btree ("user_id","kind");
--> statement-breakpoint
CREATE INDEX "live_activity_start_tokens_user_kind_idx" ON "live_activity_start_tokens" USING btree ("user_id","kind");
--> statement-breakpoint
ALTER TABLE "local_terminals" ADD COLUMN "snoozed_until" timestamp with time zone;
