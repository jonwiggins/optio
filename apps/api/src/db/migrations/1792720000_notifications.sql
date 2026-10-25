-- Notifications inside the network (docs/notifications.md): email through
-- the deployment's SMTP relay, a chat format on outbound webhooks, and per-person
-- choices of which events reach which channel. Additive: one new table and
-- two nullable columns.

-- The relay Optio sends email through, set by a deployment admin under
-- Settings → Notifications (it wins over OPTIO_SMTP_URL). One row at most.
-- The password is sealed on the row (AES-256-GCM, AAD `notify_smtp|default`)
-- and never returned.
CREATE TABLE IF NOT EXISTS "notify_smtp_settings" (
  "id" text PRIMARY KEY DEFAULT 'default',
  "host" text NOT NULL,
  "port" integer NOT NULL,
  "security" text NOT NULL DEFAULT 'starttls',
  "username" text,
  "encrypted_password" bytea,
  "password_iv" bytea,
  "password_auth_tag" bytea,
  "from_address" text NOT NULL,
  "ca_pem" text,
  "insecure_skip_verify" boolean NOT NULL DEFAULT false,
  "enabled" boolean NOT NULL DEFAULT true,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notify_smtp_settings_singleton" CHECK ("id" = 'default')
);

-- A person's channels per event, beside upstream's `preferences` (push per
-- event), which its PUT replaces key by key: `{ "email": { "<kind>": bool },
-- "teamWork": bool }`. Null = the defaults.
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "channels" jsonb;

-- How an outbound webhook's body is shaped: generic (Optio's JSON), slack,
-- mattermost or msteams. Null keeps upstream's rule (Slack blocks for a
-- hooks.slack.com URL, the generic JSON otherwise).
ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "format" text;
