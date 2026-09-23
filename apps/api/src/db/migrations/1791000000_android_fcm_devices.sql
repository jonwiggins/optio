-- Android push (docs/android-push.md): FCM registration tokens for the Android
-- app, mirroring apns_devices. Watch frames and needs-you alerts go to every
-- row of the user (Android has no per-activity tokens). `client_server_id` is
-- the app's own id for this server, echoed in each message for routing.

CREATE TABLE "fcm_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid,
	"token" text NOT NULL,
	"app_id" text NOT NULL,
	"app_version" text,
	"device_name" text,
	"client_server_id" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fcm_devices_token_key" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "fcm_devices" ADD CONSTRAINT "fcm_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "fcm_devices_user_id_idx" ON "fcm_devices" USING btree ("user_id");
