-- Chat notifications (docs/notifications.md "Chat services"): a body format
-- for outbound webhooks and a person's own chat hook. Additive: one new
-- table and one nullable column.

-- An outbound webhook's body: generic or discord, googlechat, mattermost,
-- msteams, rocketchat, slack, webex, zulip. Null keeps the existing rule
-- (Slack blocks for a hooks.slack.com URL, the generic JSON otherwise).
ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "format" text;

-- A person's own chat incoming webhook, one per person. The URL is a
-- credential: sealed (AES-256-GCM, AAD `notify_chat_hook|<id>`), shown only
-- as `url_hint`.
CREATE TABLE IF NOT EXISTS "notify_chat_hooks" (
  "id" uuid PRIMARY KEY,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "format" text NOT NULL,
  "encrypted_url" bytea NOT NULL,
  "url_iv" bytea NOT NULL,
  "url_auth_tag" bytea NOT NULL,
  "url_hint" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "last_sent_at" timestamptz,
  "last_error" text,
  "last_error_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "notify_chat_hooks_owner_key"
  ON "notify_chat_hooks" ("owner_user_id");
